using System.IO;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Effects;
using System.Windows.Controls;
using System.Windows.Media.Imaging;
using Microsoft.Win32;

namespace MollyDesktop;

/// <summary>
/// 自绘「桌面磨砂」：把当前壁纸按桌面布局铺到整块虚拟屏上、做一次高斯模糊，
/// 再按窗口所在的屏幕位置裁一块，作为窗口背景画出来。
///
/// 为什么不直接用 Win11 的系统亚克力（DWMWA_SYSTEMBACKDROP_TYPE = 3）：
/// 它确实会采样并模糊窗口背后的桌面，但材质本身自带约 0.6 的白色雾面，且染色不可调，
/// 结果无论如何调低页面面纱，壁纸都只剩一点影子 —— 用户的原话是「我想要相对于桌面的磨砂玻璃」，
/// 看不见桌面就不叫磨砂玻璃。自绘这条路可以自己定模糊半径和浓度，效果与微信那种「壁纸隐约可见」一致。
///
/// 代价：壁纸是静态的，所以只在启动时算一次全屏模糊图（1/4 分辨率渲染，毫秒级），
/// 之后窗口移动/缩放只是改 ImageBrush 的 Viewbox（不重算），没有掉帧也没有闪烁。
/// 壁纸读不到（纯色背景、动态壁纸、权限问题）时返回 null，调用方退回 DWM 路线。
/// </summary>
internal static class WallpaperBackdrop
{
    /// <summary>渲染倍率：1/4 分辨率足够，放大后反而更像真实的磨砂。</summary>
    private const double Scale = 0.25;

    private static ImageSource? _screen;
    private static bool _tried;

    public static ImageBrush? CreateBrush(Window window)
    {
        try
        {
            if (!_tried)
            {
                _tried = true;
                _screen = BuildScreen();
                WindowGlass.Log($"  wallpaper backdrop = {(_screen is null ? "unavailable" : "ready")}");
            }
            if (_screen is null) return null;

            var hwnd = new WindowInteropHelper(window).Handle;
            if (hwnd == IntPtr.Zero) return null;
            if (!GetWindowRect(hwnd, out var r)) return null;

            GetVirtualScreen(out int vx, out int vy, out _, out _);
            var box = new Rect(
                (r.Left - vx) * Scale,
                (r.Top - vy) * Scale,
                Math.Max(1, (r.Right - r.Left) * Scale),
                Math.Max(1, (r.Bottom - r.Top) * Scale));

            var brush = new ImageBrush(_screen)
            {
                Stretch = Stretch.Fill,
                ViewboxUnits = BrushMappingMode.Absolute,
                Viewbox = box,
                AlignmentX = AlignmentX.Left,
                AlignmentY = AlignmentY.Top,
                TileMode = TileMode.None,
            };
            brush.Freeze();
            return brush;
        }
        catch (Exception ex)
        {
            WindowGlass.Log($"  wallpaper backdrop failed: {ex.GetType().Name} {ex.Message}");
            return null;
        }
    }

    /// <summary>
    /// 给某一块**内容元素**（例如 44px 的标题条）单独做一支刷子。
    /// 不能用窗口那支：ImageBrush 的 Viewbox 是映射到「元素自身内容区」的，
    /// 拿整窗的 Viewbox 去铺 44px 高的 Border，会把整张壁纸压扁进那一条（放大到离谱），
    /// 于是标题条和页面永远对不上。这里按元素在屏幕上的真实矩形重算 Viewbox，就能 1:1 对齐。
    /// </summary>
    public static ImageBrush? CreateBrushFor(Window window, FrameworkElement element)
    {
        try
        {
            if (!_tried)
            {
                _tried = true;
                _screen = BuildScreen();
            }
            if (_screen is null || element is null) return null;
            if (element.ActualWidth < 1 || element.ActualHeight < 1) return null;

            var p0 = element.PointToScreen(new Point(0, 0));
            var p1 = element.PointToScreen(new Point(element.ActualWidth, element.ActualHeight));
            GetVirtualScreen(out int vx, out int vy, out _, out _);

            var box = new Rect(
                (p0.X - vx) * Scale,
                (p0.Y - vy) * Scale,
                Math.Max(1, (p1.X - p0.X) * Scale),
                Math.Max(1, (p1.Y - p0.Y) * Scale));

            WindowGlass.Log($"  titlebar brush: el={element.ActualWidth}x{element.ActualHeight} p0={p0.X},{p0.Y} p1={p1.X},{p1.Y} screen={(int)_screen.Width}x{(int)_screen.Height} box={box.X},{box.Y},{box.Width},{box.Height}");

            var brush = new ImageBrush(_screen)
            {
                Stretch = Stretch.Fill,
                ViewboxUnits = BrushMappingMode.Absolute,
                Viewbox = box,
                AlignmentX = AlignmentX.Left,
                AlignmentY = AlignmentY.Top,
                TileMode = TileMode.None,
            };
            brush.Freeze();
            return brush;
        }
        catch (Exception ex)
        {
            WindowGlass.Log($"  titlebar backdrop failed: {ex.GetType().Name} {ex.Message}");
            return null;
        }
    }

