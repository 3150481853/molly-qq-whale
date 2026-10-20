@echo off
rem ============================================================
rem  Molly Console launcher (double-click me)
rem  Ensures the console server on 127.0.0.1:19392 is running,
rem  then opens an Edge --app window (no address bar).
rem  Keep this file ASCII-only: the system ANSI codepage is 936,
rem  so GBK/ASCII bytes are the only safe bet. No chcp here.
rem ============================================================
setlocal

set "PS=powershell.exe"
set "SCRIPT=%~dp0tools\start-console.ps1"

if not exist "%SCRIPT%" (
    echo [ERROR] start-console.ps1 not found:
    echo         %SCRIPT%
    pause
    exit /b 1
)

rem /b = no new console window; the script hides everything else.
rem The script itself waits for /api/health and only then opens the window.
start "" /b "%PS%" -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*

exit /b 0
