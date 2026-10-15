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
        // строка состояния как в Business Studio: слева сообщения, справа язык, дата и период
        var strip = new StatusStrip { BackColor = Color.FromArgb(0xD6, 0xDA, 0xDE), SizingGrip = false };
        strip.Items.Add(status);
        foreach (var text in new[] { System.Globalization.CultureInfo.CurrentUICulture.NativeName.Replace("русский", "Русский"), DateTime.Today.ToString("dd.MM.yyyy"), "Период: сегодня" })
            strip.Items.Add(new ToolStripStatusLabel(text) { BorderSides = ToolStripStatusLabelBorderSides.Left, BorderStyle = Border3DStyle.Etched, Padding = new Padding(4, 0, 4, 0) });
        Controls.Add(web);
        Controls.Add(visio); // поверх студии: окно Visio закрывает область холста
        Controls.Add(strip);
        visio.BringToFront();

        Shown += async (_, _) => await Guard(async () =>
        {
            await web.EnsureCoreWebView2Async();
            web.CoreWebView2.WebMessageReceived += async (_, e) => await Guard(() => OnMessage(e.WebMessageAsJson));
            coreReady.TrySetResult();
            if (SelfTestDir == "")
            {
                web.Source = new Uri(server.Url);
                poll.Tick += async (_, _) => await Guard(PollTick); // самопроверка вызывает PollTick сама
                poll.Start();
            }
            status.Text = $"Сервер: {server.Url}";
        });
        var hotkeys = new Hotkeys(this);
        FormClosed += (_, _) => { hotkeys.Dispose(); server.Dispose(); };
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
            case "menu": ShowMenu(root); break;
            case "select-many":
                {
                    var ids = root.GetProperty("ids").EnumerateArray().Select(x => x.GetString() ?? "").ToHashSet();
                    var n = visio.SelectMany(ids);
                    status.Text = $"Выделено подобных фигур: {n}";
                    break;
                }
            case "cmd": RunCommand(root.GetProperty("name").GetString() ?? ""); break;
            case "open-visio": await OpenInVisio(); break;
            case "tool": visio.SetTool(root.GetProperty("tool").GetString() ?? ""); break;
            case "grid": visio.ToggleGrid(); break;
            case "drop": await OnDrop(root); break;
            case "select":
                // студия выбрала шаг — выделяем его фигуру в Visio; выделение не эхом возвращается в студию
                if (visio.Visible && visio.SelectNode(root.GetProperty("id").GetString() ?? "")) lastSel = visio.SelectedTag();
                break;
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

    /// <summary>
    /// Выпадающее меню студии («Действия», список масштабов) показывается меню Windows: HTML-меню студии оказалось бы под окном Visio.
    /// Выбранный пункт возвращается студии сообщением menu-pick, закрытие без выбора — menu-closed.
    /// </summary>
    private void ShowMenu(JsonElement m)
    {
        var id = m.GetProperty("id").GetString() ?? "";
        var r = m.GetProperty("rect");
        var s = web.DeviceDpi / 96f;
        var at = r.TryGetProperty("cursor", out var cur) && cur.ValueKind == JsonValueKind.True
            ? Cursor.Position
            : web.PointToScreen(new Point((int)(r.GetProperty("x").GetDouble() * s), (int)((r.GetProperty("y").GetDouble() + r.GetProperty("h").GetDouble()) * s)));
        var menu = new ContextMenuStrip { ShowImageMargin = false, Font = new Font("Segoe UI", 9f) };
        string? picked = null;
        // пункты: обычный (id), заголовок группы (group — разделитель) и подменю (items — вложенные пункты, как «Тип задачи ▸»)
        void Fill(ToolStripItemCollection into, JsonElement list)
        {
            foreach (var it in list.EnumerateArray())
            {
                if (it.TryGetProperty("group", out var g) && g.ValueKind == JsonValueKind.String)
                {
                    if (into.Count > 0) into.Add(new ToolStripSeparator());
                    continue;
                }
                var item = new ToolStripMenuItem(it.GetProperty("label").GetString())
                {
                    Tag = it.TryGetProperty("id", out var idv) ? idv.GetString() : null,
                    ShortcutKeyDisplayString = it.TryGetProperty("kbd", out var k) && k.ValueKind == JsonValueKind.String ? k.GetString() : null,
                    Checked = it.TryGetProperty("checked", out var c) && c.ValueKind == JsonValueKind.True,
                    Enabled = !(it.TryGetProperty("disabled", out var d) && d.ValueKind == JsonValueKind.True),
                };
                if (it.TryGetProperty("items", out var sub) && sub.ValueKind == JsonValueKind.Array)
                {
                    ((ToolStripDropDownMenu)item.DropDown).ShowImageMargin = false;
                    ((ToolStripDropDownMenu)item.DropDown).ShowCheckMargin = true;
                    Fill(item.DropDownItems, sub);
                }
                else item.Click += (_, _) => picked = (string?)item.Tag;
                into.Add(item);
            }
        }
        menu.ShowCheckMargin = true;
        Fill(menu.Items, m.GetProperty("items"));
        menu.Closed += (_, _) => BeginInvoke(() =>
        {
            PostToWeb(picked != null ? JsonSerializer.Serialize(new { t = "menu-pick", id, item = picked }) : JsonSerializer.Serialize(new { t = "menu-closed", id }));
            menu.Dispose();
        });
        menu.Show(at);
    }

    /// <summary>Меню объекта под курсором: что выделено в Visio, студия решает сама (у шага — тип задачи и цикла, у пустого места — страница).</summary>
    private void ShowShapeMenu()
    {
        visio.SelectAt(visio.ToClient(Cursor.Position));
        var tag = visio.SelectedTag();
        PostToWeb(JsonSerializer.Serialize(new { t = "shape-menu", kind = tag?.Kind, id = tag?.Id }));
    }

    private void RunCommand(string name)
    {
        if (!visio.Visible) return;
        if (!visio.RunCommand(name)) status.Text = "Visio не выполнил команду — выберите фигуры на диаграмме и повторите";
    }

    /// <summary>«Открыть диаграмму в MS Visio»: выгрузка модели в файл и открытие его в полном Visio (правки там в модель не возвращаются).</summary>
    private async Task OpenInVisio()
    {
        if (visio.LoadedSession == null) return;
        if (visio.IsDirty && MessageBox.Show(this, "В окне Visio есть непринятые правки. Записать их в модель перед открытием в MS Visio?", Text, MessageBoxButtons.YesNo, MessageBoxIcon.Question) == DialogResult.Yes)
            await Apply();
        var bytes = await ServerHost.Http.GetByteArrayAsync($"{server.Url}/api/sessions/{visio.LoadedSession}/export/vsdx");
        var file = Path.Combine(Path.GetTempPath(), $"Процесс {DateTime.Now:yyyy-MM-dd HH-mm-ss}.vsdx");
        await File.WriteAllBytesAsync(file, bytes);
        System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(file) { UseShellExecute = true });
        status.Text = $"Открыто в MS Visio: {file} — правки в этом файле в модель не возвращаются";
    }

    /// <summary>
    /// Горячие клавиши, как в Business Studio, пока фокус в окне Visio: Ctrl+E — свойства объекта, Shift+Ctrl+P — формат по образцу.
    /// F8 (выравнивание), Alt+F9 (привязка) и Shift+F5 (параметры страницы) Visio обрабатывает сам. Клавиши окна Visio не проходят
    /// через фильтр сообщений WinForms, поэтому используется перехватчик клавиатуры потока (WH_KEYBOARD).
    /// </summary>
    private sealed class Hotkeys : IDisposable
    {
        private delegate IntPtr HookProc(int code, IntPtr wParam, IntPtr lParam);
        [System.Runtime.InteropServices.DllImport("user32.dll")] private static extern IntPtr SetWindowsHookEx(int idHook, HookProc fn, IntPtr hMod, uint threadId);
        [System.Runtime.InteropServices.DllImport("user32.dll")] private static extern bool UnhookWindowsHookEx(IntPtr hook);
        [System.Runtime.InteropServices.DllImport("user32.dll")] private static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);
        [System.Runtime.InteropServices.DllImport("user32.dll")] private static extern short GetKeyState(int key);
        [System.Runtime.InteropServices.DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
        private const int WH_KEYBOARD = 2;
        private readonly MainForm form;
        private readonly HookProc proc; // держим делегат, иначе его соберёт сборщик мусора
        private readonly IntPtr hook;
        private const int WH_MOUSE = 7, WM_RBUTTONUP = 0x205;
        private readonly HookProc mouseProc;
        private readonly IntPtr mouseHook;

        public Hotkeys(MainForm form)
        {
            this.form = form;
            proc = OnKey;
            hook = SetWindowsHookEx(WH_KEYBOARD, proc, IntPtr.Zero, GetCurrentThreadId());
            mouseProc = OnMouse;
            mouseHook = SetWindowsHookEx(WH_MOUSE, mouseProc, IntPtr.Zero, GetCurrentThreadId());
        }

        /// <summary>
        /// Правый щелчок в окне Visio: нажатие Visio обрабатывает сам (выделяет фигуру под курсором), а отпускание перехватывается —
        /// вместо меню Visio студия показывает меню объекта, как в Business Studio (тип задачи, тип цикла, свойства…).
        /// </summary>
        private IntPtr OnMouse(int code, IntPtr wParam, IntPtr lParam)
        {
            if (code == 0 && (int)wParam == WM_RBUTTONUP && form.visio.Visible && form.visio.ScreenBounds.Contains(Cursor.Position))
            {
                form.BeginInvoke(form.ShowShapeMenu);
                return (IntPtr)1;
            }
            return CallNextHookEx(mouseHook, code, wParam, lParam);
        }

        private IntPtr OnKey(int code, IntPtr wParam, IntPtr lParam)
        {
            // code 0 — клавиша снимается с очереди; бит 31 lParam — отпускание
            if (code == 0 && ((long)lParam & 0x80000000) == 0 && form.visio.Visible && form.visio.HasFocusWithin)
            {
                var key = (Keys)(int)wParam;
                bool down(int vk) => (GetKeyState(vk) & 0x8000) != 0;
                var ctrl = down(0x11);
                var shift = down(0x10);
                var alt = down(0x12);
                if (key == Keys.E && ctrl && !shift && !alt)
                {
                    form.BeginInvoke(() => form.PostToWeb("{\"t\":\"props\"}"));
                    return (IntPtr)1;
                }
                if (key == Keys.P && ctrl && shift && !alt)
                {
                    form.BeginInvoke(() => form.RunCommand("formatpainter"));
                    return (IntPtr)1;
                }
            }
            return CallNextHookEx(hook, code, wParam, lParam);
        }

        public void Dispose()
        {
            UnhookWindowsHookEx(hook);
            UnhookWindowsHookEx(mouseHook);
        }
    }

    /// <summary>Фигура из палитры: при перетаскивании — в точку, где отпустили кнопку (если она над Visio), при щелчке — в центр.</summary>
    private async Task OnDrop(JsonElement m)
    {
        if (!visio.Visible) return;
        var kind = m.GetProperty("kind").GetString() ?? "";
        var dragged = m.TryGetProperty("dragged", out var d) && d.GetBoolean();
        Point? at = null;
        if (dragged)
        {
            var c = visio.ToClient(Cursor.Position);
            if (c.X < 0 || c.Y < 0 || c.X > visio.Width || c.Y > visio.Height) return; // отпустили вне диаграммы — отмена
            at = c;
        }
        if (kind.Split(':').Length > 2) await visio.PrepareEventShapesAsync(server);
        var made = visio.DropMaster(kind, at);
        status.Text = made == null ? "Не удалось создать фигуру: в документе нет нужного мастера" : $"Создана фигура «{made}» — нажмите «Записать правки», чтобы она стала шагом модели";
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

    private void PostToWeb(string json)
    {
        try { web.CoreWebView2?.PostWebMessageAsJson(json); } catch { /* студия ещё не загружена */ }
    }

    /// <summary>
    /// Принять правки из Visio: файл уходит на сервер, новые фигуры помечаются id созданных шагов (иначе следующий приём создал бы
    /// их заново), студия получает обновлённую сессию без перезагрузки страницы. Возвращает ответ сервера (JSON).
    /// </summary>
    private string? declinedDeletion;

    private async Task<string> Apply(bool auto = false)
    {
        await gate.WaitAsync();
        try
        {
            var json = await visio.SendEditsAsync(server);
            // удалённое в Visio: пользователь решает, убирать ли это и из модели (по умолчанию в модели всё остаётся)
            int Count(JsonElement ch, string k) => ch.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.Array ? v.GetArrayLength() : 0;
            string MissingKey(JsonElement ch) => string.Join(",", new[] { "missing", "missingFlows" }.SelectMany(k => ch.GetProperty(k).EnumerateArray().Select(x => x.GetString())))
                + "|" + string.Join(",", ch.GetProperty("idef0").GetProperty("missingFunctions").EnumerateArray().Select(x => x.GetString()))
                + "|" + string.Join(",", ch.GetProperty("idef0").GetProperty("missingArrows").EnumerateArray().Select(x => x.GetString()));
            using (var first = JsonDocument.Parse(json))
            {
                var ch = first.RootElement.GetProperty("changes");
                var gone = Count(ch, "missing");
                var goneFlows = Count(ch, "missingFlows");
                var goneFns = Count(ch.GetProperty("idef0"), "missingFunctions");
                var goneArrows = Count(ch.GetProperty("idef0"), "missingArrows");
                var key = MissingKey(ch);
                if (gone + goneFlows + goneFns + goneArrows > 0 && key != declinedDeletion)
                {
                    var what = string.Join(", ", new[] { gone > 0 ? $"шагов BPMN: {gone}" : "", goneFlows > 0 ? $"стрелок BPMN: {goneFlows}" : "", goneFns > 0 ? $"функций IDEF0: {goneFns}" : "", goneArrows > 0 ? $"стрелок IDEF0: {goneArrows}" : "" }.Where(x => x != ""));
                    var ask = MessageBox.Show(this, $"В Visio удалено: {what}.\n\nУдалить это и из модели процесса? (Функция уходит вместе с вложенными функциями и шагами её диаграмм.)", Text, MessageBoxButtons.YesNo, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2);
                    if (ask == DialogResult.Yes) { json = await visio.SendEditsAsync(server, deleteMissing: true); declinedDeletion = null; }
                    else declinedDeletion = key; // тот же набор больше не спрашиваем, пока не изменится
                }
            }
            using var doc = JsonDocument.Parse(json);
            var c = doc.RootElement.GetProperty("changes");
            int n(string k) => c.GetProperty(k).GetArrayLength();
            visio.TagCreated(c);
            var changed = n("renamed") + n("added") + n("addedFlows") + n("flowsRenamed");
            status.Text = (auto ? "Автоматически: " : "") + $"правки приняты: переименовано {n("renamed")}, новых шагов {n("added")}, стрелок {n("addedFlows")}" + (n("missing") + n("missingFlows") > 0 ? $"; удалено в Visio {n("missing")} шагов и {n("missingFlows")} стрелок (в модели остались)" : "") + (c.TryGetProperty("deleted", out var del) && del.GetProperty("nodes").GetInt32() + del.GetProperty("flows").GetInt32() > 0 ? $"; из модели удалено: объектов {del.GetProperty("nodes").GetInt32()}, стрелок {del.GetProperty("flows").GetInt32()}" : "");
            if (!auto || changed > 0) PostToWeb("{\"t\":\"session\",\"session\":" + doc.RootElement.GetProperty("session").GetRawText() + "}");
            return json;
        }
        finally { gate.Release(); }
    }

    // ——— живая связь студии и Visio: выделение и автоприём правок ———
    private (string Kind, string Id)? lastSel;
    private (string Kind, string Id)? selAtDirty;
    private DateTime dirtySince = DateTime.MinValue;
    private bool polling;
    private readonly System.Windows.Forms.Timer poll = new() { Interval = 400 };

    /// <summary>Раз в 0,4 с: выделенная в Visio фигура уходит в студию (панель свойств), а накопившиеся правки принимаются сами.</summary>
    public async Task PollTick()
    {
        if (polling || !visio.Visible || visio.LoadedSession == null || !coreReady.Task.IsCompleted) return;
        polling = true;
        try
        {
            var sel = visio.SelectedTag();
            if (sel != lastSel)
            {
                lastSel = sel;
                if (sel is { } t) PostToWeb("{\"t\":\"visio-select\",\"kind\":" + JsonSerializer.Serialize(t.Kind == "flow" ? "flow" : "node") + ",\"id\":" + JsonSerializer.Serialize(t.Id) + "}");
            }
            if (!visio.IsDirty) { dirtySince = DateTime.MinValue; return; }
            if (dirtySince == DateTime.MinValue) { dirtySince = DateTime.UtcNow; selAtDirty = sel; }
            var elapsed = (DateTime.UtcNow - dirtySince).TotalMilliseconds;
            // правка закончена: кнопка мыши отпущена и либо выделение сменилось (пользователь перешёл к другой фигуре), либо тишина 5 с
            if (Control.MouseButtons == MouseButtons.None && ((sel != selAtDirty && elapsed >= 400) || elapsed >= 5000))
            {
                dirtySince = DateTime.MinValue;
                await Apply(auto: true);
            }
        }
        finally { polling = false; }
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
        VisioPane.Trace = t => File.AppendAllText(Path.Combine(SelfTestDir, "progress.log"), "  · " + t + Environment.NewLine);
        void L(string line) { sb.AppendLine(line); File.AppendAllText(Path.Combine(SelfTestDir, "progress.log"), line + Environment.NewLine); }
        var list = await ServerHost.Http.GetStringAsync($"{server.Url}/api/sessions");
        var id = JsonDocument.Parse(list).RootElement.EnumerateArray().First().GetProperty("id").GetString()!;
        L($"сессия: {id}");

        // 1) студия открывается, сама сообщает место холста — Visio появляется на нём
        await coreReady.Task;
        var loaded = new TaskCompletionSource<bool>();
        web.NavigationCompleted += (_, e) => loaded.TrySetResult(e.IsSuccess);
        web.Source = new Uri($"{server.Url}/s/{id}");
        if (!await loaded.Task) L("ПРОВАЛ: студия не загрузилась в WebView2");
        for (var i = 0; i < 60 && !(visio.Visible && visio.LoadedSession == id && visio.CurrentPageName == "BPMN"); i++) await Task.Delay(500);
        L($"Visio на месте холста: видимо={visio.Visible}, область={visio.Bounds.Width}×{visio.Bounds.Height} в точке {visio.Bounds.X},{visio.Bounds.Y}, страница «{visio.CurrentPageName}»");
        if (!visio.Visible || visio.Bounds.Width < 300 || visio.Bounds.Height < 200) L("ПРОВАЛ: окно Visio не легло на место холста");
        if (visio.CurrentPageName != "BPMN") L("ПРОВАЛ: ожидалась страница «BPMN» (общая схема)");
        L($"линейки и ярлыки страниц скрыты: {visio.ChromeHidden}");
        if (!visio.ChromeHidden) L("ПРОВАЛ: линейки или ярлыки страниц Visio остались");

        // палитра: фигура создаётся на странице операции и после «Записать правки» становится шагом модели
        var scope = JsonDocument.Parse(await ServerHost.Http.GetStringAsync($"{server.Url}/api/sessions/{id}")).RootElement.GetProperty("model").GetProperty("nodes").EnumerateArray()
            .Select(n => n.TryGetProperty("bpmn_scope", out var b) && b.ValueKind == JsonValueKind.String ? b.GetString() : null).First(x => x != null)!;
        visio.ShowDiagram(new Diagram("bpmn", scope));
        var before = visio.ShapeCount;
        var drops = new[] { "task", "gateway:exclusive", "event:end", "event:intermediate:timer" };
        await visio.PrepareEventShapesAsync(server);
        var madeAll = drops.Select(k => visio.DropMaster(k, null)).ToList();
        L($"палитра: создано {string.Join(", ", madeAll.Select(m => $"«{m}»"))}; фигур на странице {before} → {visio.ShapeCount}");
        if (madeAll.Any(m => m == null) || visio.ShapeCount != before + drops.Length) L("ПРОВАЛ: фигуры из палитры не созданы");
        var applied = await Apply(); // общий путь кнопки «Записать правки»: приём, пометка новых фигур, сессия в студию
        using (var ad = JsonDocument.Parse(applied)) L($"после «Записать правки»: новых шагов {ad.RootElement.GetProperty("changes").GetProperty("added").GetArrayLength()}");
        var nodesJson = await ServerHost.Http.GetStringAsync($"{server.Url}/api/sessions/{id}");
        var added = JsonDocument.Parse(nodesJson).RootElement.GetProperty("model").GetProperty("nodes").EnumerateArray().Where(n => n.TryGetProperty("tags", out var tg) && tg.EnumerateArray().Any(t => t.GetString() == "added_externally")).ToList();
        L("новые шаги в модели: " + string.Join("; ", added.Select(n => $"{n.GetProperty("type").GetString()}:{n.GetProperty("name").GetString()}")));
        if (!added.Any(n => n.GetProperty("type").GetString() == "event" && n.TryGetProperty("trigger", out var tr) && tr.ValueKind == JsonValueKind.Object && tr.GetProperty("type").GetString() == "timer")) L("ПРОВАЛ: событие-таймер из палитры не стало событием с триггером «таймер»");
        if (added.Count != drops.Length || !added.Any(n => n.GetProperty("name").GetString() == "Новая задача" && n.GetProperty("type").GetString() == "task")) L("ПРОВАЛ: фигуры из палитры не стали шагами модели");
        // повторный приём без правок не должен создавать шаги заново: новые фигуры помечены id созданных шагов
        var again = await Apply();
        using (var ad2 = JsonDocument.Parse(again))
        {
            var n2 = ad2.RootElement.GetProperty("changes").GetProperty("added").GetArrayLength();
            L($"повторный приём: новых шагов {n2}");
            if (n2 != 0) L("ПРОВАЛ: повторный приём создал дубликаты");
        }
        // живая связь: фигура, выделенная в Visio, открывается в панели свойств студии
        var taskId = added.First(n => n.GetProperty("name").GetString() == "Новая задача").GetProperty("id").GetString()!;
        PostToWeb("{\"t\":\"props\"}"); // как в Business Studio, панель свойств скрыта, пока её не открыли (Ctrl+E)
        await Task.Delay(500);
        visio.ShowDiagram(new Diagram("bpmn", scope)); // панель свойств изменила размер холста, и студия вернула свою страницу — самопроверка снова открывает страницу операции
        L($"выделение в Visio: {visio.SelectNode(taskId)}; метка: {visio.SelectedTag()}");
        await PollTick();
        await Task.Delay(1500);
        var props = await web.CoreWebView2.ExecuteScriptAsync("(() => { const t = document.querySelector('.props-head b'); const v = [...document.querySelectorAll('input')].some(i => i.value === 'Новая задача'); return (t ? t.textContent : '') + '|' + v; })()");
        L($"панель свойств студии после выделения в Visio: {props}");
        if (!props.Contains("Свойства элемента") || !props.Contains("true")) L("ПРОВАЛ: выделение из Visio не дошло до панели свойств студии");
        // после приёма правок студия вернула Visio на свою страницу; для проверок возвращаемся на страницу операции
        await Task.Delay(1500); // студия может ещё раз прислать место холста (панель свойств изменила его размер)
        visio.ShowDiagram(new Diagram("bpmn", scope));
        await Task.Delay(300);
        // студия → Visio: шаг, выбранный в студии, выделяется на диаграмме
        var gateId = added.First(n => n.GetProperty("type").GetString() == "gateway").GetProperty("id").GetString()!;
        await OnMessage("{\"t\":\"select\",\"id\":" + JsonSerializer.Serialize(gateId) + "}");
        var picked = visio.SelectedTag();
        L($"выбор шага в студии → выделение в Visio: {picked}");
        if (picked?.Id != gateId) L("ПРОВАЛ: выбор шага в студии не выделил фигуру в Visio");
        // автоприём: правка текста фигуры, затем выделение другой фигуры — через долю секунды правка уходит в модель сама
        await OnMessage("{\"t\":\"select\",\"id\":" + JsonSerializer.Serialize(taskId) + "}");
        visio.SetTextOf(taskId, "Переименована в Visio сама");
        await PollTick(); // увидели правку: запомнили выделение
        await OnMessage("{\"t\":\"select\",\"id\":" + JsonSerializer.Serialize(gateId) + "}"); // перешли к другой фигуре
        await Task.Delay(700);
        await PollTick(); // правка закончена — принимается без кнопки
        var live = await ServerHost.Http.GetStringAsync($"{server.Url}/api/sessions/{id}");
        var liveOk = live.Contains("Переименована в Visio сама");
        L($"автоприём правки без кнопки: {(liveOk ? "модель обновилась" : "модель не обновилась")}");
        if (!liveOk) L("ПРОВАЛ: автоприём не принял правку");
        await Task.Delay(3500);

        // панель инструментов диаграммы: масштаб, вписать, сетка
        visio.SetZoom(0.5);
        L($"масштаб 50%: {visio.ZoomValue:0.00}");
        if (Math.Abs(visio.ZoomValue - 0.5) > 0.02) L("ПРОВАЛ: масштаб не применился");
        var gridBefore = visio.GridShown;
        visio.ToggleGrid();
        L($"сетка: было {gridBefore}, стало {visio.GridShown}");
        if (visio.GridShown == gridBefore) L("ПРОВАЛ: сетка не переключилась");
        visio.ToggleGrid();
        visio.FitPage();

        // 2) переход на вкладку IDEF0 в студии переключает страницу Visio
        await web.CoreWebView2.ExecuteScriptAsync("(() => { const t = [...document.querySelectorAll('.doc-tabs [role=tab]')].find(e => /^IDEF0/.test((e.textContent || '').trim())); if (t) t.click(); return !!t; })()");
        for (var i = 0; i < 20 && !visio.CurrentPageName.StartsWith("IDEF0"); i++) await Task.Delay(400);
        L($"после перехода на вкладку IDEF0: страница «{visio.CurrentPageName}»");
        if (!visio.CurrentPageName.StartsWith("IDEF0")) L("ПРОВАЛ: страница Visio не переключилась на IDEF0");
        visio.ExportCurrentPage(Path.Combine(SelfTestDir, "visio-idef0.png"));

        // 3) правка в Visio → «Принять из Visio» (то же, что кнопка в ленте студии) → в модели
        const string mark = " ИЗ_VISIO";
        L("правка в Visio: " + visio.RenameFirstNode(mark));
        await Apply();
        var model = await ServerHost.Http.GetStringAsync($"{server.Url}/api/sessions/{id}");
        L(model.Contains(mark.Trim()) ? "OK: новое название есть в модели сессии" : "ПРОВАЛ: нового названия нет в модели");

        // 4) после перезагрузки студия возвращается на ту же вкладку, а Visio не открывается заново
        await Task.Delay(5000);
        L($"после перезагрузки студии: страница «{visio.CurrentPageName}», непринятых правок: {(visio.IsDirty ? "есть" : "нет")}");
        if (!visio.CurrentPageName.StartsWith("IDEF0")) L("ПРОВАЛ: вкладка не восстановилась после перезагрузки");

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
