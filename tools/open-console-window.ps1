#requires -Version 5.1
<#
  open-console-window.ps1 —— 桌面快捷方式的实际入口（无黑框）

  为什么需要这一层：
    直接把快捷方式指向 `cmd.exe /c console.cmd` + WindowStyle=7 时，cmd 以「最小化」
    启动，这个 show 状态会沿进程链传给 Edge，导致 `--app` 窗口一开出来就是最小化
    （实测：hwnd 位于 -32000,-32000、iconic=1，用户双击后看不到任何窗口）。
    所以改成：本脚本以隐藏方式跑 console.cmd（用户看不到命令行黑框），
    再自己开一个可见的 Edge --app 窗口。

  2026-10-19 修的一个真 bug：
    原来「已有窗口就直接前置」只按标题匹配，不看窗口是否真的在屏幕上。
    Edge 会留下 visible=0 / iconic=1 的残留窗口（标题仍是「Molly 控制台」，
    每次点还换一个 pid），于是脚本一直走「已有窗口，直接前置」，
    ShowWindow(SW_RESTORE) 之后用户屏幕上依然什么都没有。
    现在判据改成「必须可见 + 非最小化 + 尺寸合理 + 与任一显示器有交集」，
    不满足就当作没有窗口，重开一个。窗口用独立 user-data-dir，
    不会再和用户日常 Edge 的窗口混在一起。

  行为：
    0. 若已存在「屏幕上看得见」的 Molly 控制台窗口 → 还原并置前，exit 0。
    1. 否则 cmd /c console.cmd -NoOpen —— 复用启动器只做「探活 → 需要时拉起服务」，
       不让它开窗（它开的是默认 profile 的窗口，且可能被最小化）。
    2. 启动器跑完（体检表出完）后，本脚本用独立 profile 开 Edge --app 窗口。
    3. 轮询等待「屏幕内可见」的窗口（最多 -WaitSeconds 秒），SW_RESTORE + 置前。
    4. 全过程追加到 out\console-open.status.log（一行一个时间戳事件），出问题可追溯。

  参数：
    -ProjectRoot  默认取本脚本上一级目录（...\qq-whale）
    -WaitSeconds  等待窗口出现的上限，默认 25
    -LogDir       日志目录，默认 <ProjectRoot>\out
    -ForceNew     即使已有可见窗口也重新开一个（默认不）
#>
[CmdletBinding()]
param(
    [string]$ProjectRoot,
    [int]$WaitSeconds = 25,
    [string]$LogDir,
    [switch]$ForceNew
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
    $ProjectRoot = Split-Path -Parent $PSScriptRoot
}
if ([string]::IsNullOrWhiteSpace($LogDir)) {
    $LogDir = Join-Path $ProjectRoot 'out'
}
if (-not (Test-Path -LiteralPath $LogDir)) {
    New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
}

$ConsoleCmd = Join-Path $ProjectRoot 'console.cmd'
$OutLog = Join-Path $LogDir 'console-open.log'
$ErrLog = Join-Path $LogDir 'console-open.err.log'
$StatusLog = Join-Path $LogDir 'console-open.status.log'
$WindowTitle = 'Molly 控制台'
$ConsoleUrl = 'http://127.0.0.1:19392/'
$ProfileDir = Join-Path $LogDir 'edge-console-profile'

if (-not (Test-Path -LiteralPath $ConsoleCmd)) {
    Write-Error "找不到启动器：$ConsoleCmd"
    exit 2
}

function Note([string]$msg) {
    try {
        $line = (Get-Date -Format 'HH:mm:ss.fff') + '  ' + $msg + "`r`n"
        [System.IO.File]::AppendAllText($StatusLog, $line, [System.Text.Encoding]::UTF8)
    } catch { }
}

