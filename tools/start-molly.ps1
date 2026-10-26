# ============================================================
# 一键拉起 Molly（QQ 111111111 + NapCat + OneBot11）
#
# 为什么要写成脚本：启动 NapCat 要设 5 个环境变量、路径还都是绝对路径，
# 每次手敲必然漏一个；漏了的表现是 QQ 起来了但 OneBot 端口不通，
# 看起来像"插件坏了"，实际只是没注入上。
#
# 用法：
#   pwsh -File start-molly.ps1            # 启动并检查
#   pwsh -File start-molly.ps1 -Status    # 只看状态，不启动
#   pwsh -File start-molly.ps1 -Restart   # 杀掉现有 QQ 再重起
#
# 关于"快速登录"：QQNT 会把登录态存本地，NapCat 重启后一般能直接
# 续上（这就是所谓一键登录）。但登录态有时效，过期就要重新扫码——
# 脚本检测到 waiting_qrcode 时会把二维码放大到 560px 放在 out\ 下。
# ============================================================

param(
  [switch]$Status,
  [switch]$Restart
)

$ErrorActionPreference = 'Stop'

$ROOT    = Split-Path -Parent $PSScriptRoot          # qq-whale
$NAPCAT  = Join-Path $ROOT 'napcat'
$OUT     = Join-Path $ROOT 'out'
$QQEXE   = '<REDACTED>\QQ\QQ.exe'
# 快速登录：NapCat 启动器把「QQ 号」当第三个参数传进去，就会走 QQ 本地保存的
# 登录凭据（launcher.bat 的 %* 原样透传，官方文档写法是 `launcher.bat 123456789`）。
# 以前这里没传 → 每次启动都打印「没有 -q 指令指定快速登录，将使用二维码登录方式」，
# 掉一次线就得人工扫一次码（2026-10-22 掉线治理）。
$QQNUM   = '111111111'
$WEBUI   = 'http://127.0.0.1:6099'
$WEBTOKEN = '${NAPCAT_TOKEN}'                           # napcat\config\webui.json
$ONEBOBOT_PORT = 3001

function Write-Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "  [OK]   $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "  [WARN] $msg" -ForegroundColor Yellow }
function Write-Bad($msg)  { Write-Host "  [FAIL] $msg" -ForegroundColor Red }

# ---------- WebUI 鉴权（NapCat 要求 sha256(token + '.napcat')） ----------
function Get-Credential {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $bytes = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes("$WEBTOKEN.napcat"))
  $hash = ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''
  $body = '{"hash":"' + $hash + '"}'
  $r = Invoke-RestMethod -Uri "$WEBUI/api/auth/login" -Method Post `
        -ContentType 'application/json' -Body $body -TimeoutSec 10
  if (-not $r.data.Credential) { throw 'WebUI 登录失败，检查 token' }
  return $r.data.Credential
}

function Get-LoginStatus($cred) {
  $h = @{ Authorization = "Bearer $cred" }
  return (Invoke-RestMethod -Uri "$WEBUI/api/QQLogin/CheckLoginStatus" -Method Post `
            -Headers $h -ContentType 'application/json' -Body '{}' -TimeoutSec 10).data
}

