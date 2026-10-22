@echo off
rem Install or repair the Molly-Console scheduled task (must run elevated).
rem Task: at logon of the current user -> wscript console-hidden.vbs -> node console-server.mjs (hidden).
rem Identity is resolved INSIDE the elevated PowerShell via WindowsIdentity, so the odd
rem domain name (example<U+2018>STUF) never has to be typed or escaped here.
setlocal
set "LOG=${MOLLY_ROOT}\out\install-console-task.log"
set "WSCRIPT=C:\Windows\System32\wscript.exe"
set "VBS=${MOLLY_ROOT}\qq-whale\tools\console-hidden.vbs"
echo. >> "%LOG%"
echo [%DATE% %TIME%] install Molly-Console >> "%LOG%"

echo [1/3] remove old task if present >> "%LOG%"
schtasks /Query /TN "Molly-Console" >nul 2>&1 && schtasks /Delete /TN "Molly-Console" /F >> "%LOG%" 2>&1

echo [2/3] register task >> "%LOG%"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
 "$uid = [Security.Principal.WindowsIdentity]::GetCurrent().Name;" ^
 "Write-Output ('identity=' + $uid);" ^
 "$a = New-ScheduledTaskAction -Execute '%WSCRIPT%' -Argument '"""%VBS%"""';" ^
 "$tr = New-ScheduledTaskTrigger -AtLogOn -User $uid;" ^
 "$se = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1);" ^
 "$pr = New-ScheduledTaskPrincipal -UserId $uid -LogonType Interactive -RunLevel Limited;" ^
 "Register-ScheduledTask -TaskName 'Molly-Console' -Action $a -Trigger $tr -Settings $se -Principal $pr -Description 'Molly local console (127.0.0.1:19392) autostart at logon, hidden window' -Force | Select-Object TaskName,State | Out-String" >> "%LOG%" 2>&1

echo [3/3] result >> "%LOG%"
schtasks /Query /TN "Molly-Console" /FO LIST >> "%LOG%" 2>&1
echo [%DATE% %TIME%] done >> "%LOG%"
exit /b 0
