#Requires -Version 5.1
<#
.SYNOPSIS
    拉起 / 保活 GPT-SoVITS 的 api_v2 服务（Molly 的专属音色后端）。

.DESCRIPTION
    2026-10-22 用户拍板（m05352）：Molly 的语音改用本机 GPT-SoVITS。
    2026-10-24 用户拍板（本条会话）：音色从社区 Dania 换成**用户自己录 54 句
    微调出来的 molly_own 模型**（v2ProPlus，训练脚本 ${MOLLY_ROOT}\data\video\run_train.py）。
    这个脚本由计划任务 Molly-Voice 每 5 分钟调一次，做三件事：
      1) 端口 9880 没在听 -> 隐藏启动 api_v2.py（首次加载约 20~40 秒）
      2) 服务就绪后把 molly_own 的 GPT/SoVITS 权重和参考音频切上去（幂等，可重复调）
      3) 把结果写进 out\voice-sovits-status.json，日志写 out\voice-sovits-start.log

    -Restart：先杀掉旧的 api_v2 进程再重启（换权重/换模型后用）。
    注意：普通权限即可，不需要管理员——python 进程是当前用户跑的。
#>
[CmdletBinding()]
param(
    [switch]$Restart,
    [int]$ReadyTimeoutSeconds = 180
)

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$Root = '${MOLLY_ROOT}\qq-whale'
$GptRoot = '<REDACTED>\GPT-SoVITS-v2pro-20250604'
$Python = Join-Path $GptRoot 'runtime\python.exe'
$Api = Join-Path $GptRoot 'api_v2.py'
$Port = 9880
$Log = Join-Path $Root 'out\voice-sovits-start.log'
$StatusFile = Join-Path $Root 'out\voice-sovits-status.json'

$GptWeights = Join-Path $GptRoot 'GPT_weights_v2ProPlus\molly_own-e10.ckpt'
$SoVitsWeights = Join-Path $GptRoot 'SoVITS_weights_v2ProPlus\molly_own_e16_s864.pth'
$RefAudio = '${MOLLY_ROOT}\data\qq-whale\voice-ref\molly-ref.wav'

function Write-Log([string]$msg) {
    $line = ('{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg)
    try { Add-Content -Path $Log -Value $line -Encoding UTF8 } catch {}
    Write-Host $line
}

function Test-Port([int]$p) {
    $c = New-Object System.Net.Sockets.TcpClient
    try {
        $iar = $c.BeginConnect('127.0.0.1', $p, $null, $null)
        if (-not $iar.AsyncWaitHandle.WaitOne(800)) { return $false }
        $c.EndConnect($iar)
        return $true
    } catch { return $false } finally { $c.Close() }
}

function Invoke-Api([string]$path) {
    try {
        $r = Invoke-RestMethod -Uri ("http://127.0.0.1:$Port$path") -TimeoutSec 30 -ErrorAction Stop
        return $r
    } catch {
        return $null
    }
}

function Get-Status {
    $s = [ordered]@{
        at = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
        listening = (Test-Port $Port)
        pid = $null
        weights = $false
        refer = $false
        note = ''
    }
    $proc = Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -match 'api_v2\.py' } |
        Select-Object -First 1
    if ($proc) { $s.pid = [int]$proc.ProcessId }
    return $s
}

function Save-Status($s) {
    try {
        ($s | ConvertTo-Json -Depth 4) | Set-Content -Path $StatusFile -Encoding UTF8
    } catch {}
}

# —— 锁：防止 watchdog 每次 --once 都拉一个新实例 ————————
# 2026-10-22 事故：watchdog 每分钟一个新进程，模块级节流记不住上次触发时间，
# 结果 12 秒内拉了两份 api_v2（第二份抢不到端口）。用 240 秒的锁文件挡住并发。
$Lock = Join-Path $Root 'out\voice-sovits-start.lock'
if (Test-Path $Lock) {
    $lockAge = ((Get-Date) - (Get-Item $Lock).LastWriteTime).TotalSeconds
    if ($lockAge -lt 240) {
        Write-Log ("另一个启动实例正在运行（锁龄 {0:N0}s），跳过" -f $lockAge)
        exit 0
    }
    Write-Log ("发现过期锁（{0:N0}s），接管" -f $lockAge)
}
try { Set-Content -Path $Lock -Value (Get-Date -Format 'o') -Encoding UTF8 } catch {}

