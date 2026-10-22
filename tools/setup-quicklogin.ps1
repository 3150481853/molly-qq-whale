# ============================================================
# setup-quicklogin.ps1 —— 一次性建立 QQ「快速登录」凭据（2026-10-22 掉线治理）
#
# 为什么需要它：
#   NapCat 每次重启都打印「没有 -q 指令指定快速登录，将使用二维码登录方式」，
#   日志里「可用于快速登录 of QQ：」永远是空列表 —— 说明 QQ 本体从没存过登录凭据。
#   实测掉线 20 次 / 3.54 天、平均每次离线 67 分钟，绝大部分时间不是在等网络，
#   而是在等人扫码。快速登录一旦建立，watchdog 就能在几分钟内自动恢复。
#
# 这个脚本做四件事（需要管理员权限 + 手机扫码一次）：
#   1. 暂停 Molly-Watchdog 计划任务（否则每 10 分钟会抢着重启 QQ）
#   2. 关掉现在被 NapCat 注入的 QQ，改为「原生启动」QQ
#   3. 等你在 QQ 窗口里扫码并勾选「自动登录」→ QQ 把凭据写进本地 login.db
#   4. 关掉原生 QQ，用 start-molly.ps1（已带 -q 111111111）重新拉起，
#      检查启动日志里是否还走二维码
#
# 用法（必须管理员）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File setup-quicklogin.ps1
#
# 失败兜底：超时会自动用 start-molly.ps1 把 Molly 恢复上线，并重新启用计划任务。
# 日志：${MOLLY_ROOT}\qq-whale\out\setup-quicklogin.log
# ============================================================

param(
  [int]$TimeoutSeconds = 420
)

$ErrorActionPreference = 'Stop'

$ROOT      = Split-Path -Parent $PSScriptRoot
$OUT       = Join-Path $ROOT 'out'
$LOG       = Join-Path $OUT 'setup-quicklogin.log'
$QQEXE     = '<REDACTED>\QQ\QQ.exe'
$TASK      = 'Molly-Watchdog'
$NODE      = '${HOME}\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
# 登录成功时 QQ 会写这个 WAL；Worker 重启只会动 login.db-shm，不会动它（实测对照）
$LOGIN_WAL = '<REDACTED>\QQ\Tencent Files\Tencent Files\nt_qq\global\nt_db\login.db-wal'

if (-not (Test-Path $OUT)) { New-Item -ItemType Directory -Force -Path $OUT | Out-Null }

function Log($m) {
  $line = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + ' ' + $m
  Add-Content -Path $LOG -Value $line -Encoding UTF8
  Write-Host $line
}

function Get-QQProcs { @(Get-Process QQ -ErrorAction SilentlyContinue) }

function Close-QQ([int]$graceSec = 10) {
  $procs = Get-QQProcs
  if ($procs.Count -eq 0) { Log '没有 QQ 在跑'; return $true }
  Log "关闭 QQ（$($procs.Count) 个进程，先温和 CloseMainWindow）"
  foreach ($p in $procs) { try { $null = $p.CloseMainWindow() } catch { } }
  $deadline = (Get-Date).AddSeconds($graceSec)
  while ((Get-Date) -lt $deadline) {
    if ((Get-QQProcs).Count -eq 0) { Log 'QQ 已温和退出'; return $true }
    Start-Sleep -Milliseconds 500
  }
  $left = Get-QQProcs
  if ($left.Count -gt 0) {
    Log "温和关闭超时，强杀兜底 $($left.Count) 个"
    $left | Stop-Process -Force
    Start-Sleep -Seconds 3
  }
  $ok = ((Get-QQProcs).Count -eq 0)
  Log "QQ 进程清空=$ok"
  return $ok
}

