using System.IO;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Threading;

namespace MollyDesktop;

public partial class App : Application
{
    private const string MutexName = @"Local\Molly.Desktop.5B60BA14-97C4-4237-B846-9C6F37A5D2E1";
    private Mutex? _singleInstance;
    private EventWaitHandle? _showWindowEvent;
    private CancellationTokenSource? _activationLifetime;

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        ShutdownMode = ShutdownMode.OnExplicitShutdown;
        DispatcherUnhandledException += OnUnhandledException;

        // 单实例门闩。灰度/实测需要一个能和生产实例并存的副本时，设 MOLLY_ALLOW_MULTI_INSTANCE=1；
        // 生产分发不设该变量，行为与以前完全一致。
        if (!AllowMultipleInstances)
        {
            _singleInstance = new Mutex(true, MutexName, out bool first);
            if (!first)
            {
                try
                {
                    using var evt = EventWaitHandle.OpenExisting(MutexName + ".Show");
                    evt.Set();
                }
                catch (WaitHandleCannotBeOpenedException) { }
                _singleInstance.Dispose();
                _singleInstance = null;
                Shutdown();
                return;
            }

            _showWindowEvent = new EventWaitHandle(false, EventResetMode.AutoReset, MutexName + ".Show");
        }

        _activationLifetime = new CancellationTokenSource();
        if (_showWindowEvent is not null) _ = ListenForActivationAsync(_activationLifetime.Token);
        MainWindow = new MainWindow();
        MainWindow.Closed += (_, _) => Shutdown();
        MainWindow.Show();
    }

    private static bool AllowMultipleInstances =>
        string.Equals(Environment.GetEnvironmentVariable("MOLLY_ALLOW_MULTI_INSTANCE"), "1", StringComparison.Ordinal);

    private async Task ListenForActivationAsync(CancellationToken cancellationToken)
    {
        var evt = _showWindowEvent;
        if (evt is null) return;
        try
        {
            while (!cancellationToken.IsCancellationRequested)
            {
                await Task.Run(() => evt.WaitOne(), cancellationToken);
                await Dispatcher.InvokeAsync(() =>
                {
                    if (MainWindow is null) return;
                    MainWindow.ShowInTaskbar = true;
                    MainWindow.WindowState = WindowState.Normal;
                    MainWindow.Show();
                    MainWindow.Activate();
                    BringToForeground(MainWindow);
                });
            }
        }
        catch (OperationCanceledException) { }
        catch (ObjectDisposedException) { }
    }

    [DllImport("user32.dll")]
    private static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    private static void BringToForeground(Window window)
    {
        var handle = new System.Windows.Interop.WindowInteropHelper(window).Handle;
        if (handle == IntPtr.Zero) return;
        ShowWindowAsync(handle, 9);
        SetForegroundWindow(handle);
    }

    private void OnUnhandledException(object sender, DispatcherUnhandledExceptionEventArgs e)
    {
        string logPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Molly", "Desktop", "desktop-error.log");
        try { File.AppendAllText(logPath, $"[{DateTime.Now:O}] {e.Exception}\r\n"); } catch { }
        e.Handled = true;
        // 退出过程中控件已开始销毁，此时再弹窗只会演出"关闭失败"的假象。
        if (ShuttingDown) return;
        MessageBox.Show($"Molly 遇到未处理错误：\n{e.Exception.Message}", "Molly", MessageBoxButton.OK, MessageBoxImage.Error);
    }

    public static bool ShuttingDown { get; set; }

    protected override void OnExit(ExitEventArgs e)
    {
        _activationLifetime?.Cancel();
        _activationLifetime?.Dispose();
        _showWindowEvent?.Dispose();
        if (_singleInstance is not null)
        {
            try { _singleInstance.ReleaseMutex(); } catch (ApplicationException) { }
            _singleInstance.Dispose();
        }
        base.OnExit(e);
    }
}