function Exit-Script([int]$code) {
    try { Remove-Item -Path $Lock -ErrorAction SilentlyContinue } catch {}
    exit $code
}

# —— 0. 依赖检查 ————————————————————————————————
if (-not (Test-Path $Python)) { Write-Log "✗ python 不存在：$Python"; Exit-Script 3 }
if (-not (Test-Path $Api)) { Write-Log "✗ api_v2.py 不存在：$Api"; Exit-Script 3 }
if (-not (Test-Path $GptWeights)) { Write-Log "✗ molly_own GPT 权重不存在：$GptWeights"; Exit-Script 3 }
if (-not (Test-Path $SoVitsWeights)) { Write-Log "✗ molly_own SoVITS 权重不存在：$SoVitsWeights"; Exit-Script 3 }
if (-not (Test-Path $RefAudio)) { Write-Log "✗ 参考音频不存在：$RefAudio"; Exit-Script 3 }

$status = Get-Status

# —— 1. 需要重启就先杀旧进程 ————————————————————
if ($Restart -and $status.pid) {
    Write-Log "重启：结束旧 api_v2 进程 pid=$($status.pid)"
    try { Stop-Process -Id $status.pid -Force -ErrorAction SilentlyContinue } catch {}
    Start-Sleep -Seconds 2
    $status = Get-Status
}

# —— 2. 没在听就启动 ——————————————————————————
if (-not $status.listening) {
    Write-Log "端口 $Port 未监听，启动 api_v2（cwd=$GptRoot）"
    $outLog = Join-Path $Root 'out\voice-sovits.out.log'
    $errLog = Join-Path $Root 'out\voice-sovits.err.log'
    $p = Start-Process -FilePath $Python `
        -ArgumentList @($Api, '-a', '127.0.0.1', '-p', "$Port") `
        -WorkingDirectory $GptRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput $outLog -RedirectStandardError $errLog `
        -PassThru
    Write-Log "已启动 pid=$($p.Id)，等待就绪（最多 ${ReadyTimeoutSeconds}s）"
    $deadline = (Get-Date).AddSeconds($ReadyTimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 800
        if (Test-Port $Port) { break }
        if ($p.HasExited) { Write-Log "✗ api_v2 启动后退出，exit=$($p.ExitCode)，见 $errLog"; $status.note = 'start-failed'; Save-Status $status; Exit-Script 2 }
    }
} else {
    Write-Log "端口 $Port 已在监听（pid=$($status.pid)），跳过启动"
}

$status = Get-Status
if (-not $status.listening) {
    $status.note = 'not-listening'
    Save-Status $status
    Write-Log "✗ ${ReadyTimeoutSeconds}s 内未就绪"
    Exit-Script 2
}

# —— 3. 切到 molly_own 权重 + 参考音频（幂等）—————————
$gpt = Invoke-Api ('/set_gpt_weights?weights_path=' + [uri]::EscapeDataString($GptWeights))
$status.weights = ($null -ne $gpt)
$sv = Invoke-Api ('/set_sovits_weights?weights_path=' + [uri]::EscapeDataString($SoVitsWeights))
$ref = Invoke-Api ('/set_refer_audio?refer_audio_path=' + [uri]::EscapeDataString($RefAudio))
$status.refer = ($null -ne $ref)
$status.note = ("gpt={0} sovits={1} refer={2}" -f ($null -ne $gpt), ($null -ne $sv), ($null -ne $ref))
Save-Status $status
Write-Log ("就绪：{0}" -f $status.note)
Exit-Script 0
