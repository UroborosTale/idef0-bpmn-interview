// Настольная оболочка: сервер (Node) + студия в WebView2 слева + Visio в окне приложения справа.
// Аргументы: [--repo <корень репозитория>] [--data <каталог данных>] [--selftest <папка отчёта>]
using System.Text.Json;
using System.Windows.Forms;
using Microsoft.Web.WebView2.WinForms;

internal sealed class MainForm : Form
{
    private readonly ServerHost server;
    private readonly WebView2 web = new();
    private readonly VisioPane visio;
    private readonly ToolStripStatusLabel status = new() { Spring = true, TextAlign = ContentAlignment.MiddleLeft };

    public MainForm(ServerHost server, string workDir)
    {
        this.server = server;
        Text = "Процессный студия — Visio внутри";
        Width = 1800; Height = 1000;
        StartPosition = FormStartPosition.CenterScreen;

        visio = new VisioPane(workDir) { Dock = DockStyle.Fill };
        visio.Status += s => status.Text = s;

        var bar = new ToolStrip { GripStyle = ToolStripGripStyle.Hidden };
        var open = new ToolStripButton("Открыть сессию в Visio") { DisplayStyle = ToolStripItemDisplayStyle.Text };
        var send = new ToolStripButton("Принять правки из Visio") { DisplayStyle = ToolStripItemDisplayStyle.Text };
        open.Click += async (_, _) => await Guard(OpenCurrent);
        send.Click += async (_, _) => await Guard(SendEdits);
        bar.Items.AddRange(new ToolStripItem[] { open, new ToolStripSeparator(), send });

        var right = new Panel { Dock = DockStyle.Fill };
        right.Controls.Add(visio);
        right.Controls.Add(bar);

        web.Dock = DockStyle.Fill;
        var split = new SplitContainer { Dock = DockStyle.Fill, Orientation = Orientation.Vertical, SplitterDistance = 760 };
        split.Panel1.Controls.Add(web);
        split.Panel2.Controls.Add(right);

        var strip = new StatusStrip();
        strip.Items.Add(status);
        Controls.Add(split);
        Controls.Add(strip);
        Shown += async (_, _) => await Guard(async () =>
        {
            await web.EnsureCoreWebView2Async();
            web.Source = new Uri(server.Url);
            status.Text = $"Сервер: {server.Url}";
        });
        FormClosed += (_, _) => server.Dispose();
    }

    private string? CurrentSessionId()
    {
        var url = web.Source?.AbsolutePath ?? "";
        var m = System.Text.RegularExpressions.Regex.Match(url, @"^/s/([^/]+)");
        return m.Success ? m.Groups[1].Value : null;
    }

    private async Task OpenCurrent()
    {
        var id = CurrentSessionId() ?? throw new InvalidOperationException("Откройте сессию в студии слева (адрес вида /s/…).");
        await visio.OpenSessionAsync(server, id);
    }

    private async Task SendEdits()
    {
        var json = await visio.SendEditsAsync(server);
        using var doc = JsonDocument.Parse(json);
        var c = doc.RootElement.GetProperty("changes");
        int n(string k) => c.GetProperty(k).GetArrayLength();
        status.Text = $"Правки приняты: переименовано {n("renamed")}, новых шагов {n("added")}, стрелок {n("addedFlows")}; не найдено в файле {n("missing")}";
        web.Reload();
    }

    private async Task Guard(Func<Task> action)
    {
        try { await action(); }
        catch (Exception e) { status.Text = "Ошибка: " + e.Message; MessageBox.Show(this, e.Message, Text, MessageBoxButtons.OK, MessageBoxIcon.Warning); }
    }

    /// <summary>Самопроверка без участия пользователя: выгрузка → Visio → переименование → приём правок → проверка модели.</summary>
    public string SelfTestDir { get; set; } = "";