# ── Win32：找窗口 / 还原窗口 ───────────────────────────────
$sig = @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class MollyWin {
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
    public struct RECT { public int Left, Top, Right, Bottom; }
    public static List<IntPtr> Find(string title) {
        var res = new List<IntPtr>();
        EnumWindows(delegate(IntPtr h, IntPtr l) {
            var sb = new StringBuilder(512);
            GetWindowTextW(h, sb, 512);
            if (sb.ToString() == title) res.Add(h);
            return true;
        }, IntPtr.Zero);
        return res;
    }
    public static string Info(IntPtr h) {
        uint pid; GetWindowThreadProcessId(h, out pid);
        return string.Format("hwnd={0} pid={1} visible={2} iconic={3}",
            h.ToInt64(), pid, IsWindowVisible(h) ? 1 : 0, IsIconic(h) ? 1 : 0);
    }
    public static string RectOf(IntPtr h) {
        RECT r;
        if (!GetWindowRect(h, out r)) return "";
        return string.Format("{0},{1},{2},{3}", r.Left, r.Top, r.Right, r.Bottom);
    }
}
"@
Add-Type -TypeDefinition $sig -Language CSharp
Add-Type -AssemblyName System.Windows.Forms

function Restore-ConsoleWindow {
    param([IntPtr]$Handle)
    $before = [MollyWin]::Info($Handle)
    [void][MollyWin]::ShowWindow($Handle, 9)      # SW_RESTORE
    [void][MollyWin]::BringWindowToTop($Handle)
    [void][MollyWin]::SetForegroundWindow($Handle)
    Start-Sleep -Milliseconds 250
    $after = [MollyWin]::Info($Handle)
    Note ("窗口 $before -> $after")
    Write-Host "  窗口：$before -> $after"
    return $after
}

# 判据：可见 + 非最小化 + 尺寸像窗口 + 与任一显示器有交集
function Test-OnScreenWindow {
    param([IntPtr]$Handle)
    $info = [MollyWin]::Info($Handle)
    if ($info -notmatch 'visible=1') { return $false }
    if ($info -notmatch 'iconic=0') { return $false }
    $rect = [MollyWin]::RectOf($Handle)
    if ([string]::IsNullOrWhiteSpace($rect)) { return $false }
    $p = $rect.Split(',')
    if ($p.Count -lt 4) { return $false }
    $l = [int]$p[0]; $t = [int]$p[1]; $r = [int]$p[2]; $b = [int]$p[3]
    if (($r - $l) -lt 240 -or ($b - $t) -lt 180) { return $false }
    foreach ($scr in [System.Windows.Forms.Screen]::AllScreens) {
        $bd = $scr.Bounds
        if ($r -gt $bd.Left -and $l -lt $bd.Right -and $b -gt $bd.Top -and $t -lt $bd.Bottom) {
            return $true
        }
    }
    return $false
}

function Get-OnScreenConsoleWindows {
    $res = @()
    foreach ($h in [MollyWin]::Find($WindowTitle)) {
        if (Test-OnScreenWindow -Handle $h) { $res += $h }
    }
    return ,$res
}

