#Requires -Version 5.1
<#
  P2 收尾（需要管理员）：
    1. 重新启用 Molly-Watchdog（P1 切换时禁用；现在 watchdog 已支持 SnowLuma 后端）
    2. 确认 SnowLuma-Boot 计划任务存在且为 Highest
    3. 把结果写 out\p2-enable-watchdog.json

  幂等：重复跑安全。
#>

$ErrorActionPreference = 'Continue'
$ROOT = '${MOLLY_ROOT}\qq-whale'
$LOG  = Join-Path $ROOT 'out\p2-enable-watchdog.log'
$JSON = Join-Path $ROOT 'out\p2-enable-watchdog.json'

function L([string]$m) {
  $line = '{0} {1}' -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'), $m
  Add-Content -Path $LOG -Value $line -Encoding utf8
  Write-Host $line
}

$result = [ordered]@{ at = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'); admin = $false; watchdog = $null; snowlumaBoot = $null; errors = @() }

try {
  $result.admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  L ('start admin=' + $result.admin)
  if (-not $result.admin) { throw '需要管理员权限' }

  # 1) Molly-Watchdog
  try {
    Stop-ScheduledTask -TaskName 'Molly-Watchdog' -ErrorAction SilentlyContinue | Out-Null
    Enable-ScheduledTask -TaskName 'Molly-Watchdog' -ErrorAction Stop | Out-Null
    $t = Get-ScheduledTask -TaskName 'Molly-Watchdog'
    $i = Get-ScheduledTaskInfo -TaskName 'Molly-Watchdog'
    $result.watchdog = [ordered]@{ state = [string]$t.State; runLevel = [string]$t.Principal.RunLevel; lastRun = [string]$i.LastRunTime; lastResult = $i.LastTaskResult; nextRun = [string]$i.NextRunTime }
    L ('Molly-Watchdog state={0} next={1}' -f $t.State, $i.NextRunTime)
  } catch {
    $result.errors += ('watchdog: ' + $_.Exception.Message)
    L ('watchdog ERROR ' + $_.Exception.Message)
  }

  # 2) SnowLuma-Boot
  try {
    $b = Get-ScheduledTask -TaskName 'SnowLuma-Boot' -ErrorAction Stop
    $bi = Get-ScheduledTaskInfo -TaskName 'SnowLuma-Boot'
    $result.snowlumaBoot = [ordered]@{ state = [string]$b.State; runLevel = [string]$b.Principal.RunLevel; triggers = @($b.Triggers | ForEach-Object { $_.CimClass.CimClassName }); action = [string]$b.Actions[0].Arguments }
    L ('SnowLuma-Boot state={0} runLevel={1}' -f $b.State, $b.Principal.RunLevel)
  } catch {
    $result.errors += ('snowluma-boot: ' + $_.Exception.Message)
    L ('SnowLuma-Boot ERROR ' + $_.Exception.Message)
  }

  $result.ok = ($result.errors.Count -eq 0)
} catch {
  $result.errors += $_.Exception.Message
  $result.ok = $false
}

[System.IO.File]::WriteAllText($JSON, ($result | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false)))
L ('RESULT ok={0} errors={1}' -f $result.ok, ($result.errors -join '; '))
if ($result.ok) { exit 0 } else { exit 1 }
