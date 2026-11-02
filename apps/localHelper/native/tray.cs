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
            Application.Run(new trayContext());
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
    private readonly Dictionary<string, Form> prompts = new Dictionary<string, Form>();
    private Process worker;
    private IntPtr processJob;
    private bool closing;
    private string status = "正在连接平台";
    private string code = "连接后显示";
    private string server = "https://yixian.lol/flow/";
    private string owner = "尚未绑定";
    private Form chatWindow;
    private TextBox chatLog;
    private TextBox chatInput;
    private Button chatSend;
    private Button chatStop;
    private Button chatNew;
    private bool chatRunning;

    public trayContext()
    {
        dispatcher.CreateControl();
        serializer.MaxJsonLength = 1024 * 1024;
        icon = new NotifyIcon { Text = "UnionFlfow 本地助手", Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath), Visible = true };
        var menu = new ContextMenuStrip();
        menu.Items.Add("打开 UnionFlfow", null, (sender, args) => Process.Start(new ProcessStartInfo(server) { UseShellExecute = true }));
        menu.Items.Add("本机 AI 助手", null, (sender, args) => showChat());
        menu.Items.Add("状态与配对码", null, (sender, args) => showStatus());
        menu.Items.Add("复制配对码", null, (sender, args) => Clipboard.SetText(code.Replace("-", "")));
        menu.Items.Add(new ToolStripSeparator());
        pauseItem.Click += (sender, args) => send(new { type = "pause", value = !pauseItem.Checked });
        automaticItem.Click += (sender, args) =>
        {
            bool allow = !automaticItem.Checked;
            if (allow && MessageBox.Show("仅在你信任当前账户与本轮 AI 操作时开启。\n\n开启后，AI 可以自动写入、上传下载和删除文件、执行 PowerShell、安装软件，权限与当前 Windows 用户相同。\n本设置在退出助手后失效，可随时暂停或关闭。\n\n是否开启？", "允许自动执行", MessageBoxButtons.YesNo, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2) != DialogResult.Yes) return;
            send(new { type = "automatic", value = allow });
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
            }
            catch (Exception error) { MessageBox.Show(error.Message, "设置开机启动失败"); }
        };
        menu.Items.Add(startupItem);
        menu.Items.Add("重新连接进程", null, (sender, args) => startWorker());
        menu.Items.Add("解除绑定并生成新配对码", null, (sender, args) =>
        {
            if (MessageBox.Show("解除当前账户的本机访问权限，并取消正在执行的本机任务？", "解除绑定", MessageBoxButtons.YesNo, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2) == DialogResult.Yes)
                send(new { type = "reset" });
        });
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("退出", null, (sender, args) => ExitThread());
        icon.ContextMenuStrip = menu;
        icon.DoubleClick += (sender, args) => showChat();
        startWorker();
    }

    private bool startupEnabled()
    {
        using (var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run"))
            return key != null && String.Equals(key.GetValue("UnionFlfowLocalHelper") as string, "\"" + Application.ExecutablePath + "\"", StringComparison.OrdinalIgnoreCase);
    }

    private void showStatus()
    {
        MessageBox.Show("状态：" + status + "\n账户：" + owner + "\n服务：" + server + "\n\n配对码：" + code + "\n\n网页：设置 → 本地助手 → 输入配对码。\n网页任务需保持原对话连接；托盘聊天可单独使用。", "UnionFlfow 本地助手", MessageBoxButtons.OK, MessageBoxIcon.Information);
    }

    private void showChat()
    {
        if (chatWindow != null) { chatWindow.Show(); chatWindow.Activate(); return; }
        chatWindow = new Form { Text = "UnionFlow · 本机 AI 助手", Width = 820, Height = 650,
            StartPosition = FormStartPosition.CenterScreen, Font = new Font("Microsoft YaHei UI", 10), AutoScaleMode = AutoScaleMode.Dpi };
        chatLog = new TextBox { Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical, Dock = DockStyle.Fill,
            BackColor = SystemColors.Window, AccessibleName = "本机智能体对话记录" };
        chatInput = new TextBox { Multiline = true, Height = 100, MaxLength = 32000, Dock = DockStyle.Bottom,
            ScrollBars = ScrollBars.Vertical, AccessibleName = "发送给本机智能体的消息" };
        var actions = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 55, FlowDirection = FlowDirection.RightToLeft, Padding = new Padding(8) };
        chatSend = new Button { Text = "发送", Width = 100, Height = 32, Enabled = !chatRunning };
        chatStop = new Button { Text = "停止", Width = 100, Height = 32, Enabled = chatRunning };
        chatNew = new Button { Text = "新对话", Width = 100, Height = 32, Enabled = !chatRunning };
        chatSend.Click += (sender, args) =>
        {
            string text = chatInput.Text.Trim();
            if (text.Length == 0 || chatRunning) return;
            appendChat("我", text);
            chatInput.Clear();
            setChatRunning(true);
            if (!send(new { type = "chat", text = text })) { setChatRunning(false); appendChat("提示", "本地进程未连接，请从托盘重新连接进程。"); }
        };
        chatStop.Click += (sender, args) => send(new { type = "chatCancel" });
        chatNew.Click += (sender, args) => send(new { type = "chatReset" });
        actions.Controls.Add(chatSend); actions.Controls.Add(chatStop); actions.Controls.Add(chatNew);
        chatWindow.Controls.Add(chatLog); chatWindow.Controls.Add(chatInput); chatWindow.Controls.Add(actions);
        chatWindow.FormClosing += (sender, args) => { if (!closing) { args.Cancel = true; chatWindow.Hide(); } };
        chatWindow.Show(); chatInput.Focus();
    }

    private void appendChat(string role, string text)
    {
        if (chatLog == null) return;
        // ACT: 窗口最多保留约 262144 字符，不把本机文件正文写入聊天日志文件。
        if (chatLog.TextLength + text.Length > 262144) chatLog.Text = chatLog.Text.Substring(Math.Max(0, chatLog.TextLength - 131072));
        chatLog.AppendText(role + "：" + text + Environment.NewLine + Environment.NewLine);
    }

    private void setChatRunning(bool running)
    {
        chatRunning = running;
        if (chatSend == null) return;
        chatSend.Enabled = !running;
        chatStop.Enabled = running;
        chatNew.Enabled = !running;
    }

    private void startWorker()
    {
        if (worker != null && !worker.HasExited) { showStatus(); return; }
        try
        {
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
                if (!String.IsNullOrEmpty(args.Data) && !closing) dispatcher.BeginInvoke(new Action(() => { status = args.Data; }));
            };
            worker.Exited += (sender, args) =>
            {
                if (!closing) dispatcher.BeginInvoke(new Action(() =>
                {
                    status = "本地进程已停止，请从托盘重新连接";
                    automaticItem.Checked = false;
                    setChatRunning(false);
                    appendChat("提示", "本地进程已停止，请重新连接；不会自动重新发送消息或执行操作。");
                    icon.ShowBalloonTip(5000, "UnionFlfow 本地助手", status, ToolTipIcon.Warning);
                    foreach (var form in new List<Form>(prompts.Values)) form.Close();
                }));
            };
            worker.Start();
            if (!AssignProcessToJobObject(processJob, worker.Handle))
            {
                worker.Kill();
                throw new System.ComponentModel.Win32Exception();
            }
            worker.StandardInput.AutoFlush = true;
            worker.BeginOutputReadLine();
            worker.BeginErrorReadLine();
        }
        catch (Exception error) { status = error.Message; MessageBox.Show(error.Message, "本地助手启动失败"); }
    }

    private bool send(object message)
    {
        try { if (worker != null && !worker.HasExited) { worker.StandardInput.WriteLine(serializer.Serialize(message)); return true; } }
        catch (Exception error) { status = "本地进程通信失败：" + error.Message; }
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
            string type = value(message, "type");
            if (type == "chat")
            {
                string role = value(message, "role");
                appendChat(role == "assistant" ? "AI" : role == "tool" ? "本机工具" : "提示", value(message, "text"));
                if (value(message, "done") == "True") setChatRunning(false);
            }
            if (type == "chatState") setChatRunning(value(message, "running") == "True");
            if (type == "chatReset") { if (chatLog != null) chatLog.Clear(); }
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
            if (type == "dismiss")
            {
                Form prompt;
                if (prompts.TryGetValue(value(message, "id"), out prompt)) prompt.Close();
            }
        }
        catch (Exception error) { status = "消息处理失败：" + error.Message; }
    }

    private void showConfirmation(string id, string title, string detail)
    {
        if (prompts.ContainsKey(id)) return;
        var form = new Form { Text = "UnionFlfow · " + title, Width = 720, Height = 530, StartPosition = FormStartPosition.CenterScreen,
            MinimizeBox = false, MaximizeBox = false, TopMost = true, Font = new Font("Microsoft YaHei UI", 10), AutoScaleMode = AutoScaleMode.Dpi };
        var text = new TextBox { Text = detail, Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Both, Dock = DockStyle.Fill,
            BorderStyle = BorderStyle.None, BackColor = SystemColors.Window, WordWrap = false, AccessibleName = "本机操作详情" };
        var buttons = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 60, FlowDirection = FlowDirection.RightToLeft, Padding = new Padding(10) };
        var deny = new Button { Text = "拒绝", Width = 100, Height = 34 };
        var allow = new Button { Text = "允许本次操作", Width = 140, Height = 34 };
        bool answered = false;
        deny.Click += (sender, args) => { answered = true; send(new { type = "approval", id = id, allowed = false }); form.Close(); };
        allow.Click += (sender, args) => { answered = true; send(new { type = "approval", id = id, allowed = true }); form.Close(); };
        buttons.Controls.Add(deny); buttons.Controls.Add(allow);
        form.Controls.Add(text); form.Controls.Add(buttons);
        form.CancelButton = deny;
        form.FormClosed += (sender, args) => { prompts.Remove(id); if (!answered) send(new { type = "approval", id = id, allowed = false }); form.Dispose(); };
        prompts[id] = form;
        form.Show(); form.Activate(); deny.Focus();
    }

    protected override void ExitThreadCore()
    {
        closing = true;
        foreach (var form in new List<Form>(prompts.Values)) form.Close();
        send(new { type = "shutdown" });
        if (worker != null && !worker.HasExited && !worker.WaitForExit(5000)) worker.Kill();
        if (processJob != IntPtr.Zero) CloseHandle(processJob);
        icon.Visible = false; icon.Dispose(); dispatcher.Dispose();
        if (chatWindow != null) chatWindow.Dispose();
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
