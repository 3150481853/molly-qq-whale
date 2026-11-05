using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;

namespace MollyDesktop;

/// <summary>
/// 窗口「真实磨砂玻璃」的原生调用集合。
/// 只碰 user32 / dwmapi，不引入任何 NuGet 依赖。
///
/// 为什么必须由窗口来做：页面里的 backdrop-filter 背后是 WebView2 的合成表面，不是桌面，
/// 所以永远看不到真的磨砂。真正的磨砂是 DWM 把窗口背后的桌面壁纸模糊后画在客户区下面，
/// 页面（和标题条）只有变成透明，才看得见它。
///
/// 路线（运行时可用环境变量 MOLLY_GLASS_ROUTE 覆盖，仅用于实测对比，不写进配置）：
///   acrylic  ACCENT_POLICY = 4（传统亚克力，Win10 1803+）
///   blur     ACCENT_POLICY = 3（旧模糊）
///   extend   DwmExtendFrameIntoClientArea(-1)
///   mica     DWMWA_SYSTEMBACKDROP_TYPE = 2（Win11 22H2+，Mica）
///   acrylic2 DWMWA_SYSTEMBACKDROP_TYPE = 3（Win11 22H2+，系统亚克力）—— 本机唯一真正生效的一档
///   desktop  只把表面置透明（排查用）
///   none     完全不透（回退暖纸面）
/// </summary>
internal enum GlassRoute
{
    Acrylic,
    Blur,
    ExtendFrame,
    Mica,
    AcrylicBackdrop,

    /// <summary>自绘壁纸磨砂（见 WallpaperBackdrop.cs）：自己采样壁纸并模糊，不依赖 DWM 材质。</summary>
    Wallpaper,

    /// <summary>只做透明，不做任何 DWM 材质（用来判断页面本身有没有挡住）。</summary>
    Desktop,

    /// <summary>彻底关闭玻璃，退回暖纸面。</summary>
    None,
}

internal static class WindowGlass
{
    /// <summary>默认路线：Win11 系统亚克力。实测只有它真的采样并模糊了桌面壁纸。</summary>
    public const GlassRoute DefaultRoute = GlassRoute.Wallpaper;

    /// <summary>传统 ACCENT_POLICY 路线的染色（ARGB）。实测本机该组 API 返回成功但画面纯白，仅留作兼容。</summary>
    public const uint TintArgb = 0xCCF8F3EA;

    /// <summary>WPF 窗口背景纱（ARGB）。玻璃模式下必须接近透明，否则会把 DWM 的磨砂整个盖死。</summary>
    public const uint VeilArgb = 0x40F8F3EA;

    /// <summary>
    /// 自绘标题条的纱：0x6B ≈ 42%，和页面 .app 的面纱（--v3-veil: rgba(252,251,248,.42)）一模一样。
    /// 两边不一致，就会在标题条下沿看到一道横贯窗口的色阶断层。
    /// </summary>
    public const uint TitleBarVeilArgb = 0x6BFCFBF8;

    public static uint ResolveVeil() => ParseArgb("MOLLY_VEIL") ?? VeilArgb;

    public static System.Drawing.Color ToDrawingColor(uint argb) => System.Drawing.Color.FromArgb(
        (int)((argb >> 24) & 0xFF),
        (int)((argb >> 16) & 0xFF),
        (int)((argb >> 8) & 0xFF),
        (int)(argb & 0xFF));

    public static Color ToMediaColor(uint argb) => Color.FromArgb(
        (byte)((argb >> 24) & 0xFF),
        (byte)((argb >> 16) & 0xFF),
        (byte)((argb >> 8) & 0xFF),
        (byte)(argb & 0xFF));

    public static uint ResolveTint() => ParseArgb("MOLLY_GLASS_TINT") ?? TintArgb;

    private static uint? ParseArgb(string name)
    {
        var raw = Environment.GetEnvironmentVariable(name);
        if (string.IsNullOrWhiteSpace(raw)) return null;
        var text = raw.Trim();
        if (text.StartsWith("0x", StringComparison.OrdinalIgnoreCase)) text = text.Substring(2);
        if (text.Length == 6) text = "FF" + text;
        return uint.TryParse(text, System.Globalization.NumberStyles.HexNumber,
            System.Globalization.CultureInfo.InvariantCulture, out var parsed)
            ? parsed
            : null;
    }