function Start-Molly {
  Log '执行 start-molly.ps1'
  # 注意：不能用 `& powershell ... *>> $LOG` —— start-molly 拉起的 QQ/NapCat 会继承输出句柄，
  # 重定向永远等不到 EOF，本脚本会永久挂起（2026-10-22 09:27 事故：finally 没执行，计划任务停在 Disabled）。
  # 改用 Start-Process 重定向到独立文件 + 有超时的 WaitForExit。
  $smOut = Join-Path $OUT 'start-molly-invoked.out.log'
  $smErr = Join-Path $OUT 'start-molly-invoked.err.log'
  $p = Start-Process powershell.exe -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'start-molly.ps1')) `
        -WindowStyle Hidden -PassThru -RedirectStandardOutput $smOut -RedirectStandardError $smErr
  if (-not $p.WaitForExit(180000)) {
    Log 'WARN：start-molly 超过 180 秒未返回（QQ/NapCat 已脱离父进程，属正常现象，继续）'
  } else {
    Log "start-molly 退出码 $($p.ExitCode)"
  }
  if (Test-Path $smErr) {
    $e = (Get-Content $smErr -Encoding UTF8 -Raw)
    if ($e -and $e.Trim()) { Log ("start-molly stderr: " + $e.Trim().Substring(0, [Math]::Min(300, $e.Trim().Length))) }
  }
  $rc = $LASTEXITCODE
  Log "start-molly 退出码 $rc"
  return $rc
}

$taskDisabled = $false
try {
  Log '========== setup-quicklogin 开始 =========='
  Log "管理员=$([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))"

  # ── 1. 暂停 watchdog，避免它中途抢修 ──
  try {
    $t = Get-ScheduledTask -TaskName $TASK -ErrorAction Stop
    if ($t.State -ne 'Disabled') {
      Disable-ScheduledTask -TaskName $TASK | Out-Null
      $taskDisabled = $true
      Log '已暂停计划任务 Molly-Watchdog'
    } else { Log '计划任务本来就是 Disabled' }
  } catch { Log "暂停计划任务失败（继续）：$($_.Exception.Message)" }

  # ── 2. 关掉被注入的 QQ ──
  if (-not (Close-QQ)) { throw 'QQ 关不掉，放弃' }

  # ── 3. 原生启动 QQ，等用户扫码 ──
  Log '原生启动 QQ（不注入 NapCat）。请在弹出的 QQ 窗口里扫码，并勾选「自动登录」/「记住登录状态」'
  $t0 = Get-Date
  Start-Process -FilePath $QQEXE
  Log "等待登录成功（最多 $TimeoutSeconds 秒，检测 login.db-wal 更新）…"

  $loggedIn = $false
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    try {
      $item = Get-Item $LOGIN_WAL -ErrorAction Stop
      # 门槛 15 秒：QQ 启动瞬间也会写 WAL（2026-10-22 实测 13 秒误判过一次），
      # 但真正登录会持续写；最终真伪以「napcat-boot.log 出现 正在快速登录」为准（第 5 步会验）。
      if ($item.LastWriteTime -gt $t0.AddSeconds(15)) { $loggedIn = $true; break }
    } catch { }
  }

  if (-not $loggedIn) {
    Log 'TIMEOUT：没检测到登录成功，放弃并恢复原状'
    Close-QQ | Out-Null
    Start-Molly | Out-Null
    throw '快速登录凭据未建立（等待扫码超时）'
  }

  Log '检测到 QQ 登录成功，等 6 秒让凭据落盘'
  Start-Sleep -Seconds 6

  # ── 4. 关原生 QQ，用带 -q 的 start-molly 重新拉起 ──
  if (-not (Close-QQ)) { throw '登录后 QQ 关不掉' }
  Start-Sleep -Seconds 2

  Start-Molly | Out-Null
  Start-Sleep -Seconds 10

  # ── 5. 验证：启动日志里不应再出现二维码回退 ──
  $boot = Join-Path $OUT 'napcat-boot.log'
  if (Test-Path $boot) {
    $tail = Get-Content $boot -Tail 300 -Encoding UTF8
    $qrFallback = @($tail | Select-String -SimpleMatch '没有 -q 指令指定快速登录').Count
    $quickList  = @($tail | Select-String -SimpleMatch '可用于快速登录 of QQ').Count
    Log "启动日志检查：二维码回退提示 $qrFallback 处，快速登录列表提示 $quickList 处"
    if ($qrFallback -eq 0) { Log 'OK：本次启动没有走二维码回退（快速登录生效）' }
    else { Log 'WARN：启动日志仍有二维码回退，凭据可能没生效（看 login.db 是否真的写了）' }
  } else { Log "WARN：找不到 $boot" }

  try {
    $st = & $NODE (Join-Path $PSScriptRoot 'login-doctor.mjs') status 2>&1 | Out-String
    Log "最终登录状态：$($st.Trim())"
  } catch { Log "查状态失败：$($_.Exception.Message)" }

  Log '========== setup-quicklogin 结束 =========='
} catch {
  Log "FAIL：$($_.Exception.Message)"
  # 兜底：确保 Molly 至少恢复到可用状态
  try { if ((Get-QQProcs).Count -eq 0) { Start-Molly | Out-Null } } catch { Log "兜底拉起失败：$($_.Exception.Message)" }
  exit 2
} finally {
  if ($taskDisabled) {
    try { Enable-ScheduledTask -TaskName $TASK | Out-Null; Log '已恢复计划任务 Molly-Watchdog' }
    catch { Log "恢复计划任务失败（请手动 Enable）：$($_.Exception.Message)" }
  }
}
