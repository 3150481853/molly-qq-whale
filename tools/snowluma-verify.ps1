#Requires -Version 5.1
<#
  SnowLuma 迁移验收探针（普通权限即可）

  检查四层，任何一层不对就如实报出来：
    1) 端口：WebUI 5099 / OneBot HTTP 3000 / OneBot WS 3001
    2) 进程：SnowLuma(node index.mjs)、QQ.exe
    3) OneBot 深度探测（和 P2 watchdog 用同一套口径）：
         get_login_info.retcode == 0
         get_status.retcode == 0 且 online=true
         get_csrf_token.retcode == 0（需服务端往返，静默离线时会挂）
         get_online_clients.retcode == 0 且 data 非空
         get_stranger_info(no_cache) — 仅作参考
    4) 插件侧：宿主 /state 的 link.state == online

  用法：tools\snowluma-verify.ps1 [-Json]
  日志：不写文件，直接输出；加 -Json 输出单行 JSON 方便管道处理。
#>

param([switch]$Json)

$ErrorActionPreference = 'Continue'

$TOKEN     = '${ONEBOT_TOKEN}'
$ONEBOT    = 'http://127.0.0.1:3000'
$HOSTSTATE = 'http://127.0.0.1:12343/dsh-qq-whale/state'

function Test-Port([int]$port) {
  try { return [bool](Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) } catch { return $false }
}
function Call-Action([string]$action, [string]$body = '{}') {
  $out = [ordered]@{ action = $action; ok = $false; retcode = $null; data = $null; error = '' }
  try {
    $resp = Invoke-RestMethod -Uri ($ONEBOT + '/' + $action) -Method Post -Body $body `
      -ContentType 'application/json' -Headers @{ Authorization = 'Bearer ' + $TOKEN } -TimeoutSec 10
    $out.retcode = [int]$resp.retcode
    $out.ok = ($out.retcode -eq 0)
    $out.data = $resp.data
  } catch {
    $out.error = $_.Exception.Message
  }
  return $out
}

$result = [ordered]@{
  at = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
  ports = [ordered]@{
    webui5099 = Test-Port 5099
    http3000  = Test-Port 3000
    ws3001    = Test-Port 3001
  }
  processes = [ordered]@{
    snowluma = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'index\.mjs' }).Count
    qq       = @(Get-Process -Name 'QQ' -ErrorAction SilentlyContinue).Count
    napcatBoot = @(Get-Process -Name 'NapCatWinBootMain' -ErrorAction SilentlyContinue).Count
  }
  onebot = [ordered]@{}
  plugin = [ordered]@{}
}

$result.onebot.login        = Call-Action 'get_login_info'
$result.onebot.status       = Call-Action 'get_status'
$result.onebot.csrf         = Call-Action 'get_csrf_token'
$result.onebot.onlineClient = Call-Action 'get_online_clients'
$result.onebot.stranger     = Call-Action 'get_stranger_info' '{"user_id":222222222,"no_cache":true}'

try {
  $st = Invoke-RestMethod -Uri $HOSTSTATE -TimeoutSec 8
  $result.plugin.link = $st.link.state
  $result.plugin.ready = $st.link.ready
  $result.plugin.messages = $st.metrics.messages
} catch {
  $result.plugin.link = 'unreachable'
  $result.plugin.error = $_.Exception.Message
}

$verdict = 'OK'
if (-not $result.ports.ws3001) { $verdict = 'FAIL: ws3001 未监听（OneBot 没起来/未登录）' }
elseif (-not $result.onebot.login.ok) { $verdict = 'FAIL: get_login_info retcode=' + $result.onebot.login.retcode }
elseif (-not $result.onebot.csrf.ok) { $verdict = 'FAIL: get_csrf_token retcode=' + $result.onebot.csrf.retcode }
elseif ($result.plugin.link -ne 'online') { $verdict = 'FAIL: 插件 link=' + $result.plugin.link }
$result.verdict = $verdict

if ($Json) {
  $result | ConvertTo-Json -Depth 8 -Compress
} else {
  $result | ConvertTo-Json -Depth 8
  Write-Host ''
  Write-Host ('VERDICT: ' + $verdict)
}
