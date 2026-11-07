using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

internal static class tray
{
    [STAThread]
    private static void Main()
    {
        bool created;
        using (var mutex = new Mutex(true, @"Local\UnionFlfowLocalHelper", out created))
        {
            if (!created) { MessageBox.Show("本地助手已在 Windows 托盘运行。", "UnionFlfow 本地助手"); return; }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new trayContext(Array.IndexOf(Environment.GetCommandLineArgs(), "--controlCenter") >= 0));
        }
    }
}

internal sealed class trayContext : ApplicationContext
{
    private readonly Control dispatcher = new Control();
    private readonly JavaScriptSerializer serializer = new JavaScriptSerializer();
    private readonly NotifyIcon icon;
    private readonly ToolStripMenuItem pauseItem = new ToolStripMenuItem("暂停接收任务");
    private readonly ToolStripMenuItem automaticItem = new ToolStripMenuItem("本次运行自动执行文件操作和命令");
    private readonly ToolStripMenuItem startupItem = new ToolStripMenuItem("开机启动");
    private readonly HashSet<string> prompts = new HashSet<string>();
    private StreamWriter workerInput;
    private Action pendingAction;
    private object pendingDecision;
    private string pendingDecisionId;
    private string pendingNotice;
    private Process worker;
    private IntPtr processJob;
    private bool closing;
    private string status = "正在连接平台";
    private string code = "连接后显示";
    private string server = "https://yixian.lol/flow/";
    private string owner = "尚未绑定";
    private Form controlWindow;
    private WebView2 controlView;
    private bool controlReady;
    private string controlPage = "overview";
    // 每次启动使用独立入口 URL，防止升级后命中旧版控制中心的页面缓存。
    private readonly string controlUrl = "https://local.unionflow.app/index.html?run=" + Guid.NewGuid().ToString("N");
    private bool stderrReported;
    private int diagnosticRunning;

    public trayContext(bool openControlCenter)
    {
        dispatcher.CreateControl();
        serializer.MaxJsonLength = 16 * 1024 * 1024;
        icon = new NotifyIcon { Text = "UnionFlfow 本地助手", Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath), Visible = true };
        var menu = new ContextMenuStrip();
        menu.Items.Add("本地控制中心", null, (sender, args) => showControlCenter("overview"));
        menu.Items.Add("任务中心", null, (sender, args) => showControlCenter("tasks"));
        menu.Items.Add("批量字幕", null, (sender, args) => showControlCenter("subtitles"));
        menu.Items.Add("打开 UnionFlfow", null, (sender, args) => Process.Start(new ProcessStartInfo(server) { UseShellExecute = true }));
        menu.Items.Add("登录 UnionAIGC / 绑定本机", null, (sender, args) => openAccount());
        menu.Items.Add("本机 AI 助手", null, (sender, args) => showControlCenter("chat"));
        menu.Items.Add("状态与配对码", null, (sender, args) => showStatus());
        menu.Items.Add("复制配对码", null, (sender, args) => Clipboard.SetText(code.Replace("-", "")));
        menu.Items.Add("打开日志文件夹", null, (sender, args) => openLogs());
        menu.Items.Add(new ToolStripSeparator());
        pauseItem.Click += (sender, args) => send(new { type = "pause", value = !pauseItem.Checked });
        automaticItem.Click += (sender, args) =>
        {
            bool allow = !automaticItem.Checked;
            if (allow) confirmAction("允许本次运行自动执行？", "AI 将能自动写入、传输、删除文件、执行 PowerShell 和安装软件，权限与当前 Windows 用户相同。", "此授权在退出或解除绑定后失效。你可以随时暂停或关闭。", "开启自动执行", true, () => send(new { type = "automatic", value = true }));
            else send(new { type = "automatic", value = false });
        };
        menu.Items.Add(pauseItem);
        menu.Items.Add(automaticItem);
        startupItem.Checked = startupEnabled();
        startupItem.Click += (sender, args) =>
        {
            try
            {
                using (var key = Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run"))
                {
                    if (startupItem.Checked) key.DeleteValue("UnionFlfowLocalHelper", false);
                    else key.SetValue("UnionFlfowLocalHelper", "\"" + Application.ExecutablePath + "\"");
                }
                startupItem.Checked = !startupItem.Checked;
                postShellState();
            }
            catch (Exception error) { reportDiagnostic("startupSettingFailed", error); showNotice("设置开机启动失败", error.Message); }
        };
        menu.Items.Add(startupItem);
        menu.Items.Add("重新连接进程", null, (sender, args) => startWorker());
        menu.Items.Add("解除绑定并生成新配对码", null, (sender, args) =>
        {
            confirmUnbind();
        });
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("退出", null, (sender, args) => ExitThread());
        icon.ContextMenuStrip = menu;
        icon.DoubleClick += (sender, args) => showControlCenter("overview");
        startWorker();
        if (openControlCenter) showControlCenter("overview");
    }

