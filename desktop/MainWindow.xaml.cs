using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Text.Json;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Threading;
using Microsoft.Web.WebView2.Core;

namespace MollyDesktop;

public partial class MainWindow : Window
{
    /// <summary>自绘标题条高度（DIP）。XAML 里 RowDefinition 的初始值必须与它一致。</summary>
    public const double TitleBarHeight = 44;

    private const int StartupTimeoutSeconds = 35;
    private static readonly string[] TrustedLoopbackHosts = { "127.0.0.1", "localhost", "::1" };
    private readonly string _exeDirectory = AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
    private readonly string _dataDirectory = ResolveDataDirectory();
    private readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(4) };
    private readonly string _consolePath;
    private readonly string _configPath;
    /// <summary>后端所在目录：优先本程序目录；桌面上单独复制的 Molly.exe 没有后端陪着，就退回上次记住的安装目录。</summary>
    private readonly string _backendDirectory;
    private ConsoleConfig _config = new();
    private Process? _ownedBackend;
    private CancellationTokenSource? _connectionAttempt;
    private bool _webReady;
    private bool _allowClose;
    private bool _shuttingDown;
    private string _diagnostics = "尚未开始连接。";

    /// <summary>本次运行实际采用的玻璃路线（可由 MOLLY_GLASS_ROUTE 覆盖，用于逐条实测）。</summary>
    private GlassRoute _glassRoute = GlassRoute.None;

    /// <summary>true 表示当前用自绘壁纸磨砂（窗口移动/缩放时要重新裁切 Viewbox）。</summary>
    private bool _selfPainted;

    public MainWindow()
    {
        // 2026-11-05：主人把 Molly.exe 复制到桌面单独启动，同目录没有 molly-console.exe 和 console\，
        // 于是只看到「未找到 Molly 后端」。这里先看本程序目录，再看上次运行时记下的安装目录。
        var localConsole = Path.Combine(_exeDirectory, "molly-console.exe");
        var remembered = File.Exists(localConsole) ? null : ReadInstallPointer();
        _backendDirectory = remembered ?? _exeDirectory;
        _consolePath = Path.Combine(_backendDirectory, "molly-console.exe");
        _configPath = Path.Combine(_backendDirectory, "console.json");
        InitializeComponent();
        TitleBarRow.Height = new GridLength(TitleBarHeight);
        _glassRoute = WindowGlass.ResolveRoute();
        FitToScreen();
        Loaded += async (_, _) =>
        {
            FitToScreen(); // 显示后再校准一次，规避多显示器/DPI 下的居中偏移
            LocationChanged += (_, _) => RefreshBackdrop();
            SizeChanged += (_, _) => { RefreshBackdrop(); UpdateSidebarVeil(); };
            ApplyGlass();  // 窗口真正可见后再上玻璃，避免在 SetWindowPos 之前被 DWM 丢掉
            await ConnectAsync();
        };
    }

    // ── 无系统标题栏：玻璃、圆角、拖拽、三按钮 ───────────────────────────────

    /// <summary>
    /// WebView2 的 user data folder 不能被两个进程同时占用，实测实例要用 MOLLY_DESKTOP_DATA
    /// 指到隔离目录，免得跟正在运行的生产实例抢 EBWebView 的锁。生产环境不设该变量。
    /// </summary>
    private static string ResolveDataDirectory()
    {
        var custom = Environment.GetEnvironmentVariable("MOLLY_DESKTOP_DATA");
        if (!string.IsNullOrWhiteSpace(custom)) return custom;
        return Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Molly", "Desktop");
    }

    private void ApplyGlass(bool resetBackdrop = false)
    {
        if (_glassRoute == GlassRoute.None)
        {
            // 关掉磨砂：整窗回到暖纸面（标题条不再单独上纱）。
            _selfPainted = false;
            Background = new SolidColorBrush(Color.FromRgb(0xFB, 0xFB, 0xFA));
            TitleBarBackdrop.Background = null;
            TitleBar.Background = Brushes.Transparent;
            UpdateSidebarVeil();
            return;
        }

        // 优先走自绘壁纸磨砂：DWM 系统亚克力自带约 0.6 白雾且染色不可调，壁纸只剩影子，
        // 达不到「相对于桌面的磨砂玻璃」。自绘这一层可以自己决定模糊强度与浓度。
        if (_glassRoute == GlassRoute.Wallpaper)
        {
            var painted = WallpaperBackdrop.CreateBrush(this);
            if (painted is not null)
            {
                _selfPainted = true;
                Background = painted;
                // 标题条是 WindowChrome 的标题区，DWM 会在它后面贴自己的材料，
                // 窗口 Background 在那里看不到 —— 所以把同一张图当「内容」再画一遍，
                // 两段就共用一张底图；纱由 TitleBarVeil 那层出（.34，与页面 .app 同浓）。
                var titleBrush = WallpaperBackdrop.CreateBrushFor(this, TitleBarBackdrop);
                if (titleBrush is not null) TitleBarBackdrop.Background = titleBrush;
                else WindowGlass.Log("  titlebar brush = null (element not laid out yet)");
                TitleBar.Background = Brushes.Transparent;
                UpdateSidebarVeil();
                return;
            }
            // 壁纸读不到（纯色/动态壁纸）：静默回退到系统亚克力。
            WindowGlass.Log("  wallpaper unavailable -> fallback to acrylic backdrop");
        }

        _selfPainted = false;
        TitleBarBackdrop.Background = null;
        try
        {
            // 窗口背景保持全透明：DWM 亚克力本身就是可见的底，页面那层 .58 面纱由
            // console.css 铺（若在这里再铺一层，WebView2 之上会叠成 0.82，壁纸就没了）。
            Background = Brushes.Transparent;

            // 标题条那 44px 不在页面里，得自己补上与页面同浓的一层纱，否则标题条＝
            // 纯玻璃、页面＝玻璃+纱，中间一道横向色阶断层（用户实测点名的「分界线」）。
            TitleBar.Background = new SolidColorBrush(
                WindowGlass.ToMediaColor(WindowGlass.TitleBarVeilArgb));
            UpdateSidebarVeil();

            WindowGlass.Apply(this, _glassRoute, WindowGlass.ResolveTint(), resetBackdrop);
        }
        catch (Exception ex)
        {
            // 玻璃是装饰层，任何失败都不能拖垮外壳本身，但要留下可诊断的记录。
            _diagnostics += $"玻璃效果应用失败（{_glassRoute}）：{ex.Message}\r\n";
        }
    }

    private void Window_SourceInitialized(object? sender, EventArgs e) => ApplyGlass();

    /// <summary>自绘磨砂时，窗口一动就要按新的屏幕位置重新裁壁纸；只换 Viewbox，不重算模糊。</summary>
    /// <summary>
    /// 标题条左侧那层"侧栏白纱"只在侧栏真的显示时才补。
    /// 窗口宽度不足 900 DIP 时控制台会收起侧栏（console.css 的 900px 断点），
    /// 这时再在标题条左段铺 236px 白纱，就会凭空多出一条浅色竖带。
    /// </summary>
    private void UpdateSidebarVeil()
    {
        var sidebarVisible = _glassRoute != GlassRoute.None && ActualWidth >= 900;
        SidebarVeil.Visibility = sidebarVisible ? Visibility.Visible : Visibility.Collapsed;
    }
    private void RefreshBackdrop()
    {
        if (!_selfPainted) return;
        var painted = WallpaperBackdrop.CreateBrush(this);
        if (painted is not null)
        {
            Background = painted;
            var tb = WallpaperBackdrop.CreateBrushFor(this, TitleBarBackdrop);
            if (tb is not null) TitleBarBackdrop.Background = tb;
            else WindowGlass.Log("  titlebar brush (refresh) = null");
        }
    }

    private void Window_StateChanged(object? sender, EventArgs e)
    {
        // 最大化时不要圆角（贴边），还原时再补上；同时把字形切到「还原」。
        bool maximized = WindowState == WindowState.Maximized;
        MaximizeGlyph.Text = maximized ? "\uE923" : "\uE922";
        MaximizeButton.ToolTip = maximized ? "还原" : "最大化";
        try { WindowGlass.UpdateRoundCorners(this); } catch { /* 圆角失败不影响使用 */ }
        // 注意：这里【不要】重新 Apply 玻璃。实测在 Win11 23H2 上，第一次 Apply 之后
        // 再调一次 DwmSetWindowAttribute(SYSTEMBACKDROP_TYPE)（哪怕先清成 NONE 再设回 3）
        // 都会让整窗变成不透明的暖白 #FBFBFA —— DWM 只在窗口首次显示时贴材料，
        // 重设反而把材料打掉。最大化/还原本身不会丢材料，圆角单独更新就够了。
        WindowGlass.Log($"  state-changed -> {WindowState}（不重贴玻璃）");
    }

    private void TitleBar_MouseLeftButtonDown(object sender, MouseButtonEventArgs e)
    {
        if (e.ChangedButton != MouseButton.Left) return;
        if (e.ClickCount == 2)
        {
            ToggleMaximize();
            return;
        }
        if (e.ButtonState != MouseButtonState.Pressed) return;
        try { DragMove(); }
        catch (InvalidOperationException) { /* 极端情况下鼠标已松开，忽略 */ }
    }

    private void ToggleMaximize() =>
        WindowState = WindowState == WindowState.Maximized ? WindowState.Normal : WindowState.Maximized;

    private void Minimize_Click(object sender, RoutedEventArgs e) => WindowState = WindowState.Minimized;

    private void Maximize_Click(object sender, RoutedEventArgs e) => ToggleMaximize();

    // 注意：这里走的是同一个 Window_Closing 流程（先弹三选一对话框），不绕过既有语义。
    private void Close_Click(object sender, RoutedEventArgs e) => Close();

    // 诊断用：只有设置了 MOLLY_GLASS_LOG 才会写文件，平时零开销。
    // 用来回答「WindowChrome GlassFrameThickness=-1 之后按钮还能不能收到鼠标进入/离开」。
    private void CaptionButton_MouseEnter(object sender, MouseEventArgs e)
    {
        var name = (sender as FrameworkElement)?.Name ?? "?";
        WindowGlass.Log($"caption-hover enter {name}");
    }

    private void CaptionButton_MouseLeave(object sender, MouseEventArgs e)
    {
        var name = (sender as FrameworkElement)?.Name ?? "?";
        WindowGlass.Log($"caption-hover leave {name}");
    }

    // 多显示器 + 150% 缩放下，按物理工作区换算成 DIP 再收敛，避免窗口超出屏幕被裁。
    private void FitToScreen()
    {
        WindowStartupLocation = WindowStartupLocation.Manual;
        var handle = new WindowInteropHelper(this).Handle;
        if (handle == IntPtr.Zero)
        {
            Width = 1100;
            Height = 760;
            return;
        }

        var monitor = MonitorFromWindow(handle, MonitorDefaultToNearest);
        var info = new MonitorInfo { Size = Marshal.SizeOf<MonitorInfo>() };
        if (!GetMonitorInfo(monitor, ref info))
        {
            Width = Math.Min(1100, SystemParameters.WorkArea.Width * 0.9);
            Height = Math.Min(760, SystemParameters.WorkArea.Height * 0.9);
            return;
        }

        var dpi = VisualTreeHelper.GetDpi(this);
        var workWidth = info.Work.Right - info.Work.Left;
        var workHeight = info.Work.Bottom - info.Work.Top;
        // 直接用物理像素定位，绕开 DIP/缩放换算差异。
        var targetWidth = (int)Math.Min(1360 * dpi.DpiScaleX, workWidth * 0.92);
        var targetHeight = (int)Math.Min(880 * dpi.DpiScaleY, workHeight * 0.92);
        var left = info.Work.Left + Math.Max(0, (workWidth - targetWidth) / 2);
        var top = info.Work.Top + Math.Max(0, (workHeight - targetHeight) / 2);
        SetWindowPos(handle, IntPtr.Zero, left, top, targetWidth, targetHeight,
            SwpNoZOrder | SwpNoActivate | SwpNoOwnerZOrder);
    }

    private async Task ConnectAsync()
    {
        if (_shuttingDown) return;
        _connectionAttempt?.Cancel();
        _connectionAttempt?.Dispose();
        _connectionAttempt = new CancellationTokenSource();
        var cancellationToken = _connectionAttempt.Token;
        StatusPanel.Visibility = Visibility.Visible;
        WebView.Visibility = Visibility.Collapsed;
        ActionPanel.Visibility = Visibility.Collapsed;
        SetStatus("正在连接 Molly 控制台…", "读取本地配置并检查已有后端。");
        _config = ReadConfig();
        var baseUri = new UriBuilder(Uri.UriSchemeHttp, _config.Host, _config.Port).Uri;
        _diagnostics = $"时间：{DateTime.Now:yyyy-MM-dd HH:mm:ss}\r\n地址：{baseUri}\r\n配置：{_configPath}\r\n后端目录：{_backendDirectory}\r\nWebView 数据：{_dataDirectory}\r\n";

        try
        {
            await EnsureWebViewAsync(cancellationToken);
            var health = await CheckHealthAsync(baseUri, cancellationToken);
            if (!health.Ok)
            {
                SetStatus("正在启动 Molly 后端…", "仅启动随本应用提供的控制台，不打开浏览器。");
                if (!StartBackend()) return;
                health = await WaitForBackendAsync(baseUri, cancellationToken);
            }
            if (!health.Ok)
            {
                ShowError("暂时无法连接 Molly", health.Error);
                return;
            }
            if (cancellationToken.IsCancellationRequested || _shuttingDown) return;
            _diagnostics += $"后端：健康检查通过，版本 {health.Version}\r\n";
            SetStatus("正在打开 Molly…", $"控制台 {health.Version} 已就绪。");
            WebView.CoreWebView2.Navigate(ShellUri(baseUri).ToString());
        }
        catch (OperationCanceledException) { }
        catch (Exception ex)
        {
            ShowError("Molly 未能启动", FriendlyError(ex));
        }
    }

    private async Task EnsureWebViewAsync(CancellationToken cancellationToken)
    {
        if (_webReady) return;
        Directory.CreateDirectory(_dataDirectory);
        // msWebView2EnableDraggableRegions：允许网页用 CSS app-region:drag 扩展可拖拽区（备用能力）。
        var options = new CoreWebView2EnvironmentOptions(
            additionalBrowserArguments: "--enable-features=msWebView2EnableDraggableRegions");
        var environment = await CoreWebView2Environment.CreateAsync(userDataFolder: _dataDirectory, options: options);
        await WebView.EnsureCoreWebView2Async(environment);
        cancellationToken.ThrowIfCancellationRequested();
        var web = WebView.CoreWebView2;
        web.Settings.AreDefaultContextMenusEnabled = true;
        web.Settings.AreDevToolsEnabled = true;
        web.Settings.IsStatusBarEnabled = false;
        // 关键：WebView2 默认刷白底，会把后面的磨砂玻璃整块盖住，必须显式设成完全透明。
        // 实测：DefaultBackgroundColor 带半透明 alpha（如 0x99F8F3EA）会让 WebView2 抛
        // “Value does not fall within the expected range.”（E_INVALIDARG）——
        // 它只接受 alpha=0（透明）或 255（不透明）。所以暖白纱不放这里，
        // 而是放在窗口 Background 上（WindowGlass.VeilArgb）：页面透明处会露出窗外层那层纱。
        // 一条设 WPF 控件上的属性（它负责承载 HWND 的那一层），另一条按文档直接设 Controller；
        // 这个版本的 WPF 封装没有公开 CoreWebView2Controller，只能用反射取（拿不到就跳过，不影响）。
        WebView.DefaultBackgroundColor = System.Drawing.Color.Transparent;
        TrySetControllerTransparent();
        web.NewWindowRequested += OnNewWindowRequested;
        web.NavigationCompleted += OnNavigationCompleted;
        // 控制台「任务与研究 → 打开 DSH 工作台」不要往浏览器里甩地址：DSH 的 Web UI
        // 需要它自己打印的授权地址，直接把 http://127.0.0.1:<port>/ 丢给浏览器只会得到
        // 一行 "dsh web authentication required"。改成让页面用 postMessage 通知宿主，
        // 由这里把用户正在用的 DSH 窗口提到最前（没有窗口就给出可执行的提示）。
        web.WebMessageReceived += OnWebMessageReceived;
        web.ProcessFailed += (_, e) => ShowError("页面显示遇到问题", $"WebView2 进程异常：{e.ProcessFailedKind}。请重新连接。");
        _webReady = true;
        _diagnostics += $"WebView2：{environment.BrowserVersionString}\r\n";
        _diagnostics += $"玻璃路线：{_glassRoute}\r\n";
    }

    /// <summary>
    /// 把 CoreWebView2Controller.DefaultBackgroundColor 设成透明（规格 A5 的原话）。
    /// WPF 封装把这个 Controller 藏成非公开成员，只能反射取；失败就算了，
    /// 上面那行 WebView.DefaultBackgroundColor 已经能覆盖绝大多数情况。
    /// </summary>
    private void TrySetControllerTransparent()
    {
        try
        {
            const System.Reflection.BindingFlags flags =
                System.Reflection.BindingFlags.Instance |
                System.Reflection.BindingFlags.Public |
                System.Reflection.BindingFlags.NonPublic;
            var property = WebView.GetType().GetProperty("CoreWebView2Controller", flags);
            var controller = property?.GetValue(WebView);
            if (controller is null)
            {
                WindowGlass.Log($"  controller=null (property={property is not null}) WebViewDefaultBackgroundColor={WebView.DefaultBackgroundColor}");
                return;
            }
            controller.GetType().GetProperty("DefaultBackgroundColor")?.SetValue(
                controller, System.Drawing.Color.Transparent);
            WindowGlass.Log("  controller.DefaultBackgroundColor=Transparent ok");
        }
        catch (Exception ex)
        {
            _diagnostics += $"Controller 透明背景未设置：{ex.Message}\r\n";
        }
    }

    private ConsoleConfig ReadConfig()
    {
        var config = new ConsoleConfig();
        try
        {
            if (!File.Exists(_configPath)) return config;
            using var json = JsonDocument.Parse(File.ReadAllText(_configPath));
            var root = json.RootElement;
            if (root.TryGetProperty("host", out var host) && host.ValueKind == JsonValueKind.String)
            {
                var value = host.GetString()?.Trim() ?? "";
                if (TrustedLoopbackHosts.Contains(value, StringComparer.OrdinalIgnoreCase)) config.Host = value;
                else _diagnostics += "配置的 host 不是回环地址，已使用 127.0.0.1。\r\n";
            }
            if (root.TryGetProperty("port", out var port))
            {
                if (port.ValueKind == JsonValueKind.Number && port.TryGetInt32(out var number) && number is > 0 and <= 65535) config.Port = number;
                else if (port.ValueKind == JsonValueKind.String && int.TryParse(port.GetString(), out number) && number is > 0 and <= 65535) config.Port = number;
            }
            if (root.TryGetProperty("token", out var token) && token.ValueKind == JsonValueKind.String) config.Token = token.GetString() ?? "";
        }
        catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException)
        {
            _diagnostics += $"console.json 读取失败：{ex.Message}\r\n";
            ShowError("配置文件无法读取", $"请检查 console.json 的格式。\n{ex.Message}");
        }
        return config;
    }

    /// <summary>
    /// 页面地址必须带 ?shell=desktop —— 这是前端玻璃层的唯一开关（docs/console-glass-v3.md §B6）。
    /// 控制台前端只认 location.search 里的这个参数：有它才把 <html> 标成 data-shell="desktop"，
    /// 才会把 html/body 变透明、去掉侧栏分隔线、让窗口壁纸纱透上来。
    /// 不带参数时页面走浏览器那套不透明暖纸，玻璃就只剩标题条一条 —— 这正是之前
    /// 「内容区一片白、只有标题条透」的根因。
    /// </summary>
    private static Uri ShellUri(Uri baseUri) => new UriBuilder(baseUri) { Query = "shell=desktop" }.Uri;

    private async Task<HealthResult> CheckHealthAsync(Uri baseUri, CancellationToken cancellationToken)
    {
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, new Uri(baseUri, "/api/health"));
            if (!string.IsNullOrWhiteSpace(_config.Token)) request.Headers.Add("x-molly-token", _config.Token);
            using var response = await _http.SendAsync(request, cancellationToken);
            if (!response.IsSuccessStatusCode) return new(false, "", $"健康检查返回 HTTP {(int)response.StatusCode}。请检查 token 配置。");
            using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync(cancellationToken));
            var root = json.RootElement;
            bool ok = root.TryGetProperty("ok", out var okValue) && okValue.ValueKind == JsonValueKind.True;
            string version = root.TryGetProperty("version", out var versionValue) && versionValue.ValueKind == JsonValueKind.String ? versionValue.GetString() ?? "" : "";
            if (ok && !string.IsNullOrWhiteSpace(version)) return new(true, version, "");
            return new(false, "", "端口上的服务未返回有效的 ok/version，未启动新后端。请确认该端口是否被其他程序占用。");
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested) { return new(false, "", "连接超时。"); }
        catch (HttpRequestException ex) when (ex.InnerException is SocketException) { return new(false, "", "尚未发现运行中的 Molly 后端。"); }
        catch (Exception ex) when (ex is HttpRequestException or JsonException or IOException) { return new(false, "", ex.Message); }
    }

    /// <summary>
    /// 「上次用的后端目录」指针文件。桌面上的 Molly.exe 是单独复制的，旁边没有 molly-console.exe，
    /// 靠这个文件仍能找回真后端（每次成功拉起后端时写一次）。
    /// </summary>
    private static string InstallPointerPath()
    {
        string root = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        return Path.Combine(root, "Molly", "Desktop", "install-dir.txt");
    }

    private static string? ReadInstallPointer()
    {
        try
        {
            string file = InstallPointerPath();
            if (!File.Exists(file)) return null;
            string dir = File.ReadAllText(file).Trim();
            if (dir.Length == 0 || !Path.IsPathFullyQualified(dir)) return null;
            if (!File.Exists(Path.Combine(dir, "molly-console.exe"))) return null;
            if (!Directory.Exists(Path.Combine(dir, "console"))) return null;
            return dir;
        }
        catch { return null; }
    }

    private static void WriteInstallPointer(string directory)
    {
        try
        {
            string file = InstallPointerPath();
            string? parent = Path.GetDirectoryName(file);
            if (!string.IsNullOrEmpty(parent)) Directory.CreateDirectory(parent);
            if (File.Exists(file) && string.Equals(File.ReadAllText(file).Trim(), directory, StringComparison.OrdinalIgnoreCase)) return;
            File.WriteAllText(file, directory);
        }
        catch { /* 指针只是便利，写不进去不影响启动 */ }
    }

    private bool StartBackend()
    {
        if (_ownedBackend is { HasExited: false })
        {
            ShowError("后端仍在启动", "已有一个由本窗口启动的后端，未重复创建进程。");
            return false;
        }
        if (!File.Exists(_consolePath))
        {
            string remembered = ReadInstallPointer() ?? "（还没记下）";
            ShowError(
                "未找到 Molly 后端",
                "请把 molly-console.exe 放在 Molly.exe 同目录，或先用安装目录里的 Molly.exe 启动一次。\r\n\r\n"
                + $"本程序目录：{_exeDirectory}\r\n"
                + $"上次记住的目录：{remembered}");
            return false;
        }
        try
        {
            string expectedPath = Path.GetFullPath(_consolePath);
            var startInfo = new ProcessStartInfo
            {
                FileName = expectedPath,
                WorkingDirectory = _backendDirectory,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            startInfo.ArgumentList.Add("--no-browser");
            startInfo.Environment["MOLLY_NO_BROWSER"] = "1";
            _ownedBackend = Process.Start(startInfo);
            if (_ownedBackend is null) throw new InvalidOperationException("系统未能创建后端进程。");
            _ownedBackend.EnableRaisingEvents = true;
            WriteInstallPointer(_backendDirectory);
            _diagnostics += $"后端：由本应用创建，PID {_ownedBackend.Id}，路径 {expectedPath}\r\n";
            return true;
        }
        catch (Exception ex) { ShowError("无法启动 Molly 后端", FriendlyError(ex)); return false; }
    }

    private async Task<HealthResult> WaitForBackendAsync(Uri baseUri, CancellationToken cancellationToken)
    {
        var deadline = DateTime.UtcNow.AddSeconds(StartupTimeoutSeconds);
        HealthResult last = new(false, "", "后端尚未就绪。");
        while (DateTime.UtcNow < deadline && !cancellationToken.IsCancellationRequested)
        {
            if (_ownedBackend?.HasExited == true) return new(false, "", $"后端进程已退出（代码 {_ownedBackend.ExitCode}）。请查看控制台日志或诊断信息。");
            last = await CheckHealthAsync(baseUri, cancellationToken);
            if (last.Ok) return last;
            await Task.Delay(500, cancellationToken);
        }
        return last with { Error = $"后端在 {StartupTimeoutSeconds} 秒内未就绪。{last.Error}" };
    }

    private void OnNewWindowRequested(object? sender, CoreWebView2NewWindowRequestedEventArgs e)
    {
        e.Handled = true;
        if (!Uri.TryCreate(e.Uri, UriKind.Absolute, out var uri)) return;
        if (IsTrustedLoopback(uri) && string.Equals(uri.Scheme, Uri.UriSchemeHttp, StringComparison.OrdinalIgnoreCase))
        {
            WebView.CoreWebView2.Navigate(uri.ToString());
            return;
        }
        var choice = MessageBox.Show(this, $"Molly 想要用系统浏览器打开外部链接：\n\n{uri}\n\n是否继续？", "打开外部链接", MessageBoxButton.YesNo, MessageBoxImage.Question);
        if (choice != MessageBoxResult.Yes) return;
        if (uri.Scheme is not ("http" or "https")) return;
        try { Process.Start(new ProcessStartInfo(uri.ToString()) { UseShellExecute = true }); }
        catch (Exception ex) { MessageBox.Show(this, $"无法打开链接：{ex.Message}", "Molly", MessageBoxButton.OK, MessageBoxImage.Warning); }
    }

    private static bool IsTrustedLoopback(Uri uri) => TrustedLoopbackHosts.Contains(uri.Host, StringComparer.OrdinalIgnoreCase);

    /// <summary>
    /// 接收页面发来的宿主指令。目前只有一条：{type:"molly:open-dsh"}。
    ///
    /// 为什么走 postMessage 而不是自定义协议跳转：WebView2 遇到未知 scheme 的顶层导航
    /// 会先失败再触发事件，用户会看到一次「页面无法载入」的闪断；postMessage 是同步的，
    /// 不会动当前页面。浏览器模式下页面没有 window.chrome.webview，仍走原来的外链逻辑。
    /// </summary>
    private void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        string raw;
        try { raw = e.TryGetWebMessageAsString(); }
        catch { return; }
        if (string.IsNullOrWhiteSpace(raw) || raw.Length > 512) return;
        if (raw.Contains("molly:open-dsh", StringComparison.Ordinal))
        {
            BringDshToFront();
        }
    }

    /// <summary>
    /// 把已经在跑的 DSH 主窗口提到最前；没找到就明确告诉用户该启动什么。
    /// 注意：不做 SetForegroundWindow 的强行抢占 hack（会打扰用户正在打的字），
    /// 只在窗口最小化时还原，然后交给系统前台规则。
    /// </summary>
    private void BringDshToFront()
    {
        var target = FindDshWindow();
        if (target == IntPtr.Zero)
        {
            MessageBox.Show(this,
                "没有找到正在运行的 DSH 窗口。\n\nDSH 的网页版需要在它自己的窗口里打开（会校验授权地址），请先从开始菜单启动 DeepSeek Harness，再回来点这个按钮。",
                "DSH 未运行", MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }
        try
        {
            if (IsIconic(target)) ShowWindow(target, SwRestore);
            ShowWindow(target, SwShow);
            SetForegroundWindow(target);
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, $"无法切换到 DSH 窗口：{ex.Message}", "Molly", MessageBoxButton.OK, MessageBoxImage.Warning);
        }
    }

    private static IntPtr FindDshWindow()
    {
        IntPtr found = IntPtr.Zero;
        foreach (var process in Process.GetProcessesByName("DeepSeek Harness"))
        {
            try
            {
                var handle = process.MainWindowHandle;
                if (handle != IntPtr.Zero && IsWindowVisible(handle)) { found = handle; break; }
            }
            catch { /* 进程刚好退出 */ }
            finally { process.Dispose(); }
        }
        return found;
    }

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr hWnd);

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    private const int SwRestore = 9;
    private const int SwShow = 5;

    private void OnNavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs e)
    {
        if (_shuttingDown) return;
        if (!e.IsSuccess)
        {
            ShowError("页面未能载入", $"导航失败：{e.WebErrorStatus}。后端可能已停止，请重新连接。");
            return;
        }
        StatusPanel.Visibility = Visibility.Collapsed;
        WebView.Visibility = Visibility.Visible;
    }

    private void SetStatus(string title, string detail)
    {
        if (_shuttingDown) return;
        StatusText.Text = title;
        DetailText.Text = detail;
    }

    private void ShowError(string title, string detail)
    {
        if (_shuttingDown) return;
        _diagnostics += $"最近错误：{detail}\r\n";
        if (!IsLoaded) return;
        SetStatus(title, detail);
        ActionPanel.Visibility = Visibility.Visible;
        StatusPanel.Visibility = Visibility.Visible;
        WebView.Visibility = Visibility.Collapsed;
    }

    private static string FriendlyError(Exception ex) => ex switch
    {
        UnauthorizedAccessException => "没有足够权限访问本地文件。请检查安装目录权限。",
        FileNotFoundException => "缺少必要文件，请确认应用与后端文件完整。",
        _ => ex.Message
    };

    private async void Retry_Click(object sender, RoutedEventArgs e) => await ConnectAsync();

    private void Diagnostics_Click(object sender, RoutedEventArgs e)
    {
        string owned = _ownedBackend is null ? "本应用未创建后端" : $"PID {_ownedBackend.Id}，已退出={_ownedBackend.HasExited}";
        MessageBox.Show(this, $"{_diagnostics}进程：{owned}", "Molly 诊断信息", MessageBoxButton.OK, MessageBoxImage.Information);
    }

    private void Window_Closing(object? sender, System.ComponentModel.CancelEventArgs e)
    {
        if (_allowClose) return;
        e.Cancel = true;
        _connectionAttempt?.Cancel();
        var result = MessageBox.Show(this,
            "要关闭 Molly 窗口吗？\n\n是：退出 Molly，并停止本窗口启动的后台服务\n否：仅关闭窗口，后台服务继续运行（再次启动会直接复用）\n取消：留在 Molly",
            "关闭 Molly", MessageBoxButton.YesNoCancel, MessageBoxImage.Question, MessageBoxResult.No);
        if (result == MessageBoxResult.Cancel) return;
        _shuttingDown = true;
        App.ShuttingDown = true;
        if (result == MessageBoxResult.Yes) StopOwnedBackend();
        _allowClose = true;
        // Closing 事件里直接 Close() 会被 WPF 拒绝（VerifyNotClosing），排队到消息循环再关。
        Dispatcher.BeginInvoke(new Action(Close), DispatcherPriority.Background);
    }

    private void StopOwnedBackend()
    {
        var process = _ownedBackend;
        if (process is null || process.HasExited) return;
        try
        {
            string actualPath = Path.GetFullPath(process.MainModule?.FileName ?? "");
            string expectedPath = Path.GetFullPath(_consolePath);
            if (!string.Equals(actualPath, expectedPath, StringComparison.OrdinalIgnoreCase)) return;
            process.Kill(entireProcessTree: true);
            process.WaitForExit(3000);
        }
        catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception or NotSupportedException)
        {
            _diagnostics += $"后端未停止：{ex.Message}\r\n";
        }
    }

    protected override void OnClosed(EventArgs e)
    {
        _connectionAttempt?.Cancel();
        _connectionAttempt?.Dispose();
        if (_webReady) WebView.Dispose();
        _ownedBackend?.Dispose();
        _http.Dispose();
        base.OnClosed(e);
    }

    private sealed record ConsoleConfig
    {
        public string Host { get; set; } = "127.0.0.1";
        public int Port { get; set; } = 19392;
        public string Token { get; set; } = "";
    }

    private sealed record HealthResult(bool Ok, string Version, string Error);

    private const int MonitorDefaultToNearest = 2;

    [DllImport("user32.dll")]
    private static extern IntPtr MonitorFromWindow(IntPtr handle, int flags);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);

    private const uint SwpNoZOrder = 0x0004;
    private const uint SwpNoActivate = 0x0010;
    private const uint SwpNoOwnerZOrder = 0x0200;

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetWindowPos(IntPtr handle, IntPtr insertAfter, int x, int y, int width, int height, uint flags);

    [StructLayout(LayoutKind.Sequential)]
    private struct NativeRect
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MonitorInfo
    {
        public int Size;
        public NativeRect Monitor;
        public NativeRect Work;
        public uint Flags;
    }
}
