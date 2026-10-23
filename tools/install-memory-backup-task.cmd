@echo off
chcp 65001 >nul
REM 装「记忆池定期备份」计划任务（2026-10-23 主人 m00608）
REM 每 2 小时跑一次 tools\backup-memory.ps1，把记忆池拷到 D:\MollyBackup\memory 和 ${MOLLY_ROOT}Backup\memory
REM 以当前用户身份装（不需要管理员；被策略拦时按提示重跑）

setlocal
set "PS=pwsh.exe"
where pwsh.exe >nul 2>nul
if errorlevel 1 set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"

schtasks /Create /F /TN "Molly-MemoryBackup" ^
  /TR "%PS% -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"${MOLLY_ROOT}\qq-whale\tools\backup-memory.ps1\"" ^
  /SC HOURLY /MO 2 /RL LIMITED /IT

if errorlevel 1 (
  echo.
  echo [WARN] 装任务失败。退路：用管理员开一个终端再跑一次本脚本；
  echo        或者临时改成「会话内定时」（下次做时再接）。
  exit /b 1
)

echo.
echo [OK] 已安装计划任务 Molly-MemoryBackup：每 2 小时一次
schtasks /Query /TN "Molly-MemoryBackup" /V /FO LIST | findstr /i /c:"任务名" /c:"下次运行时间" /c:"状态" /c:"Task To Run" /c:"Next Run Time" /c:"Status"
echo.
echo 立刻手动跑一次验证：
echo   powershell -NoProfile -ExecutionPolicy Bypass -File "${MOLLY_ROOT}\qq-whale\tools\backup-memory.ps1" -Force
exit /b 0
