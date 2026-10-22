#Requires -Version 5.1
<#
  停止 SnowLuma + QQ（P2，2026-10-22）

  为什么需要它：控制台以普通权限运行，杀不掉提权的 QQ.exe / SnowLuma；所以「停止 Molly」
  走计划任务 SnowLuma-Stop（RunLevel Highest）。

  行为：温和关 QQ（超时强杀兜底）→ 结束 SnowLuma（node.exe 且命令行含 index.mjs）。
  不碰 DSH 宿主、网关、控制台自己，也不动任何计划任务。

  日志：${MOLLY_ROOT}\qq-whale\out\snowluma-stop.log
  状态：${MOLLY_ROOT}\qq-whale\out\snowluma-stop-status.json
#>

$ErrorActionPreference = 'Continue'

$LOGF  = '${MOLLY_ROOT}\qq-whale\out\snowluma-stop.log'
$STATF = '${MOLLY_ROOT}\qq-whale\out\snowluma-stop-status.json'

function Log([string]$m) {
  $line = '{0} {1}' -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'), $m
  Add-Content -Path $LOGF -Value $line -Encoding utf8
  Write-Host $line
}

function Test-Port([int]$port) {
  try { return [bool](Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) } catch { return $false }
}

Log '===================== SnowLuma 停止 ====================='
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
Log ('running as: {0} admin={1}' -f [Security.Principal.WindowsIdentity]::GetCurrent().Name, $isAdmin)

# 1) 温和关 QQ
$qqBefore = @(Get-Process -Name 'QQ' -ErrorAction SilentlyContinue).Count
Log ('关闭前 QQ 进程数：{0}' -f $qqBefore)
$qq = Get-Process -Name 'QQ' -ErrorAction SilentlyContinue
if ($qq) {
  foreach ($p in $qq) { try { [void]$p.CloseMainWindow() } catch {} }
  $deadline = (Get-Date).AddSeconds(10)
  while ((Get-Date) -lt $deadline) {
    if (-not (Get-Process -Name 'QQ' -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 500
  }
  $left = Get-Process -Name 'QQ' -ErrorAction SilentlyContinue
  if ($left) {
    Log ('温和关闭超时，强制结束 {0} 个 QQ 进程' -f @($left).Count)
    $left | Stop-Process -Force -ErrorAction SilentlyContinue
  }
}
# NapCat 引导进程（迁移前遗留）也顺手清掉
$bootLeft = Get-Process -Name 'NapCatWinBootMain' -ErrorAction SilentlyContinue
if ($bootLeft) { $bootLeft | Stop-Process -Force -ErrorAction SilentlyContinue }

# 2) 结束 SnowLuma 进程
$sl = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match 'index\.mjs' })
if ($sl) {
  Log ('结束 SnowLuma 进程：{0}' -f (($sl | ForEach-Object { $_.ProcessId }) -join ','))
  $sl | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
} else {
  Log '没有找到 SnowLuma 进程（本来就没在跑）'
}

Start-Sleep -Seconds 2
$qqAfter = @(Get-Process -Name 'QQ' -ErrorAction SilentlyContinue).Count
$slAfter = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match 'index\.mjs' }).Count
Log ('停止后：QQ={0} SnowLuma={1} ports(5099/3000/3001)={2}/{3}/{4}' -f $qqAfter, $slAfter, (Test-Port 5099), (Test-Port 3000), (Test-Port 3001))

$report = [ordered]@{
  at            = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
  admin         = $isAdmin
  qqBefore      = $qqBefore
  qqAfter       = $qqAfter
  snowlumaAfter = $slAfter
  ports         = [ordered]@{ webui5099 = (Test-Port 5099); http3000 = (Test-Port 3000); ws3001 = (Test-Port 3001) }
}
[System.IO.File]::WriteAllText($STATF, ($report | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false)))
Log ('状态已写入 {0}' -f $STATF)
Log '===================== 停止结束 ====================='