function Find-Edge {
    $cands = @(
        (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
        (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe')
    )
    foreach ($c in $cands) {
        if ($c -and (Test-Path -LiteralPath $c)) { return $c }
    }
    return $null
}

function Open-ConsoleEdge {
    $edge = Find-Edge
    if (-not $edge) {
        Note '找不到 Edge（msedge.exe），无法开窗'
        Write-Host '  [找不到 Edge]'
        return $false
    }
    if (-not (Test-Path -LiteralPath $ProfileDir)) {
        New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null
    }
    $argList = @(
        ('--app=' + $ConsoleUrl),
        ('--user-data-dir=' + $ProfileDir),
        '--no-first-run',
        '--no-default-browser-check',
        '--window-size=1120,900'
    )
    try {
        $p = Start-Process -FilePath $edge -ArgumentList $argList -PassThru
        Note ('Edge --app 已拉起 pid=' + $p.Id + ' url=' + $ConsoleUrl)
        Write-Host ('  已开窗：Edge --app pid=' + $p.Id)
        return $true
    } catch {
        Note ('Edge 拉起失败：' + $_.Exception.Message)
        Write-Host ('  [Edge 拉起失败] ' + $_.Exception.Message)
        return $false
    }
}

function Show-ConsoleWindow {
    param([int]$TimeoutSeconds = 25)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        $live = Get-OnScreenConsoleWindows
        if ($live.Count -gt 0) {
            [void](Restore-ConsoleWindow -Handle $live[$live.Count - 1])
            return $true
        }
        Start-Sleep -Milliseconds 400
    }
    Note ("$TimeoutSeconds 秒内没等到屏幕内可见的「$WindowTitle」窗口")
    Write-Host "  [$TimeoutSeconds 秒内没等到可见的「$WindowTitle」窗口]"
    return $false
}

# ── 0. 已经有「屏幕上看得见」的窗口就直接前置（避免开出第二个）───
if (-not $ForceNew) {
    $existing = [MollyWin]::Find($WindowTitle)
    if ($existing -and $existing.Count -gt 0) {
        $live = Get-OnScreenConsoleWindows
        if ($live.Count -gt 0) {
            Note ('已有可见窗口 ' + $live.Count + ' 个，直接前置，不重复启动')
            Write-Host ('已有控制台窗口，直接前置（' + $live.Count + ' 个）')
            [void](Restore-ConsoleWindow -Handle $live[$live.Count - 1])
            exit 0
        }
        Note ('找到 ' + $existing.Count + ' 个标题匹配但不在屏幕上的残留窗口（hidden/最小化/离屏），忽略并重开')
        Write-Host ('发现 ' + $existing.Count + ' 个残留窗口但都不在屏幕上，重新开一个')
    }
}

# ── 1. 跑启动器（只探活/拉起服务，不开窗）──────────────────
$started = Get-Date
Note ('开始：以隐藏方式运行 console.cmd -NoOpen（ProjectRoot=' + $ProjectRoot + '）')
try {
    $argsLine = '/c ""' + $ConsoleCmd + ' -NoOpen""'
    $proc = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\cmd.exe') `
                          -ArgumentList $argsLine `
                          -WorkingDirectory $ProjectRoot `
                          -WindowStyle Hidden `
                          -RedirectStandardOutput $OutLog `
                          -RedirectStandardError $ErrLog `
                          -PassThru
    Note ('启动器 pid=' + $proc.Id)
    Write-Host ('启动器已拉起 pid=' + $proc.Id + '，等它跑完体检表 ...')
} catch {
    Note ('启动器拉起失败：' + $_.Exception.Message)
    Write-Host ('启动器拉起失败：' + $_.Exception.Message)
    exit 3
}

# 等启动器跑完（体检表出完它自己退出；最多 20 秒）
try {
    if (-not $proc.HasExited) { [void]$proc.WaitForExit(20000) }
} catch { }

# ── 2. 自己开窗（独立 profile，不会留下离屏残留）──────────────
if (-not (Get-OnScreenConsoleWindows).Count) {
    [void](Open-ConsoleEdge)
} else {
    Note '启动器已经开出了可见窗口，不再重复开'
}

# ── 3. 等窗口并还原 ───────────────────────────────────────
$ok = Show-ConsoleWindow -TimeoutSeconds $WaitSeconds

$tail = ''
try {
    if (Test-Path -LiteralPath $OutLog) {
        # 启动器输出是 UTF-8；PS 5.1 的 Get-Content 默认按 ANSI 读会乱码，这里显式指定 UTF-8
        $lines = [System.IO.File]::ReadAllLines($OutLog, [System.Text.Encoding]::UTF8)
        if ($lines.Count -gt 0) {
            $from = [Math]::Max(0, $lines.Count - 6)
            $tail = (($lines[$from..($lines.Count - 1)] | Where-Object { $_ -and $_.Trim() }) -join ' | ')
        }
    }
} catch { }

$elapsed = [int]((Get-Date) - $started).TotalSeconds
Note ('结束：耗时 ' + $elapsed + 's，窗口=' + $ok)
Write-Host ('耗时 ' + $elapsed + 's；启动器输出尾部：' + $tail)

if ($ok) { exit 0 } else { exit 1 }
