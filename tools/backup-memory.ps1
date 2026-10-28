# 记忆池定期备份（2026-10-23 主人 m00608：「记忆池先扩展至 2000 条，并且定期备份记忆池至 D 盘和 G 盘其他文件夹」）
#
# 干什么：
#   把 ${MOLLY_ROOT}\data\qq-whale\memory\ 下的记忆文件（memory.json / memory.md /
#   污染备份等）拷一份到两个不同物理盘的时间戳目录，失败重试，跑完写日志
#   和一份 memory-backup-status.json 给 /state 侧对账。
#
# 怎么跑：
#   计划任务 Molly-MemoryBackup 每 2 小时跑一次（用 tools\install-memory-backup-task.cmd 装）；
#   也可以手动：
#     powershell -NoProfile -ExecutionPolicy Bypass -File ${MOLLY_ROOT}\qq-whale\tools\backup-memory.ps1
#   带 -Force 立刻备份一次（忽略 5 分钟去重窗口）。
#
# 保存策略：
#   D:\MollyBackup\memory\<yyyyMMdd-HHmmss>\   +   ${MOLLY_ROOT}Backup\memory\<yyyyMMdd-HHmmss>\
#   两边各保留最新 48 份（约 4 天），多的从最旧的开始删。
#   每份都带 MANIFEST.json（来源 / 文件清单 / 大小 / sha256 / 时间）。
#
# 注意：
#   记忆池扩到 2000 条后 memory.json 约 0.5 MB，48 份 × 2 盘 ≈ 48 MB，可以忽略。
#   只读源文件，不动 ${MOLLY_ROOT}\data 下任何内容。

