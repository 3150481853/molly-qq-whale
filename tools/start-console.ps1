#Requires -Version 5.1
<#
  start-console.ps1 —— Molly 控制台（127.0.0.1:19392）启动器 / 体检

  用法：
    .\start-console.ps1              确保服务在跑（没跑就后台拉起）+ 体检表 + 打开独立窗口
    .\start-console.ps1 -Status      只体检：不启动、不停止、不开窗
    .\start-console.ps1 -Stop        停掉控制台（只认命令行含 console-server.mjs 的进程，不按端口盲杀）
    .\start-console.ps1 -Restart     先停再起
    .\start-console.ps1 -NoOpen      只确保服务在跑 + 打印体检表，不打开窗口

  窗口：Edge --app（无地址栏）→ 找不到 Edge 用 Chrome → 都没有用默认浏览器。
  双击入口是 console.cmd，它调本脚本，窗口由本脚本负责打开。

  铁律：
    - 只操作 19392 端口上「命令行含 console-server.mjs」的进程；端口被别的程序占着就只报告、不动手
    - 绝不碰 19391（数据服务）/ 7053（DSH 宿主）/ QQ / NapCat
    - 本文件必须存成 UTF-8 带 BOM，否则 Windows PowerShell 5.1 会把中文读成乱码
#>

param(
  [switch]$Status,
  [switch]$Stop,
  [switch]$Restart,
  [switch]$NoOpen
)

$ErrorActionPreference = 'Continue'
$ProgressPreference    = 'SilentlyContinue'

# 输出被重定向（管道 / 脚本捕获）时改用 UTF-8，避免中文在捕获端显示成乱码
if ([Console]::IsOutputRedirected) {
  try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
}

# ── 常量 ────────────────────────────────────────────────────────────────────
$ScriptDir = $PSScriptRoot
if (-not $ScriptDir) { $ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not $ScriptDir) { $ScriptDir = (Get-Location).Path }

$ToolsDir = $ScriptDir
$Root     = Split-Path -Parent $ToolsDir
$ServerJs = Join-Path $ToolsDir 'console-server.mjs'
$OutDir   = Join-Path $Root 'out'
$LogOut   = Join-Path $OutDir 'console.log'
$LogErr   = Join-Path $OutDir 'console.log.err'

$NodeExe  = '${HOME}\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
$TaskName = 'Molly-Watchdog'

$Port = 19392
$Base = "http://127.0.0.1:$Port"

$WaitMs = 8000      # 拉起后最多等多久（毫秒）
$PollMs = 200       # 轮询间隔（毫秒）

$script:AllGood = $true

# ── 显示宽度对齐（中文占 2 列，PadRight 按字符数会错位）────────────────────
function Get-DisplayWidth([string]$s) {
  $w = 0
  foreach ($ch in $s.ToCharArray()) {
    if ([int]$ch -gt 0x2E80 -or [int]$ch -eq 0x2192) { $w += 2 } else { $w += 1 }
  }
  return $w
}

function PadW([string]$s, [int]$width) {
  $need = $width - (Get-DisplayWidth $s)
  if ($need -lt 1) { $need = 1 }
  return $s + (' ' * $need)
}

function Row([string]$label, [string]$value, [string]$verdict, [string]$color) {
  Write-Host ((PadW $label 20) + (PadW $value 34)) -ForegroundColor DarkGray -NoNewline
  Write-Host ("→ " + $verdict) -ForegroundColor $color
}

function Mark([string]$color) {
  if ($color -eq 'Green') { return $script:AllGood }
  $script:AllGood = $false
  return $false
}

# ── 进程 / 端口 ─────────────────────────────────────────────────────────────
function Get-ListeningPids([int]$p) {
  try {
    $c = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction Stop
    if (-not $c) { return @() }
    return @($c | Select-Object -ExpandProperty OwningProcess -Unique)
  } catch {
    return @()
  }
}

function Get-ProcCmdline([int]$procId) {
  try {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -ErrorAction Stop
    if ($p) { return [string]$p.CommandLine }
  } catch { }
  return ''
}

# ── HTTP ────────────────────────────────────────────────────────────────────
function Test-Health([int]$timeoutSec = 2) {
  try {
    $r = Invoke-WebRequest -Uri "$Base/api/health" -UseBasicParsing -TimeoutSec $timeoutSec -ErrorAction Stop
    if ($r.StatusCode -eq 200) {
      try {
        $j = $r.Content | ConvertFrom-Json
        if ($j) { return $j }
      } catch { }
      return [pscustomobject]@{ ok = $true; version = '?'; at = 0 }
    }
  } catch { }
  return $null
}

