@echo off
chcp 65001 >nul
REM 卸「记忆池定期备份」计划任务（2026-10-23 主人 m00608）
REM 只删计划任务，不删已经备份出来的 D:\MollyBackup / ${MOLLY_ROOT}Backup
schtasks /Delete /F /TN "Molly-MemoryBackup"
if errorlevel 1 (
  echo [WARN] 删除失败：任务可能没装过，或者需要管理员权限
  exit /b 1
)
echo [OK] 已删除计划任务 Molly-MemoryBackup（备份文件保留在 D:\MollyBackup\memory 和 ${MOLLY_ROOT}Backup\memory）
exit /b 0
