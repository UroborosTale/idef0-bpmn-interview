// Настольное приложение: сервер (Node) + студия в WebView2 на всё окно; на месте холста диаграммы студия показывает Visio.
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
    private readonly SemaphoreSlim gate = new(1, 1);
    private Rectangle lastRect; // положение холста в CSS-пикселях студии
    private Diagram? wanted;
    private readonly TaskCompletionSource coreReady = new();

    public string SelfTestDir { get; set; } = "";

    public MainForm(ServerHost server, string workDir)
    {
        this.server = server;
        Text = "Процессная студия — Visio в редакторе";
        Width = 1800; Height = 1000;
        StartPosition = FormStartPosition.CenterScreen;

        visio = new VisioPane(workDir) { Visible = false };
        visio.Status += s => status.Text = s;

        web.Dock = DockStyle.Fill;
        var strip = new StatusStrip();
        strip.Items.Add(status);
        Controls.Add(web);
        Controls.Add(visio); // поверх студии: окно Visio закрывает область холста
        Controls.Add(strip);
        visio.BringToFront();

        Shown += async (_, _) => await Guard(async () =>
        {
            await web.EnsureCoreWebView2Async();
            web.CoreWebView2.WebMessageReceived += async (_, e) => await Guard(() => OnMessage(e.WebMessageAsJson));
            coreReady.TrySetResult();
            if (SelfTestDir == "") web.Source = new Uri(server.Url); // самопроверка открывает свою сессию сама
            status.Text = $"Сервер: {server.Url}";
        });
        FormClosed += (_, _) => server.Dispose();
    }

    private async Task OnMessage(string json)
    {
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;
        switch (root.GetProperty("t").GetString())
        {
            case "slot": await OnSlot(root); break;
            case "apply": await Apply(); break;
            case "reload": await Reload(); break;
            case "zoom": visio.SetZoom(root.GetProperty("value").GetDouble()); break;
            case "fit": visio.FitPage(); break;
            case "grid": visio.ToggleGrid(); break;
        }
    }

    /// <summary>Студия сообщила место холста и открытую диаграмму: кладём на это место Visio и показываем нужную страницу.</summary>
    private async Task OnSlot(JsonElement m)
    {
        if (!m.GetProperty("visible").GetBoolean()) { visio.Visible = false; return; }
        var r = m.GetProperty("rect");
        lastRect = new Rectangle((int)r.GetProperty("x").GetDouble(), (int)r.GetProperty("y").GetDouble(), (int)r.GetProperty("w").GetDouble(), (int)r.GetProperty("h").GetDouble());
        Place();
        var d = m.GetProperty("diagram");
        var kind = d.GetProperty("kind").GetString()!;
        var id = d.TryGetProperty(kind == "bpmn" ? "scope" : "parent", out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
        wanted = new Diagram(kind, id);
        var session = m.GetProperty("session").GetString()!;
        var updatedAt = m.GetProperty("updatedAt").GetString()!;

        await gate.WaitAsync();
        try
        {
            if (visio.LoadedSession != session || (visio.LoadedUpdatedAt != updatedAt && !visio.IsDirty))
                await visio.OpenSessionAsync(server, session, updatedAt);
            else if (visio.LoadedUpdatedAt != updatedAt)
                status.Text = "Модель изменена в студии, а в Visio есть непринятые правки — нажмите «Принять из Visio».";
            if (wanted != null && !visio.ShowDiagram(wanted)) status.Text = "В документе Visio нет страницы этой диаграммы.";
        }
        finally { gate.Release(); }
    }

    /// <summary>Координаты студии — CSS-пиксели, а окно — устройственные: умножаем на масштаб экрана.</summary>
    private void Place()
    {
        var s = web.DeviceDpi / 96f;
        visio.Bounds = new Rectangle(web.Left + (int)(lastRect.X * s), web.Top + (int)(lastRect.Y * s), (int)(lastRect.Width * s), (int)(lastRect.Height * s));
        visio.Visible = lastRect.Width > 0 && lastRect.Height > 0;
        visio.BringToFront();
    }

    /// <summary>«Перечитать»: открыть диаграмму из модели заново; непринятые правки Visio отбрасываются после подтверждения.</summary>
    private async Task Reload()
    {
        if (visio.LoadedSession == null) return;
        if (visio.IsDirty && MessageBox.Show(this, "Отбросить непринятые правки Visio и перечитать диаграмму из модели?", Text, MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return;
        await gate.WaitAsync();
        try
        {
            await visio.OpenSessionAsync(server, visio.LoadedSession, visio.LoadedUpdatedAt ?? "");
            if (wanted != null) visio.ShowDiagram(wanted);
        }
        finally { gate.Release(); }
    }

    private async Task Apply()
    {
        await gate.WaitAsync();
        try
        {
            var json = await visio.SendEditsAsync(server);
            using var doc = JsonDocument.Parse(json);
            var c = doc.RootElement.GetProperty("changes");
            int n(string k) => c.GetProperty(k).GetArrayLength();
            status.Text = $"Правки приняты: переименовано {n("renamed")}, новых шагов {n("added")}, стрелок {n("addedFlows")}; не найдено в файле {n("missing")}";
            web.Reload();
        }
        finally { gate.Release(); }
    }

    private async Task Guard(Func<Task> action)
    {
        try { await action(); }
        catch (Exception e)
        {
            status.Text = "Ошибка: " + e.Message;
            if (SelfTestDir == "") MessageBox.Show(this, e.Message, Text, MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    /// <summary>Самопроверка без участия пользователя: студия открывает диаграмму, Visio встаёт на её место; правка в Visio возвращается в модель.</summary>
    public async Task<string> SelfTestAsync()
    {
        var sb = new System.Text.StringBuilder();
        var list = await ServerHost.Http.GetStringAsync($"{server.Url}/api/sessions");
        var id = JsonDocument.Parse(list).RootElement.EnumerateArray().First().GetProperty("id").GetString()!;
        sb.AppendLine($"сессия: {id}");

        // 1) студия открывается, сама сообщает место холста — Visio появляется на нём
        await coreReady.Task;
        var loaded = new TaskCompletionSource<bool>();
        web.NavigationCompleted += (_, e) => loaded.TrySetResult(e.IsSuccess);
        web.Source = new Uri($"{server.Url}/s/{id}");
        if (!await loaded.Task) sb.AppendLine("ПРОВАЛ: студия не загрузилась в WebView2");
        for (var i = 0; i < 60 && !(visio.Visible && visio.LoadedSession == id && visio.CurrentPageName == "BPMN"); i++) await Task.Delay(500);
        sb.AppendLine($"Visio на месте холста: видимо={visio.Visible}, область={visio.Bounds.Width}×{visio.Bounds.Height} в точке {visio.Bounds.X},{visio.Bounds.Y}, страница «{visio.CurrentPageName}»");
        if (!visio.Visible || visio.Bounds.Width < 300 || visio.Bounds.Height < 200) sb.AppendLine("ПРОВАЛ: окно Visio не легло на место холста");
        if (visio.CurrentPageName != "BPMN") sb.AppendLine("ПРОВАЛ: ожидалась страница «BPMN» (общая схема)");
        sb.AppendLine($"линейки и ярлыки страниц скрыты: {visio.ChromeHidden}");
        if (!visio.ChromeHidden) sb.AppendLine("ПРОВАЛ: линейки или ярлыки страниц Visio остались");

        // панель инструментов диаграммы: масштаб, вписать, сетка
        visio.SetZoom(0.5);
        sb.AppendLine($"масштаб 50%: {visio.ZoomValue:0.00}");
        if (Math.Abs(visio.ZoomValue - 0.5) > 0.02) sb.AppendLine("ПРОВАЛ: масштаб не применился");
        var gridBefore = visio.GridShown;
        visio.ToggleGrid();
        sb.AppendLine($"сетка: было {gridBefore}, стало {visio.GridShown}");
        if (visio.GridShown == gridBefore) sb.AppendLine("ПРОВАЛ: сетка не переключилась");
        visio.ToggleGrid();
        visio.FitPage();

        // 2) переход на вкладку IDEF0 в студии переключает страницу Visio
        await web.CoreWebView2.ExecuteScriptAsync("(() => { const t = [...document.querySelectorAll('.doc-tabs [role=tab]')].find(e => /^IDEF0/.test((e.textContent || '').trim())); if (t) t.click(); return !!t; })()");
        for (var i = 0; i < 20 && !visio.CurrentPageName.StartsWith("IDEF0"); i++) await Task.Delay(400);
        sb.AppendLine($"после перехода на вкладку IDEF0: страница «{visio.CurrentPageName}»");
        if (!visio.CurrentPageName.StartsWith("IDEF0")) sb.AppendLine("ПРОВАЛ: страница Visio не переключилась на IDEF0");
        visio.ExportCurrentPage(Path.Combine(SelfTestDir, "visio-idef0.png"));

        // 3) правка в Visio → «Принять из Visio» (то же, что кнопка в ленте студии) → в модели
        const string mark = " ИЗ_VISIO";
        sb.AppendLine("правка в Visio: " + visio.RenameFirstNode(mark));
        await Apply();
        var model = await ServerHost.Http.GetStringAsync($"{server.Url}/api/sessions/{id}");
        sb.AppendLine(model.Contains(mark.Trim()) ? "OK: новое название есть в модели сессии" : "ПРОВАЛ: нового названия нет в модели");

        // 4) после перезагрузки студия возвращается на ту же вкладку, а Visio не открывается заново
        await Task.Delay(5000);
        sb.AppendLine($"после перезагрузки студии: страница «{visio.CurrentPageName}», непринятых правок: {(visio.IsDirty ? "есть" : "нет")}");
        if (!visio.CurrentPageName.StartsWith("IDEF0")) sb.AppendLine("ПРОВАЛ: вкладка не восстановилась после перезагрузки");

        using (var fs = File.Create(Path.Combine(SelfTestDir, "web.png"))) await web.CoreWebView2.CapturePreviewAsync(Microsoft.Web.WebView2.Core.CoreWebView2CapturePreviewImageFormat.Png, fs);
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
