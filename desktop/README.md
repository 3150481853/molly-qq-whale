# Molly Desktop

原生 WPF 桌面壳，通过 WebView2 内嵌 Molly 控制台；不是浏览器快捷方式。窗口保留 Windows 原生标题栏、任务栏、图标和系统菜单，默认 1440 × 900，最小 960 × 650，并限制单实例。

## 构建

需要 Windows、.NET 8 SDK 和 WebView2 Runtime。仓库内使用指定 SDK：

```powershell
${MOLLY_ROOT}\qq-whale\out\dotnet-sdk\dotnet.exe build ${MOLLY_ROOT}\qq-whale\desktop\MollyDesktop.csproj -c Release
```

或执行 `.\build.ps1`。输出位于 `bin\Release\net8.0-windows\`，主程序为 `Molly.exe`。

## 部署

将 `Molly.exe`、同目录的依赖文件、`molly-console.exe` 和可选 `console.json` 放在同一发布目录。运行需要已安装 Microsoft Edge WebView2 Runtime；首次运行会联网还原 NuGet 包。

`console.json` 示例：

```json
{
  "host": "127.0.0.1",
  "port": 19392,
  "token": ""
}
```

仅接受回环 host，端口范围 1–65535。有 token 时，桌面端健康检查使用 `x-molly-token` 请求头；控制台静态页面与接口的鉴权仍需与后端部署方式一致。

## 生命周期

1. 启动先请求 `/api/health`，验证 HTTP 成功、`ok: true` 且 `version` 非空，直接复用已有后端，不启动第二个。
2. 未检测到有效后端时，启动同目录 `molly-console.exe --no-browser`，同时设置 `MOLLY_NO_BROWSER=1`；最多等待 35 秒。
3. 关闭窗口时明确选择：仅关窗并保留后台，或退出并停止后端。停止前再次核对进程完整路径，只处理本窗口创建且仍持有句柄的后端，绝不按名称终止其他实例。
4. WebView2 用户数据保存在 `%LOCALAPPDATA%\Molly\Desktop`。外部新窗口链接需用户确认后交给系统浏览器，回环 HTTP 链接在应用内打开。
5. 启动、健康检查和页面加载失败均显示中文重试/诊断界面。

## 尚需实机验证

- WebView2 首次初始化、真实控制台页面导航与 token 场景。
- 复用已有后端、冷启动后端、无效端口占用、退出进程树。
- 单实例激活、窗口尺寸/DPI、外部链接确认及任务栏/系统菜单。