    // WindowCompositionAttribute / DWM 常量
    private const int WcaAccentPolicy = 19;
    private const int AccentEnableBlurBehind = 3;
    private const int AccentEnableAcrylicBlurBehind = 4;
    private const int DwmwaUseImmersiveDarkMode = 20;
    private const int DwmwaWindowCornerPreference = 33;
    private const int DwmwaBorderColor = 34;
    private const int DwmwaSystemBackdropType = 38;

    /// <summary>圆角策略：DWMWCP_ROUND = 2；最大化时用 DO_NOT_ROUND（1），否则贴边会露白角。</summary>
    public const int DwmwcpDoNotRound = 1;
    public const int DwmwcpRound = 2;

    /// <summary>DWMWA_COLOR_NONE：去掉系统那圈 1px 描边。</summary>
    public const uint DwmColorNone = 0xFFFFFFFE;

    public static GlassRoute ResolveRoute()
    {
        var raw = Environment.GetEnvironmentVariable("MOLLY_GLASS_ROUTE");
        if (!string.IsNullOrWhiteSpace(raw) &&
            Enum.TryParse<GlassRoute>(raw.Trim(), ignoreCase: true, out var parsed))
        {
            return parsed;
        }
        return DefaultRoute;
    }

    /// <summary>
    /// 给窗口贴上玻璃。resetBackdrop 用于状态切换后重置材质（不要每次状态变化都重贴，会把 DWM 材料打掉）。
    /// </summary>
    public static bool Apply(Window window, GlassRoute route, uint tintArgb, bool resetBackdrop = false)
    {
        var hwnd = new WindowInteropHelper(window).Handle;
        if (hwnd == IntPtr.Zero) return false;

        Log($"Apply route={route} tint=0x{tintArgb:X8} hwnd=0x{hwnd.ToInt64():X} state={window.WindowState}");
        Log($"  corner={SetCornerPreference(hwnd, window.WindowState == WindowState.Maximized ? DwmwcpDoNotRound : DwmwcpRound)} border={SetBorderColor(hwnd, DwmColorNone)}");

        // 关键：WPF 的 HwndSource 默认用不透明白色填自己的合成表面，DWM 画在窗口底下的磨砂
        // 会被这层白整个盖住（实测只设 ACCENT_POLICY 时窗口始终纯白，四个角一丝壁纸都透不出来）。
        // 所以玻璃路线都必须先把合成表面底色改成全透明。

        switch (route)
        {
            case GlassRoute.Acrylic:
                MakeSurfaceTransparent(window);
                return LogResult("acrylic", TryAccent(hwnd, AccentEnableAcrylicBlurBehind, tintArgb));

            case GlassRoute.Blur:
                // ACCENT_ENABLE_BLURBEHIND 不认 alpha 的 tint，很多显卡会直接忽略渐变。
                MakeSurfaceTransparent(window);
                return LogResult("blur", TryAccent(hwnd, AccentEnableBlurBehind, tintArgb));

            case GlassRoute.ExtendFrame:
                // 只有在 WindowChrome.GlassFrameThickness = -1 时才真的有模糊。
                MakeSurfaceTransparent(window);
                return LogResult("extend", ExtendFrameIntoClientArea(hwnd));

            case GlassRoute.Mica:
                if (resetBackdrop) { LogResult("mica-reset", TrySystemBackdrop(hwnd, 0)); }
                LogResult("mica-backdrop", TrySystemBackdrop(hwnd, 2));
                return MakeSurfaceTransparent(window);

            case GlassRoute.AcrylicBackdrop:
                if (resetBackdrop) { LogResult("acrylic2-reset", TrySystemBackdrop(hwnd, 0)); }
                LogResult("acrylic2-backdrop", TrySystemBackdrop(hwnd, 3));
                return MakeSurfaceTransparent(window);

            case GlassRoute.Desktop:
                return true;

            default:
                return false;
        }
    }

    private static bool LogResult(string label, bool ok)
    {
        Log($"  {label}={(ok ? "ok" : "FAILED")} lastError={Marshal.GetLastWin32Error()}");
        return ok;
    }

    /// <summary>设置 MOLLY_GLASS_LOG 后，把每一步的原生调用结果写成可对照的日志。</summary>
    internal static void Log(string message)
    {
        var path = Environment.GetEnvironmentVariable("MOLLY_GLASS_LOG");
        if (string.IsNullOrWhiteSpace(path)) return;
        try
        {
            System.IO.File.AppendAllText(path, $"{DateTime.Now:HH:mm:ss.fff} {message}\r\n");
        }
        catch
        {
            // 日志失败不能影响窗口
        }
    }

