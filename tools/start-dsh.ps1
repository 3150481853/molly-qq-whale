# start-dsh.ps1 -- 拉起 DeepSeek Harness（Molly 的大脑）
#
# 谁在用它：
#   1) 计划任务 Molly-DSH（登录后 30 秒，负责"开机自启"）
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
  [int]$WaitSeconds = 0       # 先等 N 秒再检查（登录后让磁盘/网络就绪）
)

$ErrorActionPreference = 'SilentlyContinue'

$ExePath   = '${APP_DIR}\DeepSeek Harness.exe'
$ProcName  = 'DeepSeek Harness'
$OutDir    = '${MOLLY_ROOT}\qq-whale\out'
$LogFile   = Join-Path $OutDir 'start-dsh.log'
$LogMaxBytes = 512 * 1024

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

if ($WaitSeconds -gt 0) { Start-Sleep -Seconds $WaitSeconds }

Write-Log '--- 启动检查 ---'

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
