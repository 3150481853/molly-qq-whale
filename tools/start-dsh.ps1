# start-dsh.ps1 -- 拉起 DeepSeek Harness（Molly 的大脑）
#
# 谁在用它：
#   1) 计划任务 Molly-DSH（登录后 30 秒，负责"开机自启"）
#   0) 联动拉起原生窗口 Molly.exe（dist\desktop），失败才回退无窗口后端
#   2) watchdog.mjs（每分钟巡检时的兜底：DSH 插件端点不通就调这个）
#
# 为什么单独一个脚本：Molly 由两半组成 -- NapCat/QQ（start-molly.ps1 管）
# 和 DeepSeek Harness（大脑 + 插件宿主，以前没人管）。重启后只有前者会
# 自己起来，于是 QQ 在线、Molly 却不说话。
#
# 行为：进程已在就不动（幂等）；不在才 Start-Process 拉起。
# 退出码：0 = 已在跑 / 本次拉起成功；1 = 拉起失败；2 = 找不到 exe。
#
# 注意：本文件必须带 UTF-8 BOM 保存，否则 PowerShell 5.1 读中文会乱码。

param(
  [switch]$Force,             # 先结束现有进程再重启（开发调试用，平时别开）
  [int]$WaitSeconds = 0,      # 先等 N 秒再检查（登录后让磁盘/网络就绪）
  [switch]$SkipConsole,       # 联动回滚开关：只恢复旧的 DSH 启动行为
  [string]$ConsoleExePath = '', # 留空 = <仓库>\dist\molly-console.exe
  [string]$DesktopExePath = '', # 留空 = <仓库>\dist\desktop\Molly.exe（原生窗口）
  [string]$ConsoleConfigPath = '', # 留空 = exe 同级 console.json；供隔离测试
  [int]$ConsoleWaitSeconds = 10 # 只等控制台健康，不改变 DSH 的等待时间
)

$ErrorActionPreference = 'SilentlyContinue'

$ExePath   = '${APP_DIR}\DeepSeek Harness.exe'
$ProcName  = 'DeepSeek Harness'
$OutDir    = '${MOLLY_ROOT}\qq-whale\out'
$LogFile   = Join-Path $OutDir 'start-dsh.log'
$LogMaxBytes = 512 * 1024
$RepoRoot  = Split-Path $PSScriptRoot -Parent
if (-not $ConsoleExePath) { $ConsoleExePath = Join-Path $RepoRoot 'dist\molly-console.exe' }
if (-not $DesktopExePath) { $DesktopExePath = Join-Path $RepoRoot 'dist\desktop\Molly.exe' }
if (-not $ConsoleConfigPath) { $ConsoleConfigPath = Join-Path (Split-Path $ConsoleExePath -Parent) 'console.json' }
$ConsoleOutLog = Join-Path $OutDir 'console-autostart.out.log'
$ConsoleErrLog = Join-Path $OutDir 'console-autostart.err.log'
$ConsoleState = Join-Path $OutDir 'console-autostart-state.txt'

function Write-Log([string]$msg) {
  $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  try { Add-Content -Path $LogFile -Value $line -Encoding UTF8 } catch { }
}

function Get-DshProcess {
  @(Get-Process -Name $ProcName -ErrorAction SilentlyContinue)
}

function Test-Elevated {
  try {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    (New-Object Security.Principal.WindowsPrincipal $id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  } catch { $false }
}

if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }

# 日志滚动：超过 512KB 就留一份 .1
if ((Test-Path $LogFile) -and ((Get-Item $LogFile).Length -gt $LogMaxBytes)) {
  Move-Item -Path $LogFile -Destination ($LogFile + '.1') -Force
}

function Get-ConsoleConfig {
  $cfg = @{ host = '127.0.0.1'; port = 19392; token = '' }
  try {
    $raw = Get-Content -LiteralPath $ConsoleConfigPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    if ($raw.host) { $cfg.host = [string]$raw.host }
    if ($raw.port) { $cfg.port = [int]$raw.port }
    if ($raw.token) { $cfg.token = [string]$raw.token }
  } catch {
    if (Test-Path -LiteralPath $ConsoleConfigPath) { Write-Log ('控制台配置读取失败（使用默认值）：' + $_.Exception.Message) }
  }
  if ($env:MOLLY_CONSOLE_HOST) { $cfg.host = $env:MOLLY_CONSOLE_HOST }
  if ($env:MOLLY_CONSOLE_PORT) { $cfg.port = [int]$env:MOLLY_CONSOLE_PORT }
  if ($env:MOLLY_CONSOLE_TOKEN) { $cfg.token = $env:MOLLY_CONSOLE_TOKEN }
  return $cfg
}