function Get-Overview {
  try {
    $r = Invoke-WebRequest -Uri "$Base/api/overview" -UseBasicParsing -TimeoutSec 10 -ErrorAction Stop
    if ($r.StatusCode -eq 200) { return ($r.Content | ConvertFrom-Json) }
  } catch { }
  return $null
}

function Wait-Health([int]$maxMs) {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  while ($sw.ElapsedMilliseconds -lt $maxMs) {
    $h = Test-Health 2
    if ($h -and $h.ok) { return [int]$sw.ElapsedMilliseconds }
    Start-Sleep -Milliseconds $PollMs
  }
  return -1
}

function Show-LogTail {
  foreach ($f in @($LogErr, $LogOut)) {
    if (-not (Test-Path $f)) { continue }
    try {
      $lines = [System.IO.File]::ReadAllLines($f, [System.Text.Encoding]::UTF8)
      if ($lines -and $lines.Count -gt 0) {
        Write-Host ("  --- " + [System.IO.Path]::GetFileName($f) + " 末尾 ---") -ForegroundColor DarkGray
        $lines | Select-Object -Last 12 | ForEach-Object { Write-Host ("  " + $_) -ForegroundColor DarkYellow }
      }
    } catch {
      Write-Host ("  （" + [System.IO.Path]::GetFileName($f) + " 读不出来：" + $_.Exception.Message + "）") -ForegroundColor DarkGray
    }
  }
}

# ── 停止 / 启动 ─────────────────────────────────────────────────────────────
function Stop-Console {
  $pids = @(Get-ListeningPids $Port)
  if ($pids.Count -eq 0) { return 0 }

  $killed = 0
  foreach ($procId in $pids) {
    $cmd = Get-ProcCmdline $procId
    if ($cmd -match 'console-server\.mjs') {
      Write-Host ("停止控制台进程 pid=" + $procId + " ...") -ForegroundColor Yellow
      try {
        Stop-Process -Id $procId -Force -ErrorAction Stop
        $killed++
      } catch {
        Write-Host ("  停止失败：" + $_.Exception.Message) -ForegroundColor Red
      }
    } else {
      Write-Host ("端口 " + $Port + " 被 pid=" + $procId + " 占用，但命令行不含 console-server.mjs —— 不动它。") -ForegroundColor Red
      if ($cmd) { Write-Host ("  命令行：" + $cmd) -ForegroundColor DarkGray }
    }
  }
  return $killed
}