    private bool startupEnabled()
    {
        using (var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run"))
            return key != null && String.Equals(key.GetValue("UnionFlfowLocalHelper") as string, "\"" + Application.ExecutablePath + "\"", StringComparison.OrdinalIgnoreCase);
    }

    private void openAccount()
    {
        Process.Start(new ProcessStartInfo(new Uri(new Uri(server), "#/home?localHelper=1").AbsoluteUri) { UseShellExecute = true });
    }

    private void showStatus()
    {
        showControlCenter("devices");
    }

    private string dataDirectory()
    {
        return Path.GetFullPath(Environment.GetEnvironmentVariable("TOONFLOW_HELPER_DATA_DIR") ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "UnionFlfow", "localHelper"));
    }

    private void openLogs()
    {
        try { Process.Start(new ProcessStartInfo(Path.Combine(dataDirectory(), "logs")) { UseShellExecute = true }); }
        catch (Exception error) { reportDiagnostic("openLogsFailed", error); showNotice("打开日志失败", error.Message); }
    }

    private async void showControlCenter(string page)
    {
        controlPage = page;
        if (controlWindow != null)
        {
            controlWindow.Show(); if (controlWindow.WindowState == FormWindowState.Minimized) controlWindow.WindowState = FormWindowState.Normal; controlWindow.Activate();
            postUi(new { type = "navigate", page = controlPage });
            return;
        }
        controlWindow = new Form { Text = "UnionFlow · 本地控制中心", Width = 1220, Height = 820, MinimumSize = new Size(960, 660),
            StartPosition = FormStartPosition.CenterScreen, AutoScaleMode = AutoScaleMode.Dpi, Icon = icon.Icon, BackColor = Color.FromArgb(247, 248, 251) };
        controlView = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = Color.FromArgb(247, 248, 251) };
        controlWindow.Controls.Add(controlView);
        controlWindow.FormClosing += (sender, args) => { if (!closing) { args.Cancel = true; controlWindow.Hide(); } };
        controlWindow.Show();
        try
        {
            var environment = await CoreWebView2Environment.CreateAsync(null, Path.Combine(dataDirectory(), "webView"));
            if (closing) return;
            await controlView.EnsureCoreWebView2Async(environment);
            var view = controlView.CoreWebView2;
            view.Settings.AreDevToolsEnabled = false;
            view.Settings.AreDefaultContextMenusEnabled = false;
            view.Settings.IsStatusBarEnabled = false;
            view.Settings.AreHostObjectsAllowed = false;
            view.Settings.AreDefaultScriptDialogsEnabled = false;
            view.Settings.IsPasswordAutosaveEnabled = false;
            view.Settings.IsGeneralAutofillEnabled = false;
            view.SetVirtualHostNameToFolderMapping("local.unionflow.app", Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "ui"), CoreWebView2HostResourceAccessKind.DenyCors);
            view.NavigationStarting += (sender, args) => { if (args.Uri != controlUrl) args.Cancel = true; };
            view.NewWindowRequested += (sender, args) => { args.Handled = true; };
            view.PermissionRequested += (sender, args) => { args.State = CoreWebView2PermissionState.Deny; };
            view.DownloadStarting += (sender, args) => { args.Cancel = true; };
            view.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All);
            view.WebResourceRequested += (sender, args) =>
            {
                Uri uri;
                if (!Uri.TryCreate(args.Request.Uri, UriKind.Absolute, out uri) || uri.Scheme != "https" || !uri.IsDefaultPort
                    || (uri.Host != "local.unionflow.app" && !subtitlePreviewHosts.Contains(uri.Host)))
                    args.Response = environment.CreateWebResourceResponse(null, 403, "Forbidden", "");
            };
            view.WebMessageReceived += (sender, args) => { if (args.Source == controlUrl) receiveControl(args.WebMessageAsJson); };
            view.ProcessFailed += (sender, args) =>
            {
                if (closing || controlWindow == null) return;
                controlReady = false;
                reportDiagnostic("controlViewFailed");
                icon.ShowBalloonTip(5000, "UnionFlow", "控制中心显示进程异常，托盘和执行日志继续保留。请关闭后重新打开控制中心。", ToolTipIcon.Warning);
                var window = controlWindow; controlWindow = null; controlView = null; window.Dispose();
            };
            view.Navigate(controlUrl);
        }
        catch (Exception error)
        {
            reportDiagnostic("controlViewFailed", error);
            if (controlWindow != null) controlWindow.Dispose(); controlWindow = null; controlView = null; controlReady = false;
            MessageBox.Show("无法打开控制中心，请确认已安装 Microsoft Edge WebView2 Runtime，且程序目录包含 ui 文件夹与 WebView2 组件。\n\n" + error.Message, "UnionFlow 控制中心");
        }
    }

    private void postUi(object message)
    {
        if (!controlReady || controlView == null || controlView.CoreWebView2 == null) return;
        try { controlView.CoreWebView2.PostWebMessageAsJson(serializer.Serialize(message)); }
        catch (Exception error) { controlReady = false; reportDiagnostic("controlViewFailed", error); }
    }

    private void postShellState() { postUi(new { type = "shellState", startupEnabled = startupItem.Checked }); }

    private readonly HashSet<string> subtitlePreviewHosts = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

    private void receiveControl(string json)
    {
        try
        {
            if (json.Length > 1024 * 1024) throw new InvalidOperationException("控制消息过长");
            var message = serializer.Deserialize<Dictionary<string, object>>(json);
            string type = value(message, "type");
            if (type == "subtitlePick")
            {
                string kind = value(message, "kind");
                if (kind == "videos")
                {
                    using (var dialog = new OpenFileDialog { Multiselect = true, CheckFileExists = true, Filter = "视频文件|*.mp4;*.mkv;*.mov;*.avi;*.webm;*.m4v;*.ts;*.mts;*.m2ts;*.wmv;*.flv|所有文件|*.*", Title = "选择本批字幕视频（最多 400 个）" })
                    {
                        if (dialog.ShowDialog(controlWindow) == DialogResult.OK)
                        {
                            if (dialog.FileNames.Length > 400) { postUi(new { type = "notice", message = "每批最多选择 400 个视频。" }); return; }
                            postUi(new { type = "subtitlePickResult", kind = kind, paths = dialog.FileNames });
                        }
                    }
                }
                else if (kind == "python")
                {
                    using (var dialog = new OpenFileDialog { CheckFileExists = true, Filter = "Python 程序|python.exe;python3.exe;python3.*.exe|可执行文件|*.exe", Title = "选择已有的 Python 程序" })
                    {
                        if (dialog.ShowDialog(controlWindow) == DialogResult.OK) postUi(new { type = "subtitlePickResult", kind = kind, paths = new[] { dialog.FileName } });
                    }
                }
                else if (kind == "folder" || kind == "storage" || kind == "models")
                {
                    using (var dialog = new FolderBrowserDialog { Description = kind == "storage" ? "选择识别环境和模型的存储目录" : kind == "models" ? "选择已有 Whisper 模型所在的文件夹" : "选择视频所在文件夹", ShowNewFolderButton = kind == "storage" })
                    {
                        if (dialog.ShowDialog(controlWindow) == DialogResult.OK) postUi(new { type = "subtitlePickResult", kind = kind, paths = new[] { dialog.SelectedPath } });
                    }
                }
                return;
            }
            if (Array.IndexOf(new[] { "subtitleSnapshot", "subtitleEnvironment", "subtitleSettings", "subtitleInstall", "subtitleInstallCancel", "subtitleScan", "subtitleScanPage", "subtitleStart", "subtitleDetail", "subtitleSave", "subtitleRender", "subtitleCancel", "subtitlePreview", "subtitleOpen", "subtitlePause" }, type) >= 0)
            {
                if (!send(message)) postUi(new { type = "notice", message = "本地工作进程未连接，请重新连接。" });
                return;
            }
            if (type == "ready")
            {
                controlReady = true; postShellState();
                if (pendingDecision != null) postUi(pendingDecision);
                if (pendingNotice != null) { postUi(new { type = "notice", message = pendingNotice }); pendingNotice = null; }
                if (!send(new { type = "snapshot" })) { postUi(new { type = "workerStopped" }); postUi(new { type = "notice", message = "本地工作进程未连接，请在设置中重新连接。" }); }
                postUi(new { type = "navigate", page = controlPage }); return;
            }
            if (type == "openWeb") { Process.Start(new ProcessStartInfo(server) { UseShellExecute = true }); return; }
            if (type == "openAccount") { openAccount(); return; }
            if (type == "openLogs") { openLogs(); return; }
            if (type == "copyText") { string text = value(message, "text"); if (text.Length > 0 && text.Length <= 128000) Clipboard.SetText(text); return; }
            if (type == "openLink") { Uri url; if (Uri.TryCreate(value(message, "url"), UriKind.Absolute, out url) && (url.Scheme == "https" || url.Scheme == "http") && url.UserInfo.Length == 0) Process.Start(new ProcessStartInfo(url.AbsoluteUri) { UseShellExecute = true }); return; }
            if (type == "copyCode") { if (code.Replace("-", "").Length == 12) Clipboard.SetText(code.Replace("-", "")); return; }
            if (type == "startup") { startupItem.PerformClick(); return; }
            if (type == "automatic") { automaticItem.PerformClick(); return; }
            if (type == "restart") { startWorker(); postShellState(); return; }
            if (type == "resetBinding")
            {
                confirmUnbind();
                return;
            }
            if (type == "reviewApproval") { showControlCenter("permissions"); return; }
            if (type == "approval") { object allowed; string id = value(message, "id"); if (prompts.Contains(id) && message.TryGetValue("allowed", out allowed) && allowed is bool) send(new { type = "approval", id = id, allowed = (bool)allowed }); return; }
            if (type == "nativeDecision") { object allowed; if (value(message, "id") != pendingDecisionId || !message.TryGetValue("allowed", out allowed) || !(allowed is bool)) return; var action = pendingAction; pendingAction = null; pendingDecision = null; pendingDecisionId = null; if ((bool)allowed && action != null) action(); return; }
            object flag;
            object command = null;
            if (type == "pause" && message.TryGetValue("value", out flag) && flag is bool) command = new { type = "pause", value = (bool)flag };
            if (type == "chat") { string text = value(message, "text"); if (text.Length > 0 && text.Length <= 32000) command = new { type = "chat", text = text }; }
            if (type == "taskCancel") { string id = value(message, "id"); if (id.Length > 0 && id.Length <= 256) command = new { type = "taskCancel", id = id }; }
            if (type == "snapshot" || type == "tools" || type == "chatCancel" || type == "chatNew" || type == "updateCheck" || type == "updateDownload" || type == "updateInstall") command = new { type = type };
            if (type == "chatSelect" || type == "chatDelete" || type == "chatRename") { Guid id; string title = value(message, "title"); if (Guid.TryParse(value(message, "id"), out id) && title.Length <= 80) command = type == "chatRename" ? (object)new { type = type, id = id.ToString(), title = title } : new { type = type, id = id.ToString() }; }
            if (type == "updatePreferences") { object check, install; if (message.TryGetValue("autoCheck", out check) && check is bool && message.TryGetValue("autoInstall", out install) && install is bool) command = new { type = type, autoCheck = (bool)check, autoInstall = (bool)install }; }
            if (command != null && !send(command)) postUi(new { type = "notice", message = "本地工作进程未连接，请在设置中重新连接。" });
        }
        catch (Exception error) { reportDiagnostic("nativeMessageFailed", error); postUi(new { type = "notice", message = "本地控制消息处理失败，请查看日志。" }); }
    }

    private void startWorker()
    {
        if (worker != null && !worker.HasExited) { showStatus(); return; }
        try
        {
            stderrReported = false;
            if (processJob != IntPtr.Zero) { CloseHandle(processJob); processJob = IntPtr.Zero; }
            processJob = CreateJobObject(IntPtr.Zero, null);
            if (processJob == IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
            var limits = new jobExtendedLimits();
            limits.basic.limitFlags = 0x2000;
            int size = Marshal.SizeOf(typeof(jobExtendedLimits));
            IntPtr memory = Marshal.AllocHGlobal(size);
            try
            {
                Marshal.StructureToPtr(limits, memory, false);
                if (!SetInformationJobObject(processJob, 9, memory, (uint)size)) throw new System.ComponentModel.Win32Exception();
            }
            finally { Marshal.FreeHGlobal(memory); }
            worker = new Process { StartInfo = new ProcessStartInfo(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "localWorker.exe"))
            {
                UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true,
                RedirectStandardError = true, StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8,
                WorkingDirectory = AppDomain.CurrentDomain.BaseDirectory
            }, EnableRaisingEvents = true };
            worker.OutputDataReceived += (sender, args) =>
            {
                if (args.Data != null && !closing) dispatcher.BeginInvoke(new Action(() => receive(args.Data)));
            };
            worker.ErrorDataReceived += (sender, args) =>
            {
                if (!String.IsNullOrEmpty(args.Data) && !closing) dispatcher.BeginInvoke(new Action(() =>
                {
                    status = args.Data;
                    if (!stderrReported) { stderrReported = true; reportDiagnostic("workerStderr", null, null, args.Data.Length); }
                }));
            };
            worker.Exited += (sender, args) =>
            {
                var exited = sender as Process;
                int exitCode = -1;
                try { if (exited != null) exitCode = exited.ExitCode; } catch { }
                if (!closing) dispatcher.BeginInvoke(new Action(() =>
                {
                    if (!Object.ReferenceEquals(worker, exited)) { reportDiagnostic("workerExited", null, exitCode); return; }
                    status = "本地进程已停止，请从托盘重新连接";
                    automaticItem.Checked = false;
                    postUi(new { type = "workerStopped" });
                    reportDiagnostic("workerExited", null, exitCode);
                    icon.ShowBalloonTip(5000, "UnionFlfow 本地助手", status, ToolTipIcon.Warning);
                    prompts.Clear(); pendingAction = null; pendingDecision = null; pendingDecisionId = null;
                }));
            };
            worker.Start();
            if (!AssignProcessToJobObject(processJob, worker.Handle))
            {
                worker.Kill();
                throw new System.ComponentModel.Win32Exception();
            }
            // Windows 默认输入编码会破坏中文；所有托盘控制消息统一为无 BOM 的严格 UTF-8。
            workerInput = new StreamWriter(worker.StandardInput.BaseStream, new UTF8Encoding(false, true));
            workerInput.AutoFlush = true;
            worker.BeginOutputReadLine();
            worker.BeginErrorReadLine();
            reportDiagnostic("workerStarted");
        }
        catch (Exception error) { reportDiagnostic("workerStartFailed", error); showNotice("本地助手启动失败", error.Message); }
    }

    private void reportDiagnostic(string eventName, Exception error = null, int? exitCode = null, int? length = null)
    {
        var data = new Dictionary<string, object> { { "event", eventName }, { "pid", Process.GetCurrentProcess().Id } };
        if (error != null) { data.Add("errorType", error.GetType().Name); data.Add("systemCode", error.HResult); }
        if (exitCode.HasValue) data.Add("exitCode", exitCode.Value);
        if (length.HasValue) data.Add("length", length.Value);
        try
        {
            if (worker != null && !worker.HasExited)
            {
                data.Add("type", "diagnostic");
                workerInput.WriteLine(serializer.Serialize(data));
                return;
            }
        }
        catch { }
        data.Remove("type");
        // ACT: 工作进程退出后复用日志专用模式写入；不在原生外壳重复实现文件写入与归档。
        if (Interlocked.CompareExchange(ref diagnosticRunning, 1, 0) != 0) return;
        var diagnosticProcess = new Process { StartInfo = new ProcessStartInfo(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "localWorker.exe"))
        {
            UseShellExecute = false, CreateNoWindow = true,
            Arguments = "--nativeDiagnostic " + Convert.ToBase64String(Encoding.UTF8.GetBytes(serializer.Serialize(data))),
            WorkingDirectory = AppDomain.CurrentDomain.BaseDirectory
        }, EnableRaisingEvents = true };
        diagnosticProcess.Exited += (sender, args) => { Interlocked.Exchange(ref diagnosticRunning, 0); diagnosticProcess.Dispose(); };
        try { diagnosticProcess.Start(); }
        catch { diagnosticProcess.Dispose(); Interlocked.Exchange(ref diagnosticRunning, 0); }
    }

    private bool send(object message)
    {
        try { if (worker != null && !worker.HasExited && workerInput != null) { workerInput.WriteLine(serializer.Serialize(message)); return true; } }
        catch (Exception error) { reportDiagnostic("nativeSendFailed", error); status = "本地进程通信失败：" + error.Message; }
        return false;
    }

    private string value(Dictionary<string, object> message, string key)
    {
        object result;
        return message.TryGetValue(key, out result) && result != null ? Convert.ToString(result) : "";
    }

    private void receive(string line)
    {
        try
        {
            var message = serializer.Deserialize<Dictionary<string, object>>(line);
            string subtitleMessage = value(message, "type");
            if (subtitleMessage == "subtitleReveal")
            {
                string path = Path.GetFullPath(value(message, "path"));
                if (Path.IsPathRooted(path) && path.Length > 3 && path.IndexOf('"') < 0) Process.Start(new ProcessStartInfo(path) { UseShellExecute = true });
                return;
            }
            if (subtitleMessage == "subtitlePreviewReady" && controlView != null && controlView.CoreWebView2 != null)
            {
                Guid taskId;
                if (!Guid.TryParse(value(message, "id"), out taskId)) return;
                string directory = Path.GetFullPath(value(message, "directory"));
                string expected = Path.GetFullPath(Path.Combine(dataDirectory(), "subtitlePreviews", taskId.ToString()));
                if (!String.Equals(directory, expected, StringComparison.OrdinalIgnoreCase)) return;
                string host = "subtitle" + taskId.ToString("N") + ".unionflow.app";
                controlView.CoreWebView2.SetVirtualHostNameToFolderMapping(host, directory, CoreWebView2HostResourceAccessKind.Allow);
                subtitlePreviewHosts.Add(host);
            }
            postUi(message);
            string type = value(message, "type");
            if (type == "logFailure")
            {
                status = "诊断日志写入或归档失败，请检查磁盘空间与目录权限。错误码：" + value(message, "code");
                icon.ShowBalloonTip(8000, "UnionFlfow 日志", status, ToolTipIcon.Warning);
            }
            if (type == "status")
            {
                status = value(message, "message");
                string nextCode = value(message, "code");
                if (nextCode.Length == 12 && nextCode != code.Replace("-", ""))
                {
                    code = nextCode.Substring(0, 4) + "-" + nextCode.Substring(4, 4) + "-" + nextCode.Substring(8);
                    icon.ShowBalloonTip(8000, "UnionFlfow 本地助手", "配对码：" + code + "\n请在网页设置中绑定本机。", ToolTipIcon.Info);
                }
                server = value(message, "server");
                owner = value(message, "owner");
                pauseItem.Checked = value(message, "paused") == "True";
                pauseItem.Text = pauseItem.Checked ? "继续接收任务" : "暂停接收任务";
                automaticItem.Checked = value(message, "autoExecute") == "True";
                icon.Text = "UnionFlfow " + status.Substring(0, Math.Min(45, status.Length));
            }
            if (type == "confirm") showConfirmation(value(message, "id"), value(message, "title"), value(message, "detail"));
            if (type == "applyUpdate") beginUpdate(value(message, "path"));
            if (type == "dismiss")
            {
                prompts.Remove(value(message, "id"));
            }
        }
        catch (Exception error) { reportDiagnostic("nativeMessageFailed", error); status = "消息处理失败：" + error.Message; }
    }

    private void showConfirmation(string id, string title, string detail)
    {
        if (!prompts.Add(id)) return;
        revealControlCenter("permissions");
        icon.ShowBalloonTip(4000, "UnionFlow · 等待本机确认", title + "，请在控制中心核对详情。", ToolTipIcon.Info);
    }

    private void confirmUnbind()
    {
        confirmAction("解除当前设备绑定？", "将撤销当前账户的本机访问权限，并取消正在执行的本机任务。", "已保存的聊天和诊断日志继续保留。重新使用时需要重新配对。", "解除绑定", true, () => send(new { type = "reset" }));
    }

    private void showNotice(string title, string detail)
    {
        status = title + "：" + detail;
        pendingNotice = status;
        revealControlCenter("settings");
        if (controlReady) { postUi(new { type = "notice", message = pendingNotice }); pendingNotice = null; }
    }

    private void confirmAction(string title, string description, string detail, string label, bool danger, Action action)
    {
        if (pendingAction != null) { showControlCenter(controlPage); return; }
        pendingDecisionId = Guid.NewGuid().ToString(); pendingAction = action;
        pendingDecision = new { type = "decisionRequest", id = pendingDecisionId, title = title, description = description, detail = detail, danger = danger, confirmLabel = label };
        revealControlCenter("settings");
        postUi(pendingDecision);
    }

    private void revealControlCenter(string fallbackPage)
    {
        if (controlWindow == null) { showControlCenter(fallbackPage); return; }
        controlWindow.Show(); if (controlWindow.WindowState == FormWindowState.Minimized) controlWindow.WindowState = FormWindowState.Normal; controlWindow.Activate();
    }

    private void beginUpdate(string path)
    {
        Process updater = null;
        try
        {
            string plan = Path.GetFullPath(path);
            Guid transaction;
            string directory = Path.GetDirectoryName(plan);
            if (!Guid.TryParse(Path.GetFileName(directory), out transaction) || !String.Equals(plan, Path.Combine(dataDirectory(), "updates", transaction.ToString(), "plan.json"), StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("更新计划位置无效");
            updater = new Process { StartInfo = new ProcessStartInfo(Path.Combine(directory, "updater.exe"))
            {
                Arguments = "--applyUpdate \"" + plan + "\"", UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardOutput = true, StandardOutputEncoding = Encoding.UTF8, WorkingDirectory = directory
            }, EnableRaisingEvents = true };
            bool accepted = false;
            bool cancelled = false;
            var timer = new System.Windows.Forms.Timer { Interval = 60000 };
            var process = updater;
            timer.Tick += (sender, args) =>
            {
                timer.Stop(); timer.Dispose();
                if (accepted || closing) return;
                cancelled = true;
                try { if (!process.HasExited) process.Kill(); } catch { }
                send(new { type = "updateRejected", text = "更新器未及时就绪，现有程序继续运行，请稍后重试。" });
            };
            updater.OutputDataReceived += (sender, args) =>
            {
                if (args.Data != "updateReady" || closing) return;
                dispatcher.BeginInvoke(new Action(() =>
                {
                    if (cancelled || accepted || closing) return;
                    accepted = true; timer.Stop(); timer.Dispose(); ExitThread();
                }));
            };
            updater.Exited += (sender, args) =>
            {
                if (!closing) dispatcher.BeginInvoke(new Action(() =>
                {
                    if (!accepted && !cancelled) { timer.Stop(); timer.Dispose(); send(new { type = "updateRejected", text = "更新器启动失败，现有程序继续保留，请查看诊断日志。" }); }
                }));
                process.Dispose();
            };
            updater.Start(); updater.BeginOutputReadLine(); timer.Start();
        }
        catch (Exception error) { if (updater != null) updater.Dispose(); reportDiagnostic("updateStartFailed", error); send(new { type = "updateRejected", text = "无法启动更新器，请检查更新目录权限。" }); }
    }

    protected override void ExitThreadCore()
    {
        closing = true;
        prompts.Clear();
        send(new { type = "shutdown" });
        if (worker != null && !worker.HasExited && !worker.WaitForExit(5000)) worker.Kill();
        if (processJob != IntPtr.Zero) CloseHandle(processJob);
        icon.Visible = false; icon.Dispose(); dispatcher.Dispose();
        if (controlWindow != null) controlWindow.Dispose();
        if (worker != null) worker.Dispose();
        base.ExitThreadCore();
    }

    [StructLayout(LayoutKind.Sequential)] private struct jobBasicLimits { public long processTime, jobTime; public uint limitFlags; public UIntPtr minWorkingSet, maxWorkingSet; public uint processLimit; public UIntPtr affinity; public uint priority, scheduling; }
    [StructLayout(LayoutKind.Sequential)] private struct ioCounters { public ulong readOps, writeOps, otherOps, readBytes, writeBytes, otherBytes; }
    [StructLayout(LayoutKind.Sequential)] private struct jobExtendedLimits { public jobBasicLimits basic; public ioCounters io; public UIntPtr processMemory, jobMemory, peakProcessMemory, peakJobMemory; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetInformationJobObject(IntPtr job, int informationClass, IntPtr information, uint length);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
}