    public async Task<string> SelfTestAsync()
    {
        var sb = new System.Text.StringBuilder();
        var list = await ServerHost.Http.GetStringAsync($"{server.Url}/api/sessions");
        var id = JsonDocument.Parse(list).RootElement.EnumerateArray().First().GetProperty("id").GetString()!;
        sb.AppendLine($"сессия: {id}");
        await visio.OpenSessionAsync(server, id);
        const string mark = " ИЗ_VISIO";
        sb.AppendLine("правка в Visio: " + visio.RenameFirstNode(mark));
        var reply = await visio.SendEditsAsync(server);
        using (var d = JsonDocument.Parse(reply))
        {
            var renamed = d.RootElement.GetProperty("changes").GetProperty("renamed");
            sb.AppendLine($"сервер принял переименований: {renamed.GetArrayLength()}");
            foreach (var r in renamed.EnumerateArray()) sb.AppendLine($"  {r.GetProperty("from").GetString()} → {r.GetProperty("to").GetString()}");
            if (renamed.GetArrayLength() != 1) sb.AppendLine("ПРОВАЛ: ожидалась ровно одна правка");
        }
        var model = await ServerHost.Http.GetStringAsync($"{server.Url}/api/sessions/{id}");
        sb.AppendLine(model.Contains(mark.Trim()) ? "OK: новое название есть в модели сессии" : "ПРОВАЛ: нового названия нет в модели");

        // левая часть окна: студия в WebView2 открывается на этой сессии; снимок делает сам WebView2
        await web.EnsureCoreWebView2Async();
        var loaded = new TaskCompletionSource<bool>();
        web.NavigationCompleted += (_, e) => loaded.TrySetResult(e.IsSuccess);
        web.Source = new Uri($"{server.Url}/s/{id}");
        if (!await loaded.Task) sb.AppendLine("ПРОВАЛ: студия не загрузилась в WebView2");
        await Task.Delay(3500);
        var title = await web.CoreWebView2.ExecuteScriptAsync("document.querySelectorAll('.studio').length + ' studio, ' + document.querySelectorAll('svg').length + ' svg'");
        sb.AppendLine($"WebView2: {title}");
        if (!title.StartsWith("\"1 studio")) sb.AppendLine("ПРОВАЛ: студия не отрисована");
        using (var fs = File.Create(Path.Combine(SelfTestDir, "web.png"))) await web.CoreWebView2.CapturePreviewAsync(Microsoft.Web.WebView2.Core.CoreWebView2CapturePreviewImageFormat.Png, fs);
        visio.ExportPage(Path.Combine(SelfTestDir, "visio.png"));
        return sb.ToString();
    }
}

internal static class Program
{
    private static string Arg(string[] a, string name) => a.SkipWhile(x => x != name).Skip(1).FirstOrDefault() ?? "";

    [STAThread]
    private static int Main(string[] args)
    {
        ApplicationConfiguration.Initialize();
        var repo = Arg(args, "--repo");
        if (repo == "") repo = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", ".."));
        var selftest = Arg(args, "--selftest");
        var data = Arg(args, "--data");
        if (data == "") data = selftest != "" ? Path.Combine(selftest, "data") : Path.Combine(repo, "server", "data");
        var work = Path.Combine(selftest != "" ? selftest : Path.GetTempPath(), "visio-work");

        var server = new ServerHost(repo, data);
        try
        {
            if (selftest != "") Directory.CreateDirectory(selftest);
            // синхронно: ActiveX (Visio) требует однопоточного режима, а после await поток был бы другим
            server.StartAsync().GetAwaiter().GetResult();
            if (selftest != "") Seed(repo, server.Url).GetAwaiter().GetResult();
        }
        catch (Exception e)
        {
            if (selftest != "") File.WriteAllText(Path.Combine(selftest, "selftest.log"), "ОШИБКА запуска сервера: " + e.Message);
            else MessageBox.Show(e.Message, "Запуск сервера", MessageBoxButtons.OK, MessageBoxIcon.Error);
            server.Dispose();
            return 1;
        }

        var form = new MainForm(server, work) { SelfTestDir = selftest };
        if (selftest == "")
        {
            Application.Run(form);
            return 0;
        }
        var code = 0;
        form.Shown += async (_, _) =>
        {
            string report;
            try { report = await form.SelfTestAsync(); }
            catch (Exception e) { report = "ОШИБКА: " + e; code = 1; }
            if (report.Contains("ПРОВАЛ") || report.Contains("ОШИБКА")) code = 1;
            await File.WriteAllTextAsync(Path.Combine(selftest, "selftest.log"), report);
            form.Close();
        };
        Application.Run(form);
        return code;
    }

    /// <summary>Заполняет временную базу демо-процессом через API (сценарий seed:demo сервера).</summary>
    private static async Task Seed(string repo, string apiUrl)
    {
        var tsx = Path.Combine(repo, "node_modules", "tsx", "dist", "cli.mjs");
        var psi = new System.Diagnostics.ProcessStartInfo("node", $"\"{tsx}\" src/scripts/seed-process.ts demo") { WorkingDirectory = Path.Combine(repo, "server"), UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
        psi.Environment["PM_API_URL"] = apiUrl;
        using var p = System.Diagnostics.Process.Start(psi)!;
        await p.WaitForExitAsync();
        if (p.ExitCode != 0) throw new InvalidOperationException("seed:demo не выполнился: " + await p.StandardError.ReadToEndAsync());
    }
}