function Start-Console {
  if (-not (Test-Path $NodeExe)) {
    Write-Host ("找不到 node 运行时：" + $NodeExe) -ForegroundColor Red
    Write-Host '请检查 DSH 运行时目录是否被移动过。' -ForegroundColor DarkGray
    return $null
  }
  if (-not (Test-Path $ServerJs)) {
    Write-Host ("找不到服务端脚本：" + $ServerJs) -ForegroundColor Red
    return $null
  }
  if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }

  $argLine = '"' + $ServerJs + '"'
  Write-Host ("拉起：" + $NodeExe) -ForegroundColor DarkGray
  Write-Host ("       " + $ServerJs) -ForegroundColor DarkGray

  try {
    $proc = Start-Process -FilePath $NodeExe `
                          -ArgumentList $argLine `
                          -WindowStyle Hidden `
                          -RedirectStandardOutput $LogOut `
                          -RedirectStandardError  $LogErr `
                          -PassThru -ErrorAction Stop
    return $proc
  } catch {
    Write-Host ("启动失败：" + $_.Exception.Message) -ForegroundColor Red
    return $null
  }
}

# ── 浏览器窗口（Edge --app 无地址栏；找不到 Edge 退 Chrome；都没有就用默认浏览器）──
function Find-Browser {
  $cands = @()

  # 先 PATH（Get-Command 找不到会抛，包住）
  foreach ($name in @('msedge.exe', 'chrome.exe')) {
    try {
      $c = Get-Command $name -ErrorAction Stop
      if ($c -and $c.Source) { $cands += $c.Source }
    } catch { }
  }

  $edgeDirs = @()
  if ($env:ProgramFiles)          { $edgeDirs += (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application') }
  if (${env:ProgramFiles(x86)})   { $edgeDirs += (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application') }
  if ($env:LOCALAPPDATA)          { $edgeDirs += (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\Application') }
  foreach ($d in $edgeDirs) { $cands += (Join-Path $d 'msedge.exe') }

  $chromeDirs = @()
  if ($env:ProgramFiles)          { $chromeDirs += (Join-Path $env:ProgramFiles 'Google\Chrome\Application') }
  if (${env:ProgramFiles(x86)})   { $chromeDirs += (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application') }
  if ($env:LOCALAPPDATA)          { $chromeDirs += (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application') }
  foreach ($d in $chromeDirs) { $cands += (Join-Path $d 'chrome.exe') }

  foreach ($c in $cands) {
    if ($c -and (Test-Path $c)) { return $c }
  }
  return $null
}

function Open-ConsoleWindow {
  $browser = Find-Browser
  if ($browser) {
    $appUrl = "$Base/"
    Write-Host ("打开独立窗口：" + $browser) -ForegroundColor DarkGray
    try {
      Start-Process -FilePath $browser `
                    -ArgumentList @("--app=$appUrl", '--window-size=1280,860', '--window-position=120,80') `
                    -ErrorAction Stop | Out-Null
      return $true
    } catch {
      Write-Host ("  --app 方式打开失败：" + $_.Exception.Message) -ForegroundColor Yellow
      Write-Host '  改用默认浏览器打开 ...' -ForegroundColor DarkGray
    }
  } else {
    Write-Host '没找到 Edge / Chrome，改用默认浏览器打开（会有地址栏）。' -ForegroundColor Yellow
  }

  try {
    Start-Process "$Base/" -ErrorAction Stop | Out-Null
    return $true
  } catch {
    Write-Host ("连默认浏览器都打不开：" + $_.Exception.Message) -ForegroundColor Red
    Write-Host ("请手动在浏览器里打开 " + $Base + "/") -ForegroundColor DarkGray
    return $false
  }
}

# ── 体检表 ──────────────────────────────────────────────────────────────────
function Show-Report {
  $now = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'

  Write-Host ''
  Write-Host '════════════════ Molly 控制台 · 体检表 ════════════════' -ForegroundColor White
  Write-Host ("时间  " + $now) -ForegroundColor DarkGray
  Write-Host '──────────────────────────────────────────────────────' -ForegroundColor DarkGray

  # 1) 端口
  $pids = @(Get-ListeningPids $Port)
  if ($pids.Count -gt 0) {
    Row '[控制台端口]' ("127.0.0.1:" + $Port) ("监听中（pid " + ($pids -join ', ') + "）") 'Green'
  } else {
    Row '[控制台端口]' ("127.0.0.1:" + $Port) '未监听' 'Red' | Out-Null
    Mark 'Red' | Out-Null
  }

  # 2) HTTP 状态
  $h = Test-Health 3
  $ov = $null
  if ($h -and $h.ok) {
    Row '[HTTP 状态]' '/api/health' ("200 ok（v" + $h.version + "）") 'Green'
    $ov = Get-Overview
  } else {
    Row '[HTTP 状态]' '/api/health' '不可达' 'Red'
    Mark 'Red' | Out-Null
  }

  # 3) 宿主端口（overview.plugin.base）
  if ($ov -and $ov.plugin -and $ov.plugin.base) {
    Row '[宿主端口]' ([string]$ov.plugin.base) '已探到（DSH 宿主）' 'Green'
  } elseif ($ov) {
    Row '[宿主端口]' '(未探到)' '宿主可能没起来' 'Yellow'
    Mark 'Yellow' | Out-Null
  } else {
    Row '[宿主端口]' '-' '控制台不可达，跳过' 'DarkGray'
  }

  # 4) Molly / QQ 在线状态
  if ($ov) {
    $linkState = $null
    if ($ov.plugin -and $ov.plugin.link) { $linkState = [string]$ov.plugin.link.state }

    $np = $ov.napcat
    if ($np -and $np.reachable) {
      $phase = ''
      if ($np.loginPhase) { $phase = "（" + $np.loginPhase + "）" }
      if ($np.isLogin) {
        Row '[QQ 登录]' ("napcat.isLogin=" + $np.isLogin) ("在线" + $phase) 'Green'
      } else {
        Row '[QQ 登录]' ("napcat.isLogin=" + $np.isLogin) ("未登录" + $phase) 'Red'
        Mark 'Red' | Out-Null
      }
    } elseif ($linkState) {
      if ($linkState -eq 'online') {
        Row '[QQ 登录]' ("plugin.link.state=" + $linkState) '在线（NapCat 接口不可达，按宿主状态推断）' 'Yellow'
        Mark 'Yellow' | Out-Null
      } else {
        Row '[QQ 登录]' ("plugin.link.state=" + $linkState) '不在线' 'Red'
        Mark 'Red' | Out-Null
      }
    } else {
      Row '[QQ 登录]' '-' '无数据' 'Yellow'
      Mark 'Yellow' | Out-Null
    }

    if ($ov.plugin -and $ov.plugin.bot -and $ov.plugin.bot.nickname) {
      Row '[机器人]' ([string]$ov.plugin.bot.nickname) ("user_id=" + $ov.plugin.bot.userId) 'Gray'
    }
  } else {
    Row '[QQ 登录]' '-' '控制台不可达，跳过' 'DarkGray'
  }

  # 5) watchdog 计划任务（系统里真实的任务状态）
  $taskState = 'UNKNOWN'
  try {
    $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($t) { $taskState = [string]$t.State } else { $taskState = 'MISSING' }
  } catch {
    $taskState = 'UNKNOWN'
  }

  $wdExtra = ''
  if ($ov -and $ov.watchdog) {
    $wd = $ov.watchdog
    if ($wd.state -and $wd.state.lastState) { $wdExtra += "上次=" + $wd.state.lastState + " " }
    if ($wd.lastRun) { $wdExtra += "上次运行=" + $wd.lastRun }
  }

  switch ($taskState) {
    'Ready'    { Row '[Watchdog 任务]' $TaskName ("$taskState（已启用）" + $wdExtra) 'Green' }
    'Running'  { Row '[Watchdog 任务]' $TaskName ("$taskState（正在跑）" + $wdExtra) 'Green' }
    'Queued'   { Row '[Watchdog 任务]' $TaskName ("$taskState（排队中）" + $wdExtra) 'Green' }
    'Disabled' { Row '[Watchdog 任务]' $TaskName ("$taskState（已禁用）" + $wdExtra) 'Yellow'; Mark 'Yellow' | Out-Null }
    'MISSING'  { Row '[Watchdog 任务]' $TaskName '没有注册这个计划任务' 'Yellow'; Mark 'Yellow' | Out-Null }
    default    { Row '[Watchdog 任务]' $TaskName ($taskState + $wdExtra) 'Yellow'; Mark 'Yellow' | Out-Null }
  }

  Write-Host '──────────────────────────────────────────────────────' -ForegroundColor DarkGray
  if ($script:AllGood) {
    Write-Host '结论：全部正常。' -ForegroundColor Green
  } else {
    Write-Host '结论：有异常项（见上面的红/黄行）。' -ForegroundColor Yellow
  }
  Write-Host '══════════════════════════════════════════════════════' -ForegroundColor White
  Write-Host ''
}

# ── 主流程 ──────────────────────────────────────────────────────────────────
if ($Stop -or $Restart) {
  $n = Stop-Console
  if (-not $Restart) {
    Write-Host ''
    if ($n -gt 0) {
      Write-Host ("已停止 " + $n + " 个控制台进程。") -ForegroundColor Green
    } else {
      Write-Host ("没有正在运行的控制台（127.0.0.1:" + $Port + " 上没有 console-server.mjs）。") -ForegroundColor DarkGray
    }
    exit 0
  }
  Start-Sleep -Milliseconds 500
}

if ($Status) {
  Show-Report
  if ($script:AllGood) { exit 0 } else { exit 1 }
}

$pids = @(Get-ListeningPids $Port)
if ($pids.Count -eq 0) {
  Write-Host ''
  Write-Host ("控制台没有在运行（127.0.0.1:" + $Port + " 无监听），正在拉起 ...") -ForegroundColor Cyan
  Start-Console | Out-Null
  $ms = Wait-Health $WaitMs
  if ($ms -ge 0) {
    Write-Host ("控制台已就绪，用时 " + $ms + " ms。") -ForegroundColor Green
  } else {
    Write-Host ("控制台 " + [int]($WaitMs / 1000) + " 秒内没有起来，下面是日志末尾：") -ForegroundColor Red
    Show-LogTail
  }
} else {
  Write-Host ''
  Write-Host ("控制台已在运行（pid " + ($pids -join ', ') + "），不重复启动。") -ForegroundColor Green
}

Show-Report

if (-not $NoOpen) {
  if ($script:AllGood) {
    Open-ConsoleWindow | Out-Null
    Write-Host ''
  } else {
    Write-Host '服务不正常，先不开窗口。修好上面的问题再运行一次。' -ForegroundColor Yellow
    Write-Host ("也可以先手动打开 " + $Base + "/ 看看具体报什么错。") -ForegroundColor DarkGray
    Write-Host ''
  }
}

if ($script:AllGood) { exit 0 } else { exit 1 }