function Show-QRCode {
  $qr = Join-Path $NAPCAT 'cache\qrcode.png'
  if (-not (Test-Path $qr)) { Write-Bad '找不到二维码文件'; return }
  Add-Type -AssemblyName System.Drawing
  $src = [System.Drawing.Image]::FromFile($qr)
  $big = New-Object System.Drawing.Bitmap 560, 560
  $g = [System.Drawing.Graphics]::FromImage($big)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
  $g.DrawImage($src, 0, 0, 560, 560)
  $dst = Join-Path $OUT 'Molly-login-qrcode.png'
  $big.Save($dst, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $big.Dispose(); $src.Dispose()
  Write-Warn "需要扫码。二维码已放大到：$dst"
  Write-Warn '用手机 QQ（111111111 那个号）扫它'
}

# ---------- 状态检查 ----------
function Invoke-Status {
  $ok = $true

  Write-Step 'QQ 进程'
  $qq = @(Get-Process QQ -ErrorAction SilentlyContinue)
  if ($qq.Count -gt 0) { Write-Ok "$($qq.Count) 个 QQ 进程在跑" }
  else { Write-Bad 'QQ 没在跑'; return $false }

  Write-Step 'NapCat WebUI (6099)'
  try {
    $cred = Get-Credential
    Write-Ok 'WebUI 可访问且鉴权通过'
  } catch {
    Write-Bad "WebUI 不通：$($_.Exception.Message)"
    return $false
  }

  Write-Step 'QQ 登录状态'
  $st = Get-LoginStatus $cred
  if ($st.isLogin) {
    Write-Ok "已登录  phase=$($st.loginPhase)  coreReady=$($st.coreReady)"
  } else {
    Write-Bad "未登录  phase=$($st.loginPhase)"
    Show-QRCode
    $ok = $false
  }

  Write-Step "OneBot WS ($ONEBOBOT_PORT)"
  $conn = @(Get-NetTCPConnection -LocalPort $ONEBOBOT_PORT -State Listen -ErrorAction SilentlyContinue)
  if ($conn.Count -gt 0) { Write-Ok "端口 $ONEBOBOT_PORT 在监听" }
  else { Write-Bad "端口 $ONEBOBOT_PORT 没监听（检查 napcat\config\onebot11.json）"; $ok = $false }

  return $ok
}

# ---------- 启动 ----------
function Start-NapCat {
  Write-Step '启动 NapCat（注入 QQ）'

  # 这五个环境变量缺一不可，NapCatWinBootMain 靠它们找注入脚本
  $env:NAPCAT_LOAD_PATH     = Join-Path $NAPCAT 'loadNapCat.js'
  $env:NAPCAT_INJECT_PATH   = Join-Path $NAPCAT 'NapCatWinBootHook.dll'
  $env:NAPCAT_LAUNCHER_PATH = Join-Path $NAPCAT 'NapCatWinBootMain.exe'
  $env:NAPCAT_MAIN_PATH     = Join-Path $NAPCAT 'napcat.mjs'
  $env:NAPCAT_PATCH_PACKAGE = Join-Path $NAPCAT 'qqnt.json'

  # 第六个（最关键）：固定 WebUI 的 JWT 签名密钥。
  # NapCat 默认每次启动都随机生成一个，于是重启后 start-molly 里那套
  # sha256(token+'.napcat') 鉴权仍然对得上，但 WebUI 内部签发的
  # Bearer 会失效，表现为 /api/... 一律 401，看起来像"token 错了"。
  # 注入固定值后，重启前后签出来的 token 一致，脚本与 watch-login 都不用改。
  $env:NAPCAT_WEBUI_JWT_SECRET_KEY = '${NAPCAT_JWT_SECRET}'

  foreach ($p in @($env:NAPCAT_LOAD_PATH, $env:NAPCAT_INJECT_PATH,
                   $env:NAPCAT_LAUNCHER_PATH, $env:NAPCAT_MAIN_PATH, $env:NAPCAT_PATCH_PACKAGE)) {
    if (-not (Test-Path $p)) { throw "缺少文件：$p" }
  }

  # 把 NapCat 的启动输出落盘（C 项）：以前 -WindowStyle Hidden 之后 stdout/stderr
  # 全被丢弃，掉线时没有任何现场可查；watchdog 的 offline 快照要靠这两个文件取证。
  # 注意：Start-Process 的重定向是**每次启动重建**（覆盖写，不是 append），
  # 所以文件里永远是「最近一次启动」的输出，正好是排查掉线想要的，也不用担心无限增长。
  $OutDir = $OUT
  if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Force -Path $OutDir | Out-Null }
  $napcatBootLog = Join-Path $OutDir 'napcat-boot.log'
  $napcatBootErr = Join-Path $OutDir 'napcat-boot.err.log'

  Start-Process -FilePath $env:NAPCAT_LAUNCHER_PATH `
    -ArgumentList @($QQEXE, $env:NAPCAT_INJECT_PATH, $QQNUM) -WindowStyle Hidden `
    -RedirectStandardOutput $napcatBootLog `
    -RedirectStandardError $napcatBootErr
  Write-Ok "已拉起（快速登录 QQ=$QQNUM），等它初始化…"

  # 等 WebUI 起来（最多 30 秒）
  for ($i = 0; $i -lt 15; $i++) {
    Start-Sleep -Seconds 2
    try {
      $null = Invoke-WebRequest "$WEBUI/webui/" -TimeoutSec 2 -UseBasicParsing
      Write-Ok 'WebUI 已就绪'
      return
    } catch { }
  }
  throw '等 30 秒 WebUI 还是没起来'
}

# ---------- 主流程 ----------
if ($Restart) {
  Write-Step '关闭现有 QQ（先温和关闭，避免强杀丢登录态）'
  # 以前这里是 Stop-Process -Force 一把梭：QQNT 的登录态还没落盘就被杀掉，
  # 下一次只能重新扫码，等于每次自动抢修都在给自己制造一次人工扫码（2026-10-22 掉线治理）。
  # 现在先发关闭窗口消息，给 8 秒自己退；退不掉才强杀兜底。
  $qqProcs = @(Get-Process QQ -ErrorAction SilentlyContinue)
  if ($qqProcs.Count -gt 0) {
    foreach ($p in $qqProcs) { try { $null = $p.CloseMainWindow() } catch { } }
    $deadline = (Get-Date).AddSeconds(8)
    while ((Get-Date) -lt $deadline -and @(Get-Process QQ -ErrorAction SilentlyContinue).Count -gt 0) {
      Start-Sleep -Milliseconds 500
    }
    $left = @(Get-Process QQ -ErrorAction SilentlyContinue)
    if ($left.Count -gt 0) {
      Write-Warn "还有 $($left.Count) 个 QQ 进程没退出，强杀兜底"
      $left | Stop-Process -Force
    } else {
      Write-Ok 'QQ 已温和退出'
    }
  } else {
    Write-Ok '没有正在跑的 QQ'
  }
  Start-Sleep -Seconds 2
}

if (-not $Status) {
  $webuiUp = $false
  try { $null = Invoke-WebRequest "$WEBUI/webui/" -TimeoutSec 2 -UseBasicParsing; $webuiUp = $true } catch { }
  if (-not $webuiUp) { Start-NapCat }
  else { Write-Step 'NapCat 已在跑，跳过启动' }
}

# ---------- 看板数据服务（19391）----------
# 大看板的「记忆 / 表情」两页签靠这个只读服务取数。它挂了不影响 Molly 本体，
# 所以这里失败只提示，不改退出码。
try {
  $panelUp = [bool](Get-NetTCPConnection -State Listen -LocalPort 19391 -ErrorAction SilentlyContinue)
  if (-not $panelUp) {
    # 2026-10-26（部署者反馈 m03205）：这里原来写死作者机的 node 绝对路径，
    # 换台机器就 Exec format/no such file。改成 MOLLY_NODE > PATH 里的 node > 历史路径兜底。
    $nodeExe = $env:MOLLY_NODE
    if (-not $nodeExe) {
      $cmd = Get-Command node -ErrorAction SilentlyContinue
      if ($cmd) { $nodeExe = $cmd.Source }
    }
    if (-not $nodeExe) {
      $legacy = '${HOME}\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
      if (Test-Path $legacy) { $nodeExe = $legacy }
    }
    if (-not $nodeExe) { throw '找不到 node：请把 node 加进 PATH，或设置环境变量 MOLLY_NODE' }
    $panelJs = Join-Path $PSScriptRoot 'panel-data.mjs'
    $outDir = Join-Path (Split-Path $PSScriptRoot -Parent) 'out'
    if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }
    # dataDir 由 panel-data.mjs 自己解析：MOLLY_DATA_DIR > 插件配置里的 dataDir > 默认值。
    Start-Process -FilePath $nodeExe -ArgumentList @($panelJs) -WindowStyle Hidden `
      -RedirectStandardOutput (Join-Path $outDir 'panel-data.log') `
      -RedirectStandardError  (Join-Path $outDir 'panel-data.log.err')
    Start-Sleep -Seconds 1
    Write-Step '看板数据服务已启动（19391）'
  } else {
    Write-Step '看板数据服务已在跑，跳过'
  }
} catch { Write-Host '[WARN] 看板数据服务没起来（不影响 QQ）' -ForegroundColor Yellow }

$healthy = Invoke-Status

Write-Host ''
if ($healthy) {
  Write-Host 'Molly 全线正常。' -ForegroundColor Green
  Write-Host '如果 DSH 里看不到她，重启 DSH 让插件重新加载。' -ForegroundColor Gray
} else {
  Write-Host '有问题，见上面的 [FAIL] / [WARN]。' -ForegroundColor Yellow
  exit 1
}
