#Requires -Version 5.1
<#
  注册 SnowLuma 的两个计划任务（P2，2026-10-22）

  为什么需要它们：原来开机/登录后没有任何任务负责拉起 Molly 的 QQ+NapCat 链路，
  现在统一由 snowluma-start.ps1 负责：清 QQ → 起 SnowLuma → 起原生 QQ（hook 自动注入）→ 等扫码。
  本脚本只做「注册任务」，幂等（-Force 覆盖）。

  任务一 SnowLuma-Boot（登录触发，延迟 30 秒）：
     完整启动：清 QQ → 起 SnowLuma → 起原生 QQ → 等扫码。
     控制台「重启」按钮也触发它（全量重启，约 20~40 秒）。
  任务二 SnowLuma-Relogin（无触发器，仅供手动/控制台触发）：
     只重启 QQ（snowluma-start.ps1 -QQOnly），SnowLuma 进程不动、设备指纹不变，
     hookAutoLoad 会把 hook 重新注入新起的 QQ —— 掉登录/假在线时用这个最稳。
     控制台「重新登录」按钮触发它。

  两者都以 RunLevel Highest 运行（注入提权的 QQ.exe 必须提权）。

  日志：${MOLLY_ROOT}\qq-whale\out\setup-snowluma-boot.log
#>

param(
  [string]$TaskName = 'SnowLuma-Boot',
  [string]$ReloginTaskName = 'SnowLuma-Relogin',
  [string]$StopTaskName = 'SnowLuma-Stop'
)

$ErrorActionPreference = 'Stop'
$log = '${MOLLY_ROOT}\qq-whale\out\setup-snowluma-boot.log'
function L([string]$m) {
  $line = '{0} {1}' -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'), $m
  Add-Content -Path $log -Value $line -Encoding utf8
  Write-Host $line
}

try {
  $me = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  L ('start user={0} admin={1} boot={2} relogin={3}' -f $me, $isAdmin, $TaskName, $ReloginTaskName)
  if (-not $isAdmin) { L 'ERROR 需要管理员权限'; exit 2 }

  $script = '${MOLLY_ROOT}\qq-whale\tools\snowluma-start.ps1'
  if (-not (Test-Path $script)) { L ('ERROR 找不到 ' + $script); exit 2 }

  $principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10)

  # ── 任务一：登录后完整启动 ────────────────────────────────────────────────
  $bootAction = New-ScheduledTaskAction -Execute 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' `
    -Argument ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"' -f $script) `
    -WorkingDirectory '${MOLLY_ROOT}\qq-whale'
  $bootTrigger = New-ScheduledTaskTrigger -AtLogOn -User $me
  try { $bootTrigger.Delay = 'PT30S'; L 'boot trigger delay = PT30S' } catch { L ('boot trigger delay 设置失败（忽略）：' + $_.Exception.Message) }
  $bootTask = New-ScheduledTask -Action $bootAction -Trigger $bootTrigger -Principal $principal -Settings $settings
  Register-ScheduledTask -TaskName $TaskName -InputObject $bootTask -Force | Out-Null
  $bt = Get-ScheduledTask -TaskName $TaskName
  L ('registered {0}: state={1} runLevel={2} triggers={3}' -f $TaskName, $bt.State, $bt.Principal.RunLevel, (($bt.Triggers | ForEach-Object { $_.CimClass.CimClassName }) -join ','))

  # ── 任务二：只重启 QQ（无触发器，手动/控制台触发）────────────────────────
  $reAction = New-ScheduledTaskAction -Execute 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' `
    -Argument ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -QQOnly' -f $script) `
    -WorkingDirectory '${MOLLY_ROOT}\qq-whale'
  $reTask = New-ScheduledTask -Action $reAction -Principal $principal -Settings $settings
  Register-ScheduledTask -TaskName $ReloginTaskName -InputObject $reTask -Force | Out-Null
  $rt = Get-ScheduledTask -TaskName $ReloginTaskName
  L ('registered {0}: state={1} runLevel={2} triggers={3}' -f $ReloginTaskName, $rt.State, $rt.Principal.RunLevel, (($rt.Triggers | ForEach-Object { $_.CimClass.CimClassName }) -join ','))

  # ── 任务三：停止（无触发器，控制台「停止 Molly」用）──────────────────────
  # 控制台以普通权限运行，杀不掉提权的 QQ/SnowLuma，所以停止动作也走提权任务。
  $stopScript = '${MOLLY_ROOT}\qq-whale\tools\snowluma-stop.ps1'
  if (Test-Path $stopScript) {
    $stopAction = New-ScheduledTaskAction -Execute 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' `
      -Argument ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"' -f $stopScript) `
      -WorkingDirectory '${MOLLY_ROOT}\qq-whale'
    $stopTask = New-ScheduledTask -Action $stopAction -Principal $principal -Settings $settings
    Register-ScheduledTask -TaskName $StopTaskName -InputObject $stopTask -Force | Out-Null
    $st = Get-ScheduledTask -TaskName $StopTaskName
    L ('registered {0}: state={1} runLevel={2} triggers={3}' -f $StopTaskName, $st.State, $st.Principal.RunLevel, (($st.Triggers | ForEach-Object { $_.CimClass.CimClassName }) -join ','))
  } else {
    L ('SKIP stop task：找不到 ' + $stopScript)
  }

  L 'RESULT OK'
  exit 0
} catch {
  L ('RESULT ERROR ' + $_.Exception.Message)
  exit 1
}