    /// <summary>最大化 / 还原后只更新圆角（重贴材质会把玻璃打掉，整窗变成不透明）。</summary>
    public static void UpdateRoundCorners(Window window)
    {
        var hwnd = new WindowInteropHelper(window).Handle;
        if (hwnd == IntPtr.Zero) return;
        SetCornerPreference(hwnd, window.WindowState == WindowState.Maximized ? DwmwcpDoNotRound : DwmwcpRound);
    }

    private static uint ArgbToAbgr(uint argb)
    {
        uint a = (argb >> 24) & 0xFF;
        uint r = (argb >> 16) & 0xFF;
        uint g = (argb >> 8) & 0xFF;
        uint b = argb & 0xFF;
        return (a << 24) | (b << 16) | (g << 8) | r;
    }

    private static bool TryAccent(IntPtr hwnd, int state, uint tintArgb)
    {
        var accent = new AccentPolicy
        {
            AccentState = state,
            AccentFlags = 0,
            GradientColor = ArgbToAbgr(tintArgb),
            AnimationId = 0,
        };

        int size = Marshal.SizeOf<AccentPolicy>();
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(accent, buffer, false);
            var data = new WindowCompositionAttributeData
            {
                Attribute = WcaAccentPolicy,
                Data = buffer,
                SizeOfData = size,
            };
            return SetWindowCompositionAttribute(hwnd, ref data);
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static bool ExtendFrameIntoClientArea(IntPtr hwnd)
    {
        var margins = new Margins { Left = -1, Right = -1, Top = -1, Bottom = -1 };
        return DwmExtendFrameIntoClientArea(hwnd, ref margins) == 0;
    }

    private static bool TrySystemBackdrop(IntPtr hwnd, int type)
    {
        int value = type;
        // Win11 22H2+ 才有 DWMWA_SYSTEMBACKDROP_TYPE；老系统返回 E_INVALIDARG。
        int hr = DwmSetWindowAttribute(hwnd, DwmwaSystemBackdropType, ref value, sizeof(int));
        return hr == 0;
    }

    /// <summary>把 WPF 合成表面置为透明，DWM 的磨砂才有机会透到客户区。</summary>
    public static bool MakeSurfaceTransparent(Window window)
    {
        var hwnd = new WindowInteropHelper(window).Handle;
        if (hwnd == IntPtr.Zero) return false;
        var source = HwndSource.FromHwnd(hwnd);
        if (source?.CompositionTarget is null) return false;
        source.CompositionTarget.BackgroundColor = Colors.Transparent;
        return true;
    }

    private static bool SetCornerPreference(IntPtr hwnd, int preference)
    {
        int value = preference;
        return DwmSetWindowAttribute(hwnd, DwmwaWindowCornerPreference, ref value, sizeof(int)) == 0;
    }

    private static bool SetBorderColor(IntPtr hwnd, uint color)
    {
        uint value = color;
        return DwmSetWindowAttribute(hwnd, DwmwaBorderColor, ref value, sizeof(uint)) == 0;
    }

    /// <summary>避免系统把浅色玻璃画成深灰（深色模式下 DWM 会自己改色）。</summary>
    public static void ForceLightMode(IntPtr hwnd)
    {
        int off = 0;
        DwmSetWindowAttribute(hwnd, DwmwaUseImmersiveDarkMode, ref off, sizeof(int));
    }

    // ---- P/Invoke ----

    [StructLayout(LayoutKind.Sequential)]
    private struct AccentPolicy
    {
        public int AccentState;
        public int AccentFlags;
        public uint GradientColor;
        public int AnimationId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct WindowCompositionAttributeData
    {
        public int Attribute;
        public IntPtr Data;
        public int SizeOfData;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Margins
    {
        public int Left;
        public int Right;
        public int Top;
        public int Bottom;
    }

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetWindowCompositionAttribute(IntPtr hwnd, ref WindowCompositionAttributeData data);

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref uint value, int size);

    [DllImport("dwmapi.dll")]
    private static extern int DwmExtendFrameIntoClientArea(IntPtr hwnd, ref Margins margins);
}