function Test-ConsoleHealth($cfg) {
  # 与 console-server 的 probeExistingConsole 同一契约：200 + ok:true + version。
  # 不能像旧 start-console.ps1 那样只看监听端口，否则会把无关程序当成 Molly。
  $hostName = [string]$cfg.host
  if ($hostName -eq '0.0.0.0' -or $hostName -eq '::' -or -not $hostName) { $hostName = '127.0.0.1' }
  $headers = @{}
  if ($cfg.token) { $headers['x-molly-token'] = [string]$cfg.token }
  try {
    $r = Invoke-RestMethod -Uri ('http://{0}:{1}/api/health' -f $hostName, $cfg.port) -Headers $headers -TimeoutSec 2 -ErrorAction Stop
    return ($r.ok -eq $true -and -not [string]::IsNullOrWhiteSpace([string]$r.version))
  } catch { return $false }
}

function Start-MollyDesktop {
  param($cfg)
  if ($SkipConsole) { Write-Log '原生窗口：-SkipConsole，跳过'; return $false }
  $existing = @(Get-Process -Name 'Molly' -ErrorAction SilentlyContinue)
  if ($existing.Count -gt 0) {
    Write-Log ('原生窗口：已在运行（{0} 个），跳过' -f $existing.Count)
    return (Test-ConsoleHealth $cfg)
  }
  if (-not (Test-Path -LiteralPath $DesktopExePath -PathType Leaf)) {
    Write-Log ('原生窗口：找不到 EXE，回退无窗口后端：' + $DesktopExePath)
    return $false
  }

  try {
    $proc = $null
    if (Test-Elevated) {
      # 从管理员计划任务直启会让窗口进程提权；交给 explorer 以当前用户身份打开。
      Start-Process -FilePath 'explorer.exe' -ArgumentList ('"' + $DesktopExePath + '"')
      Write-Log '原生窗口：经由 explorer 以普通用户身份拉起'
    } else {
      $proc = Start-Process -FilePath $DesktopExePath -WorkingDirectory (Split-Path $DesktopExePath -Parent) -PassThru -ErrorAction Stop
      Write-Log ('原生窗口：已拉起 pid={0}' -f $proc.Id)
    }
    for ($i = 0; $i -lt [Math]::Max(3, $ConsoleWaitSeconds); $i++) {
      Start-Sleep -Seconds 1
      if (Test-ConsoleHealth $cfg) { Write-Log '原生窗口：后端健康检查通过'; return $true }
      if ($proc -and $proc.HasExited) { Write-Log ('原生窗口：进程退出 code={0}' -f $proc.ExitCode); return $false }
    }
    Write-Log '原生窗口：等待后端健康超时，回退无窗口后端'
    return $false
  } catch {
    Write-Log ('原生窗口：Start-Process 失败：' + $_.Exception.Message)
    return $false
  }
}

