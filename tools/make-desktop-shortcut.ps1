#requires -Version 5.1
<#
  make-desktop-shortcut.ps1 —— 在桌面创建「Molly 控制台」快捷方式（幂等，可反复运行）

  双击快捷方式后的行为：
    cmd.exe /c "...\qq-whale\console.cmd"
      → tools\start-console.ps1：探活 19392 → 没起就拉起服务 → 轮询 /api/health
        → 用 Edge --app 开一个独立窗口（找不到 Edge 退回 Chrome / 默认浏览器）

  设计要点：
    * 桌面路径一律用 [Environment]::GetFolderPath('Desktop') 取，兼容 OneDrive 重定向；
    * 窗口样式 7（最小化），避免 cmd 黑框长时间停留；
    * 图标优先 console\molly.ico（Q 版鲸鱼），缺失时尝试用 Pillow 现场重建，再不行退回系统图标；
    * 重复运行只覆盖同一个 .lnk，不会产生「Molly 控制台 (2).lnk」。

  用法：
    powershell -ExecutionPolicy Bypass -File tools\make-desktop-shortcut.ps1
    powershell -ExecutionPolicy Bypass -File tools\make-desktop-shortcut.ps1 -Name 'Molly 控制台' -NoIconRebuild
#>
[CmdletBinding()]
param(
    [string]$Name = 'Molly 控制台',
    [switch]$NoIconRebuild
)

$ErrorActionPreference = 'Stop'

function Write-Step([string]$msg) { Write-Host ("  " + $msg) }

# ── 0. 路径解析 ─────────────────────────────────────────────
$Root = Split-Path -Parent $PSScriptRoot          # ...\qq-whale
$CmdPath = Join-Path $Root 'console.cmd'
$IconPath = Join-Path $Root (Join-Path 'console' 'molly.ico')
$SystemIcon = Join-Path $env:SystemRoot 'System32\imageres.dll'
$SystemIconArg = $SystemIcon + ',109'

Write-Host '══ Molly 控制台 · 桌面快捷方式 ══'

if (-not (Test-Path -LiteralPath $CmdPath)) {
    throw "找不到启动器：$CmdPath"
}

$Desktop = [Environment]::GetFolderPath('Desktop')
if ([string]::IsNullOrWhiteSpace($Desktop)) {
    $Desktop = Join-Path $env:USERPROFILE 'Desktop'
    Write-Step "GetFolderPath('Desktop') 返回空，回退到 $Desktop"
}
if (-not (Test-Path -LiteralPath $Desktop)) {
    throw "桌面目录不存在：$Desktop"
}
$LnkPath = Join-Path $Desktop ($Name + '.lnk')

Write-Step "项目根：$Root"
Write-Step "桌面：  $Desktop"
Write-Step "目标：  $LnkPath"