    private static ImageSource? BuildScreen()
    {
        var path = ReadWallpaperPath();
        if (string.IsNullOrEmpty(path) || !File.Exists(path)) return null;

        GetVirtualScreen(out _, out _, out int vw, out int vh);
        if (vw <= 0 || vh <= 0) return null;

        var bmp = new BitmapImage();
        bmp.BeginInit();
        bmp.CacheOption = BitmapCacheOption.OnLoad;
        bmp.CreateOptions = BitmapCreateOptions.IgnoreImageCache;
        bmp.UriSource = new Uri(path, UriKind.Absolute);
        bmp.EndInit();
        bmp.Freeze();

        double sw = vw * Scale, sh = vh * Scale;
        double iw = bmp.PixelWidth, ih = bmp.PixelHeight;
        if (iw < 1 || ih < 1) return null;

        var style = ReadWallpaperStyle();
        Rect dest;
        switch (style)
        {
            case 2: // 拉伸
                dest = new Rect(0, 0, sw, sh);
                break;
            case 6: // 适应（contain）
                { var k = Math.Min(sw / iw, sh / ih); dest = new Rect((sw - iw * k) / 2, (sh - ih * k) / 2, iw * k, ih * k); }
                break;
            case 0: // 居中（1:1 物理像素）
                dest = new Rect((sw - iw * Scale) / 2, (sh - ih * Scale) / 2, iw * Scale, ih * Scale);
                break;
            default: // 10 / 22 填充、跨屏：等比铺满（多屏细节差异用户基本看不出来）
                { var k = Math.Max(sw / iw, sh / ih); dest = new Rect((sw - iw * k) / 2, (sh - ih * k) / 2, iw * k, ih * k); }
                break;
        }

        var visual = new DrawingVisual();
        using (var dc = visual.RenderOpen())
        {
            dc.DrawRectangle(new SolidColorBrush(AverageColor(bmp)), null, new Rect(0, 0, sw, sh));
            dc.DrawImage(bmp, dest);
        }

        var sharp = new RenderTargetBitmap(
            Math.Max(1, (int)Math.Round(sw)), Math.Max(1, (int)Math.Round(sh)), 96, 96, PixelFormats.Pbgra32);
        sharp.Render(visual);

        // 1/4 分辨率 + 半径 15 ≈ 全分辨率 60px 的模糊：壁纸只留色块，不剩形状
        var blur = new Image
        {
            Source = sharp,
            Effect = new BlurEffect { Radius = 15, KernelType = KernelType.Gaussian, RenderingBias = RenderingBias.Performance },
        };
        blur.Measure(new Size(sw, sh));
        blur.Arrange(new Rect(0, 0, sw, sh));

        var blurred = new RenderTargetBitmap(
            Math.Max(1, (int)Math.Round(sw)), Math.Max(1, (int)Math.Round(sh)), 96, 96, PixelFormats.Pbgra32);
        blurred.Render(blur);
        blurred.Freeze();
        return blurred;
    }

    private static Color AverageColor(BitmapSource src)
    {
        try
        {
            var tiny = new TransformedBitmap(src, new ScaleTransform(
                1.0 / Math.Max(1, src.PixelWidth), 1.0 / Math.Max(1, src.PixelHeight)));
            var conv = new FormatConvertedBitmap(tiny, PixelFormats.Bgra32, null, 0);
            var px = new byte[4];
            conv.CopyPixels(px, 4, 0);
            return Color.FromRgb(px[2], px[1], px[0]);
        }
        catch
        {
            return Color.FromRgb(0xE9, 0xE6, 0xDD);
        }
    }

    private static string? ReadWallpaperPath()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(@"Control Panel\Desktop");
            var raw = key?.GetValue("WallPaper") as string;
            if (string.IsNullOrWhiteSpace(raw)) return null;
            return Environment.ExpandEnvironmentVariables(raw.Trim());
        }
        catch
        {
            return null;
        }
    }

    private static int ReadWallpaperStyle()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(@"Control Panel\Desktop");
            var style = key?.GetValue("WallpaperStyle") as string;
            return int.TryParse(style, out var v) ? v : 10;
        }
        catch
        {
            return 10;
        }
    }

    private static void GetVirtualScreen(out int x, out int y, out int w, out int h)
    {
        x = GetSystemMetrics(SmXVirtualScreen);
        y = GetSystemMetrics(SmYVirtualScreen);
        w = GetSystemMetrics(SmCxVirtualScreen);
        h = GetSystemMetrics(SmCyVirtualScreen);
    }

    private const int SmXVirtualScreen = 76;
    private const int SmYVirtualScreen = 77;
    private const int SmCxVirtualScreen = 78;
    private const int SmCyVirtualScreen = 79;

    [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
    private struct Rect32
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hwnd, out Rect32 rect);

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern int GetSystemMetrics(int index);
}