function Start-MollyConsole {
  if ($SkipConsole) { Write-Log '控制台联动：-SkipConsole，跳过'; return }
  $cfg = Get-ConsoleConfig
  if (Test-ConsoleHealth $cfg) { Write-Log '控制台联动：健康实例已存在，跳过（不开新窗口）'; return }
  if (-not (Test-Path -LiteralPath $ConsoleExePath -PathType Leaf)) {
    Write-Log ('控制台联动：找不到 EXE（不影响 DSH）：' + $ConsoleExePath); return
  }

  # 短临界区只负责串行化启动；不在持锁时做 HTTP 等待，避免坏实例永久挡住 DSH。
  $mutex = New-Object System.Threading.Mutex($false, 'Local\MollyConsoleAutostart')
  $locked = $false
  try {
    try { $locked = $mutex.WaitOne(3000) } catch [System.Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { Write-Log '控制台联动：另一个启动检查进行中，跳过'; return }
    if (Test-ConsoleHealth $cfg) { Write-Log '控制台联动：等待期间已健康，跳过'; return }

    $stdout = '{0}.{1}.out.log' -f $ConsoleOutLog, [guid]::NewGuid().ToString('N')
    $stderr = '{0}.{1}.err.log' -f $ConsoleErrLog, [guid]::NewGuid().ToString('N')
    try {
      $p = Start-Process -FilePath $ConsoleExePath -ArgumentList '--no-browser' -WorkingDirectory (Split-Path $ConsoleExePath -Parent) `
        -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru -ErrorAction Stop
      Write-Log ('控制台联动：已拉起 pid={0}；stdout={1}；stderr={2}' -f $p.Id, $stdout, $stderr)
      Set-Content -LiteralPath $ConsoleState -Value ("pid={0}`r`nstdout={1}`r`nstderr={2}" -f $p.Id, $stdout, $stderr) -Encoding UTF8
      for ($i = 0; $i -lt [Math]::Max(1, $ConsoleWaitSeconds); $i++) {
        Start-Sleep -Seconds 1
        if (Test-ConsoleHealth $cfg) { Write-Log ('控制台联动：健康检查通过（pid={0}）' -f $p.Id); return }
        if ($p.HasExited) { Write-Log ('控制台联动：进程退出 code={0}，详见独立错误日志' -f $p.ExitCode); return }
      }
      Write-Log ('控制台联动：{0} 秒内未通过健康检查，保留进程供诊断（不自动重启）' -f $ConsoleWaitSeconds)
    } catch {
      Write-Log ('控制台联动：Start-Process 失败（不影响 DSH）：' + $_.Exception.Message)
    }
  } finally {
    if ($locked) { try { $mutex.ReleaseMutex() } catch {} }
    $mutex.Dispose()
  }
}

if ($WaitSeconds -gt 0) { Start-Sleep -Seconds $WaitSeconds }

Write-Log '--- 启动检查 ---'
# 控制台是独立旁路：其失败只记日志，永不改变原有 DSH 退出码；也不要直接双击
# exe 做幂等检查，因为“已有健康实例”时旧 exe 会主动开浏览器窗口。
$consoleCfg = Get-ConsoleConfig
$desktopReady = Start-MollyDesktop $consoleCfg
if (-not $desktopReady) { Start-MollyConsole }

$procs = Get-DshProcess
if ($procs.Count -gt 0 -and -not $Force) {
  Write-Log ('已在运行（{0} 个进程：{1}），跳过' -f $procs.Count, (($procs | ForEach-Object { $_.Id }) -join ','))
  exit 0
}

if ($Force -and $procs.Count -gt 0) {
  Write-Log ('-Force：先结束 {0} 个进程' -f $procs.Count)
  $procs | Stop-Process -Force
  Start-Sleep -Seconds 3
}

if (-not (Test-Path $ExePath)) {
  Write-Log ('找不到程序：' + $ExePath)
  exit 2
}

Write-Log ('拉起：' + $ExePath)
try {
  if ((Test-Elevated) -and (@(Get-Process explorer -ErrorAction SilentlyContinue).Count -gt 0)) {
    # 从"以管理员运行"的计划任务里直接 Start-Process，Molly 会变成提升权限的进程，
    # 和用户自己双击启动时行为不一致（拖拽、输入法、开机自启的交互都会变）。
    # 借 explorer 转一手，让她回到普通权限，跟手动启动完全一样。
    Write-Log '当前是提升权限，改用 explorer 以普通权限拉起'
    Start-Process -FilePath 'explorer.exe' -ArgumentList ('"' + $ExePath + '"')
  } else {
    Start-Process -FilePath $ExePath -WorkingDirectory (Split-Path $ExePath -Parent)
  }
} catch {
  Write-Log ('Start-Process 失败：' + $_.Exception.Message)
  exit 1
}

# 最多等 30 秒，看进程是否真的起来了
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Seconds 1
  if ((Get-DshProcess).Count -gt 0) { break }
}

$after = Get-DshProcess
if ($after.Count -gt 0) {
  Write-Log ('已启动：{0} 个进程（{1}）' -f $after.Count, (($after | ForEach-Object { $_.Id }) -join ','))
  exit 0
}

Write-Log '启动失败：进程没出现'
exit 1
