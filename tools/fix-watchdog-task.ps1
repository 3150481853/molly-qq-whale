# 一次性修复：清掉卡住的 setup-quicklogin 进程 + 恢复 Molly-Watchdog 计划任务
# 背景：setup-quicklogin.ps1 里用 `& powershell -File start-molly.ps1 *>> 日志` 调子进程，
#       子进程拉起的 QQ/NapCat 继承了输出句柄 → 重定向等不到 EOF → 脚本永久挂起，
#       finally 里的 Enable-ScheduledTask 永远不执行。本脚本只做收尾，不动 QQ。
$ErrorActionPreference = 'Continue'
$out = '${MOLLY_ROOT}\qq-whale\out\fix-watchdog-result.txt'
$lines = @()
$lines += "at=$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
$lines += "admin=$((New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))"

foreach ($pidToKill in 49676) {
  $p = Get-Process -Id $pidToKill -ErrorAction SilentlyContinue
  if ($p) {
    try { Stop-Process -Id $pidToKill -Force -ErrorAction Stop; $lines += "killed $pidToKill" }
    catch { $lines += "kill $pidToKill failed: $($_.Exception.Message)" }
  } else {
    $lines += "$pidToKill not running"
  }
}

try { Enable-ScheduledTask -TaskName 'Molly-Watchdog' -ErrorAction Stop | Out-Null; $lines += 'enable ok' }
catch { $lines += "enable failed: $($_.Exception.Message)" }

$t = Get-ScheduledTask -TaskName 'Molly-Watchdog'
$i = Get-ScheduledTaskInfo -TaskName 'Molly-Watchdog'
$lines += "state=$($t.State) next=$($i.NextRunTime) last=$($i.LastRunTime) lastResult=$($i.LastTaskResult)"
$lines | Set-Content -Path $out -Encoding UTF8