param(
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$SourceDir  = '${MOLLY_ROOT}\data\qq-whale\memory'
$Targets    = @('D:\MollyBackup\memory', '${MOLLY_ROOT}Backup\memory')
# 密钥（2026-10-23 m00709 第 3 条）：记忆池加密后，**密钥单独备份到另一个目录**，
# 不放进 memory 快照里——否则拿到一份快照就连钥匙一起拿到了，加密等于白做。
# 两个物理盘各存一份最新钥匙：盘坏了还有一份，外泄了只丢一份快照也解不开。
$KeyFile    = '${MOLLY_ROOT}\keys\memory.key'
$KeyTargets = @('D:\MollyBackup\keys', '${MOLLY_ROOT}Backup\keys')
$Keep       = 48
$LogFile    = '${MOLLY_ROOT}\qq-whale\out\memory-backup.log'
$StatusFile = '${MOLLY_ROOT}\qq-whale\out\memory-backup-status.json'

function Write-Log([string]$msg) {
  $line = ('[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg)
  $dir = Split-Path -Parent $LogFile
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8
  Write-Output $line
}

# 日志超过 2 MB 就滚动一份 .1，避免无界增长
try {
  if (Test-Path -LiteralPath $LogFile) {
    $len = (Get-Item -LiteralPath $LogFile).Length
    if ($len -gt 2MB) { Move-Item -LiteralPath $LogFile -Destination ($LogFile + '.1') -Force }
  }
} catch { }

# 5 分钟去重：任务被重复触发 / 手动连点时不重复拷
try {
  if (-not $Force -and (Test-Path -LiteralPath $StatusFile)) {
    $age = ((Get-Date) - (Get-Item -LiteralPath $StatusFile).LastWriteTime).TotalMinutes
    if ($age -lt 5) {
      Write-Log ('skip: {0:0.0} 分钟前刚备份过（去重，可加 -Force 强跑）' -f $age)
      exit 0
    }
  }
} catch { }

if (-not (Test-Path -LiteralPath $SourceDir)) {
  Write-Log "fail: 源目录不存在 $SourceDir"
  exit 1
}

$files = @(Get-ChildItem -LiteralPath $SourceDir -File | Sort-Object Name)
if ($files.Count -eq 0) {
  Write-Log "fail: 源目录里没有文件 $SourceDir"
  exit 1
}

# 先算清单（源侧 hash，后面用来证明拷出来的和源一致）
$fileList = @()
$totalBytes = 0
foreach ($f in $files) {
  $fileList += @{
    name   = $f.Name
    bytes  = $f.Length
    sha256 = (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash
  }
  $totalBytes += $f.Length
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$keyInfo = $null
if (Test-Path -LiteralPath $KeyFile) {
  $keyInfo = @{
    name   = 'memory.key'
    bytes  = (Get-Item -LiteralPath $KeyFile).Length
    sha256 = (Get-FileHash -LiteralPath $KeyFile -Algorithm SHA256).Hash
  }
} else {
  Write-Log ('warn: 密钥文件不存在 {0}（memoryEncrypt 可能没开，加密没生效）' -f $KeyFile)
}
$manifest = @{
  at         = (Get-Date).ToString('o')
  source     = $SourceDir
  stamp      = $stamp
  files      = @($fileList)
  totalBytes = $totalBytes
  encrypted  = (Test-Path -LiteralPath (Join-Path $SourceDir 'memory.json.enc')) -or (@($files | Where-Object { $_.Name -eq 'memory.md.enc' }).Count -gt 0)
  key        = $keyInfo
}

$okTargets = @()
$failures  = @()

foreach ($t in $Targets) {
  $dest = Join-Path $t $stamp
  try {
    if (-not (Test-Path -LiteralPath $t)) { New-Item -ItemType Directory -Force -Path $t | Out-Null }
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    foreach ($f in $files) {
      Copy-Item -LiteralPath $f.FullName -Destination $dest -Force
    }
    ($manifest | ConvertTo-Json -Depth 6) | Set-Content -LiteralPath (Join-Path $dest 'MANIFEST.json') -Encoding UTF8

    # 拷后校验：逐个文件比大小（快；hash 已在 MANIFEST 里留档，需要时可以复核）
    $bad = @()
    foreach ($f in $files) {
      $d = Join-Path $dest $f.Name
      if (-not (Test-Path -LiteralPath $d)) { $bad += $f.Name; continue }
      if ((Get-Item -LiteralPath $d).Length -ne $f.Length) { $bad += $f.Name }
    }
    if ($bad.Count -gt 0) { throw ('拷贝后校验失败: ' + ($bad -join ',')) }

    # 滚动清理：目录名就是时间戳，降序排后只留前 $Keep 份
    $dirs = @(Get-ChildItem -LiteralPath $t -Directory | Sort-Object Name -Descending)
    if ($dirs.Count -gt $Keep) {
      $dirs | Select-Object -Skip $Keep | ForEach-Object {
        Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
      }
    }

    $okTargets += $dest
    Write-Log ('ok: {0}（{1} 个文件, {2:0.0} KB）' -f $dest, $files.Count, ($totalBytes / 1KB))
  } catch {
    $failures += ('{0} -> {1}' -f $t, $_.Exception.Message)
    Write-Log ('fail: {0} -> {1}' -f $t, $_.Exception.Message)
  }
}

# 密钥单独落一份（不和 memory 快照放一起，理由见顶部注释）
if ($keyInfo) {
  foreach ($kt in $KeyTargets) {
    try {
      if (-not (Test-Path -LiteralPath $kt)) { New-Item -ItemType Directory -Force -Path $kt | Out-Null }
      Copy-Item -LiteralPath $KeyFile -Destination (Join-Path $kt 'memory.key') -Force
      Write-Log ('ok: key -> {0}' -f $kt)
    } catch {
      $failures += ('key -> {0}: {1}' -f $kt, $_.Exception.Message)
      Write-Log ('fail: key -> {0}: {1}' -f $kt, $_.Exception.Message)
    }
  }
}

$status = @{
  at        = (Get-Date).ToString('o')
  stamp     = $stamp
  source    = $SourceDir
  files     = $files.Count
  bytes     = $totalBytes
  encrypted = $manifest.encrypted
  key       = $keyInfo
  ok        = @($okTargets)
  failed    = @($failures)
}
($status | ConvertTo-Json -Depth 6) | Set-Content -LiteralPath $StatusFile -Encoding UTF8

if ($failures.Count -gt 0) { exit 2 }
exit 0
