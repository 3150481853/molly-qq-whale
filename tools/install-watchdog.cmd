@echo off
REM install-watchdog.cmd -- register Molly watchdog as a Windows scheduled task

setlocal

set "NODE=${HOME}\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
set "WATCHDOG=${MOLLY_ROOT}\qq-whale\tools\watchdog.mjs"
set "TASKNAME=Molly-Watchdog"
REM The task MUST NOT run node.exe directly: a console-subsystem exe started by
REM an InteractiveToken task gets a visible console window (the "black cmd box").
REM It goes through this thin wscript shell instead, which hides the window.
set "VBS=${MOLLY_ROOT}\qq-whale\tools\watchdog-hidden.vbs"
set "WSCRIPT=C:\Windows\System32\wscript.exe"

echo [1/4] Checking files...
if not exist "%NODE%" (
  echo   [X] node not found: %NODE%
  exit /b 1
)
if not exist "%WATCHDOG%" (
  echo   [X] watchdog not found: %WATCHDOG%
  exit /b 1
)
if not exist "%VBS%" (
  echo   [X] launcher not found: %VBS%
  echo       It is the no-window shell; without it the task would flash a console.
  exit /b 1
)
if not exist "%WSCRIPT%" (
  echo   [X] wscript not found: %WSCRIPT%
  exit /b 1
)
echo   [OK] node, watchdog, launcher and wscript present

echo [2/4] Removing old task if any...
schtasks /Query /TN "%TASKNAME%" >nul 2>&1
if %ERRORLEVEL% EQU 0 (
  schtasks /Delete /TN "%TASKNAME%" /F >nul 2>&1
  echo   [OK] old task removed
) else (
  echo   [--] no old task
)

echo [3/4] Creating scheduled task (every 10 min)...
REM Built with the ScheduledTasks module, not schtasks: schtasks strips the quotes
REM around the launcher path, so the task would break the moment the project lives
REM in a directory whose name contains a space.
REM ExecutionTimeLimit and UseUnifiedSchedulingEngine are NOT set here: PS 5.1
REM cannot persist either one through New-ScheduledTaskSettingsSet or
REM Set-ScheduledTask (both silently revert), so setting them would be a lie.
REM They have no effect on whether a window appears. See out\blackwindow-audit.md.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$q=[char]34; $act = New-ScheduledTaskAction -Execute '%WSCRIPT%' -Argument ('//nologo //B ' + $q + '%VBS%' + $q) -WorkingDirectory '%~dp0.'; $trg = New-ScheduledTaskTrigger -Once -At ([datetime]'2026-10-18T20:00:00') -RepetitionInterval (New-TimeSpan -Minutes 10); $set = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 1); Register-ScheduledTask -TaskName '%TASKNAME%' -Action $act -Trigger $trg -Settings $set -RunLevel Highest -Force | Out-Null"
if %ERRORLEVEL% NEQ 0 (
  echo   [X] Create failed with code %ERRORLEVEL%
  exit /b 1
)
echo   [OK] task created

echo [3b/4] Verifying the task really launches the no-window shell...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$t = Get-ScheduledTask -TaskName '%TASKNAME%'; $a = $t.Actions[0]; $ok = $true; if ($a.Execute -notmatch 'wscript\.exe$') { Write-Host '  [X] action is not wscript.exe'; $ok = $false }; if ($a.Arguments -notmatch '//B') { Write-Host '  [X] //B missing - a missing script would raise a modal dialog'; $ok = $false }; if ($a.Arguments -match 'node\.exe') { Write-Host '  [X] action still calls node.exe - black console window would come back'; $ok = $false }; if ($ok) { Write-Host '  [OK] action = wscript //nologo //B <launcher>' } else { exit 1 }"
if %ERRORLEVEL% NEQ 0 (
  echo   [X] verification failed - task was created but is NOT safe
  exit /b 1
)

echo [4/4] Triggering first run...
schtasks /Run /TN "%TASKNAME%" >nul 2>&1
if %ERRORLEVEL% EQU 0 (
  echo   [OK] first run triggered
) else (
  echo   [--] trigger failed
)

echo.
echo ============================================================
echo  Done. Useful commands:
echo   Query  : schtasks /Query /TN "%TASKNAME%" /V /FO LIST
echo   Run    : "%NODE%" "%WATCHDOG%" --once
echo   Status : "%NODE%" "%WATCHDOG%" --status
echo   Notify : "%NODE%" "%WATCHDOG%" --test-notify
echo   Disable: schtasks /Change /TN "%TASKNAME%" /DISABLE
echo   Delete : schtasks /Delete /TN "%TASKNAME%" /F
echo ============================================================

endlocal

