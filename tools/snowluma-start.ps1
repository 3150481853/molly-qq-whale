#Requires -Version 5.1
<#
  启动 SnowLuma + 原生 QQ（P1 切换 / P2 常驻启动器）

  为什么必须提权：SnowLuma 的 hook 要注入进 QQ.exe，QQ 目前由计划任务以
  RunLevel Highest 拉起（提权进程），SnowLuma 必须与 QQ 同权限，否则注入失败。

  默认行为：
    1. 温和关闭所有 QQ 进程（NapCat 注入在 QQ 进程里，必须先清掉）
    2. 以 ${MOLLY_ROOT}\snowluma 为工作目录启动 SnowLuma（hookAutoLoad 自动注入）
    3. 启动原生 QQ.exe，等你在 QQ 窗口扫码登录
    4. 探测 5099/3000/3001 端口与 get_login_info，写状态文件

  参数：-DisableWatchdog / -SkipQQClose / -SkipQQStart / -WaitLoginSeconds N / -QQOnly

  -DisableWatchdog（手动维护时才加）：
    暂停并禁用 Molly-Watchdog 计划任务。**默认不加**——watchdog 抢修时会调本脚本，
    如果默认就禁用，抢修一次 watchdog 就把自己弄没了（2026-10-22 改）。

  -QQOnly（2026-10-22 加，给 watchdog 抢修用）：
    只温和重启 QQ，不动计划任务、不重启 SnowLuma 进程。
    用途＝登录态失效/假在线时，SnowLuma 进程还在、hookAutoLoad 还在，
    杀掉 QQ 再拉起来，hook 会重新注入新 QQ，登录窗口弹出来等扫码。
    这样避免重启 SnowLuma 造成设备指纹变化、逼用户重新扫码。

  日志：${MOLLY_ROOT}\qq-whale\out\snowluma-boot.log
  状态：${MOLLY_ROOT}\qq-whale\out\snowluma-boot-status.json
#>

param(
  [switch]$DisableWatchdog,
  [switch]$SkipQQClose,
  [switch]$SkipQQStart,
  [int]$WaitLoginSeconds = 30,
  [switch]$QQOnly
)

$ErrorActionPreference = 'Continue'

$ROOT   = '${MOLLY_ROOT}\qq-whale'
$SL     = '${MOLLY_ROOT}\snowluma'
$QQEXE  = '<REDACTED>\QQ\QQ.exe'
$TOKEN  = '${ONEBOT_TOKEN}'
$LOGF   = Join-Path $ROOT 'out\snowluma-boot.log'
$STATF  = Join-Path $ROOT 'out\snowluma-boot-status.json'
$OUTLOG = Join-Path $ROOT 'out\snowluma-runtime.out.log'
$ERRLOG = Join-Path $ROOT 'out\snowluma-runtime.err.log'
$TASKID = 'Molly-Watchdog'

$ReuseSnowLuma = $false
if ($QQOnly) {
  $DisableWatchdog = $false
  $ReuseSnowLuma = $true
  $WaitLoginSeconds = 12
}