# ── 1. 图标：优先 molly.ico，缺失则尝试现场重建 ────────────
$IconLocation = $SystemIconArg
if (-not $NoIconRebuild -and -not (Test-Path -LiteralPath $IconPath)) {
    $Py = 'D:\Python3.10\Python\Python310\python.exe'
    $PngCandidates = @()
    $PngCandidates += (Join-Path $env:USERPROFILE '.dsh\profiles\desktop\node_modules\@yunxii\dsh-client-ui-skin-maid-whale-webui\assets\pet\01-idle.png')
    try {
        $found = Get-ChildItem -Path (Join-Path $env:USERPROFILE '.dsh\profiles\*\node_modules\@yunxii\*\assets\pet\01-idle.png') -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($found) { $PngCandidates += $found.FullName }
    } catch { }

    $Png = $PngCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
    if ($Png -and (Test-Path -LiteralPath $Py)) {
        Write-Step "molly.ico 不存在，尝试用 Pillow 重建（源：$Png）"
        $PyCode = @'
import sys
from PIL import Image
src, dst = sys.argv[1], sys.argv[2]
sizes = [16, 32, 48, 64, 128, 256]
im = Image.open(src).convert('RGBA')
side = max(im.size)
sq = Image.new('RGBA', (side, side), (0, 0, 0, 0))
sq.paste(im, ((side - im.width) // 2, (side - im.height) // 2), im)
master_side = max(sizes + [side])
master = sq.resize((master_side, master_side), Image.LANCZOS)
master.save(dst, format='ICO', sizes=[(s, s) for s in sizes])
print('ico ok: %s (%d bytes)' % (dst, len(open(dst, 'rb').read())))
'@
        try {
            $out = & $Py -c $PyCode $Png $IconPath 2>&1
            Write-Step ($out -join ' ')
        } catch {
            Write-Warning "图标重建失败（不影响快捷方式）：$($_.Exception.Message)"
        }
    } else {
        Write-Step '未找到源图或 Python，跳过图标重建'
    }
}

if (Test-Path -LiteralPath $IconPath) {
    $IconLocation = $IconPath + ',0'
}
Write-Step "图标：  $IconLocation"

# ── 2. 创建 / 覆盖快捷方式 ─────────────────────────────────
# 默认走「无黑框包装器」：powershell.exe -WindowStyle Hidden -File tools\open-console-window.ps1
#   为什么不直接用 cmd.exe /c console.cmd + WindowStyle=7：
#   实测 cmd 以最小化启动时，这个 show 状态会传给 Edge，--app 窗口一开出来就是最小化
#   （hwnd 位于 -32000,-32000、iconic=1），用户双击后看不到窗口。
#   包装器以隐藏方式跑同一个启动器，再把窗口 SW_RESTORE 置前。
$WrapperPath = Join-Path $Root (Join-Path 'tools' 'open-console-window.ps1')
$PowerShellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

if (Test-Path -LiteralPath $WrapperPath) {
    $TargetPath = $PowerShellExe
    $Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $WrapperPath + '"'
    $Mode = 'wrapper（无黑框，开窗后自动置前）'
} else {
    $TargetPath = Join-Path $env:SystemRoot 'System32\cmd.exe'
    $Arguments = '/c ""' + $CmdPath + '""'
    $Mode = 'legacy cmd（警告：Edge 窗口可能继承最小化状态）'
}

$Shell = New-Object -ComObject WScript.Shell
$Shortcut = $Shell.CreateShortcut($LnkPath)
$Shortcut.TargetPath = $TargetPath
$Shortcut.Arguments = $Arguments
$Shortcut.WorkingDirectory = $Root
$Shortcut.WindowStyle = 7                # 7 = 最小化
$Shortcut.Description = 'Molly 控制台 — 双击打开'
$Shortcut.IconLocation = $IconLocation
$Shortcut.Save()

# ── 3. 读回校验（以磁盘上的 .lnk 为准，而不是内存对象）────
$Verify = $Shell.CreateShortcut($LnkPath)
$Item = Get-Item -LiteralPath $LnkPath

Write-Host ''
Write-Host '── 快捷方式已就绪 ──'
Write-Step ("路径        " + $LnkPath)
Write-Step ("字节数      " + $Item.Length + " B")
Write-Step ("启动方式    " + $Mode)
Write-Step ("TargetPath  " + $Verify.TargetPath)
Write-Step ("Arguments   " + $Verify.Arguments)
Write-Step ("WorkDir     " + $Verify.WorkingDirectory)
Write-Step ("Icon        " + $Verify.IconLocation)
Write-Step ("WindowStyle " + $Verify.WindowStyle + "（7=最小化）")
Write-Step ("Description " + $Verify.Description)

# ── 4. 幂等性自检：不该出现「(2)」副本 ────────────────────
$Dupes = @(Get-ChildItem -LiteralPath $Desktop -Filter ($Name + ' (*).lnk') -ErrorAction SilentlyContinue)
if ($Dupes.Count -gt 0) {
    Write-Warning ("发现同名副本 " + $Dupes.Count + " 个，建议手动删除：" + (($Dupes | ForEach-Object { $_.Name }) -join '、'))
} else {
    Write-Step '副本检查   无「(2)」类副本'
}

Write-Host ''
Write-Host '完成：双击桌面上的「' -NoNewline
Write-Host $Name -NoNewline
Write-Host '」即可打开控制台（无黑框残留，Edge 独立窗口）。'
exit 0