$steps = New-Object System.Collections.ArrayList
function Log([string]$m) {
  $line = '{0} {1}' -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'), $m
  Add-Content -Path $LOGF -Value $line -Encoding utf8
  Write-Host $line
}
function Add-Step([string]$name, [string]$result, [string]$detail = '') {
  [void]$steps.Add([ordered]@{ at = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'); step = $name; result = $result; detail = $detail })
}
function Test-Port([int]$port) {
  try { return [bool](Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) } catch { return $false }
}
function Wait-Port([int]$port, [int]$seconds) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-Port $port) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

Log '===================== SnowLuma 启动 ====================='
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
Log ('running as: {0} admin={1}' -f [Security.Principal.WindowsIdentity]::GetCurrent().Name, $isAdmin)
Add-Step 'precheck' 'ok' ('admin=' + $isAdmin)

$taskBefore = ''
if ($DisableWatchdog) {
  try {
    $t = Get-ScheduledTask -TaskName $TASKID -ErrorAction Stop
    $taskBefore = [string]$t.State
    Stop-ScheduledTask -TaskName $TASKID -ErrorAction SilentlyContinue | Out-Null
    Disable-ScheduledTask -TaskName $TASKID -ErrorAction SilentlyContinue | Out-Null
    $after = (Get-ScheduledTask -TaskName $TASKID -ErrorAction SilentlyContinue).State
    Log ('计划任务 {0}: {1} -> {2}' -f $TASKID, $taskBefore, $after)
    Add-Step 'watchdog' 'disabled' ('was=' + $taskBefore + ' now=' + $after)
  } catch {
    Log ('计划任务处理失败：' + $_.Exception.Message)
    Add-Step 'watchdog' 'error' $_.Exception.Message
  }
} else {
  Add-Step 'watchdog' 'skipped'
}

if (-not $SkipQQClose) {
  $qq = Get-Process -Name 'QQ' -ErrorAction SilentlyContinue
  $boot = Get-Process -Name 'NapCatWinBootMain' -ErrorAction SilentlyContinue
  Log ('关闭前：QQ={0} 个，NapCatWinBootMain={1} 个' -f @($qq).Count, @($boot).Count)
  if ($boot) { $boot | Stop-Process -Force -ErrorAction SilentlyContinue }
  if ($qq) {
    foreach ($p in $qq) { try { [void]$p.CloseMainWindow() } catch {} }
    $deadline = (Get-Date).AddSeconds(12)
    while ((Get-Date) -lt $deadline) {
      if (-not (Get-Process -Name 'QQ' -ErrorAction SilentlyContinue)) { break }
      Start-Sleep -Milliseconds 500
    }
    $left = Get-Process -Name 'QQ' -ErrorAction SilentlyContinue
    if ($left) {
      Log ('温和关闭超时，强制结束 {0} 个 QQ' -f @($left).Count)
      $left | Stop-Process -Force -ErrorAction SilentlyContinue
    }
  }
  Start-Sleep -Seconds 2
  $left2 = @(Get-Process -Name 'QQ' -ErrorAction SilentlyContinue).Count
  $leftBP = @(Get-Process -Name 'NapCatWinBootMain' -ErrorAction SilentlyContinue).Count
  Log ('关闭后：QQ={0} 个，NapCatWinBootMain={1} 个' -f $left2, $leftBP)
  Add-Step 'closeQQ' 'ok' ('remainingQQ=' + $left2)
} else {
  Add-Step 'closeQQ' 'skipped'
}

$existing = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'index\.mjs' }
if ($ReuseSnowLuma -and $existing) {
  Log ('QQOnly：沿用现有 SnowLuma 进程 pid={0}，不重启（只重启 QQ，靠 hookAutoLoad 重新注入）' -f (($existing | ForEach-Object { $_.ProcessId }) -join ','))
  Add-Step 'startSnowLuma' 'reused'
} else {
  if ($existing) {
    Log ('已有 SnowLuma 进程：{0}，先结束' -f ($existing.ProcessId -join ','))
    $existing | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 1
  }

  $env:SNOWLUMA_ACCEPT_EULA    = '1'
  $env:SNOWLUMA_ACCEPT_PRIVACY = '1'
  $env:SNOWLUMA_LOG_LEVEL      = 'info'
  $env:SNOWLUMA_HOOK_AUTOLOAD  = '1'

  foreach ($f in @($OUTLOG, $ERRLOG)) { if (Test-Path $f) { Remove-Item $f -Force -ErrorAction SilentlyContinue } }

  try {
    $slProc = Start-Process -FilePath (Join-Path $SL 'node.exe') -ArgumentList '.\index.mjs' `
      -WorkingDirectory $SL -WindowStyle Hidden -PassThru `
      -RedirectStandardOutput $OUTLOG -RedirectStandardError $ERRLOG
    Log ('已启动 SnowLuma：pid={0} cwd={1}' -f $slProc.Id, $SL)
    Add-Step 'startSnowLuma' 'ok' ('pid=' + $slProc.Id)
  } catch {
    Log ('启动 SnowLuma 失败：' + $_.Exception.Message)
    Add-Step 'startSnowLuma' 'error' $_.Exception.Message
  }
}

$webuiOk = Wait-Port 5099 90
Log ('WebUI(5099) 就绪：{0}' -f $webuiOk)
Add-Step 'webui5099' $(if ($webuiOk) { 'ok' } else { 'timeout' })

if (-not $SkipQQStart) {
  try {
    $qqProc = Start-Process -FilePath $QQEXE -PassThru
    Log ('已启动 QQ.exe：pid={0}（请扫码登录）' -f $qqProc.Id)
    Add-Step 'startQQ' 'ok' ('pid=' + $qqProc.Id)
  } catch {
    Log ('启动 QQ 失败：' + $_.Exception.Message)
    Add-Step 'startQQ' 'error' $_.Exception.Message
  }
} else {
  Add-Step 'startQQ' 'skipped'
}

Log ('等待 {0} 秒后写状态…' -f $WaitLoginSeconds)
Start-Sleep -Seconds $WaitLoginSeconds

$httpOk = Test-Port 3000
$wsOk   = Test-Port 3001
$loginRetcode = $null
$loginRaw = ''
try {
  $resp = Invoke-RestMethod -Uri 'http://127.0.0.1:3000/get_login_info' -Method Post -Body '{}' `
    -ContentType 'application/json' -Headers @{ Authorization = 'Bearer ' + $TOKEN } -TimeoutSec 8
  $loginRaw = ($resp | ConvertTo-Json -Compress -Depth 5)
  if ($null -ne $resp.retcode) { $loginRetcode = [int]$resp.retcode }
} catch {
  $loginRaw = $_.Exception.Message
}
$qqCount = @(Get-Process -Name 'QQ' -ErrorAction SilentlyContinue).Count
$slAlive = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'index\.mjs' }).Count

Log ('探测：http3000={0} ws3001={1} get_login_info.retcode={2} QQ进程={3} SnowLuma进程={4}' -f $httpOk, $wsOk, $loginRetcode, $qqCount, $slAlive)
Log ('get_login_info 原文：{0}' -f $loginRaw)

# 变量名别用 $status：PowerShell 变量名不区分大小写，会覆盖 $STATF 之类的路径变量
$report = [ordered]@{
  at            = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
  admin         = $isAdmin
  installDir    = $SL
  taskBefore    = $taskBefore
  http3000      = $httpOk
  ws3001        = $wsOk
  loginRetcode  = $loginRetcode
  loginRaw      = $loginRaw
  qqProcesses   = $qqCount
  snowlumaAlive = $slAlive
  steps         = $steps
  next          = '在 QQ 窗口用手机 QQ(111111111) 扫码，然后 tools\snowluma-verify.ps1'
}
[System.IO.File]::WriteAllText($STATF, ($report | ConvertTo-Json -Depth 8), (New-Object System.Text.UTF8Encoding($false)))
Log ('状态已写入 {0}' -f $STATF)
Log '===================== 启动结束 ====================='
