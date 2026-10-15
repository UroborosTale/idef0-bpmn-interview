using System.Text.RegularExpressions;
using System.Windows.Forms;

/// <summary>Окно Visio внутри приложения: «Microsoft Visio 16.0 Drawing Control» (VISOCX.DLL).</summary>
internal sealed class VisioControl : AxHost
{
    public VisioControl() : base("E4615FA3-23B0-4976-BD3E-D611DDBE330E") { }
    public dynamic Ocx => GetOcx()!;
}

/// <summary>Какую диаграмму показывать: BPMN операции (scope; null — общая схема) или IDEF0 функции (parent; null — верхняя диаграмма).</summary>
internal sealed record Diagram(string Kind, string? Id);

/// <summary>
/// Панель с Visio. Студия (WebView2) сообщает, где на экране холст диаграммы, и панель ложится ровно на это место;
/// документ — выгрузка .vsdx всей сессии, а диаграмма выбирается переключением страницы по меткам pm_page / pm_scope / pm_parent.
/// </summary>
internal sealed class VisioPane : Panel
{
    private readonly VisioControl visio = new();
    private readonly string work;
    private int openCount;

    public string? LoadedSession { get; private set; }
    public string? LoadedUpdatedAt { get; private set; }
    public event Action<string>? Status;
    /// <summary>Подробный журнал шагов (самопроверка пишет его в файл).</summary>
    public static Action<string>? Trace;

    public VisioPane(string workDir)
    {
        work = workDir;
        Directory.CreateDirectory(work);
        ((System.ComponentModel.ISupportInitialize)visio).BeginInit();
        visio.Dock = DockStyle.Fill;
        Controls.Add(visio);
        ((System.ComponentModel.ISupportInitialize)visio).EndInit();
    }

    /// <summary>В документе есть правки, ещё не отправленные в модель.</summary>
    public bool IsDirty
    {
        get
        {
            try { return LoadedSession != null && !(bool)visio.Ocx.Document.Saved; }
            catch { return false; }
        }
    }

    /// <summary>Выгружает .vsdx сессии с сервера и открывает его в Visio.</summary>
    public async Task OpenSessionAsync(ServerHost server, string sessionId, string updatedAt)
    {
        Status?.Invoke("Выгрузка диаграмм в Visio…");
        var bytes = await ServerHost.Http.GetByteArrayAsync($"{server.Url}/api/sessions/{sessionId}/export/vsdx");
        var file = Path.Combine(work, $"{sessionId}.{++openCount}.vsdx"); // новое имя: Visio не перечитывает документ по прежнему пути
        await File.WriteAllBytesAsync(file, bytes);
        visio.Ocx.Src = file;
        LoadedSession = sessionId;
        LoadedUpdatedAt = updatedAt;
        visio.Ocx.Document.Saved = true;
        await Task.Delay(1500); // Visio загружает документ в фоне
        HideChrome();
        Status?.Invoke($"Visio: страниц {(int)visio.Ocx.Document.Pages.Count}");
    }

    private static string? User(dynamic holder, string name)
    {
        try
        {
            dynamic sheet = holder;
            return (short)sheet.CellExistsU["User." + name, 0] == 0 ? null : (string)sheet.CellsU["User." + name].ResultStr[""];
        }
        catch { return null; }
    }

    private static void Try(Action a) { try { a(); } catch { /* свойство недоступно в этой версии Visio — остаётся как есть */ } }

    /// <summary>Убирает у окна Visio всё, чего нет в редакторе Business Studio: линейки и ярлыки страниц; сетка и полосы прокрутки остаются.</summary>
    public void HideChrome()
    {
        dynamic w = visio.Ocx.Window;
        Try(() => w.ShowRulers = false);
        Try(() => w.ShowPageTabs = false);
        Try(() => w.ShowScrollBars = 3); // visScrollBarsBoth
        Try(() => w.ShowGrid = true);
        Try(() => w.ShowGuides = false);
    }

    /// <summary>Линейки и ярлыки страниц скрыты (для самопроверки).</summary>
    public bool ChromeHidden
    {
        get
        {
            try { dynamic w = visio.Ocx.Window; return Convert.ToInt32(w.ShowRulers) == 0 && Convert.ToInt32(w.ShowPageTabs) == 0; }
            catch { return false; }
        }
    }

    public double ZoomValue
    {
        get { try { return Convert.ToDouble(visio.Ocx.Window.Zoom); } catch { return -1; } }
    }

    public bool GridShown
    {
        get { try { return Convert.ToInt32(visio.Ocx.Window.ShowGrid) != 0; } catch { return false; } }
    }

    /// <summary>Масштаб окна: 1 = 100 %.</summary>
    public void SetZoom(double zoom) => Try(() => visio.Ocx.Window.Zoom = zoom);

    /// <summary>Вписать страницу в окно.</summary>
    public void FitPage() => Try(() => visio.Ocx.Window.ViewFit = 1); // visFitPage

    /// <summary>Показать или скрыть сетку.</summary>
    public void ToggleGrid() => Try(() => { dynamic w = visio.Ocx.Window; w.ShowGrid = Convert.ToInt32(w.ShowGrid) == 0; });

    /// <summary>Что рисует палитра: имя фигуры (по нему импорт опознаёт вид), форма, размер в пикселях, цвета и подпись.</summary>
    private sealed record Spec(string Name, string Shape, double W, double H, string Fill, double Line, string Text, int FontPx);

    private static Spec? SpecFor(string kind) => kind switch
    {
        "task" => new("Задача", "round", 150, 90, "RGB(232,238,247)", 1.3, "Новая задача", 12),
        "subprocess" => new("Подпроцесс", "round", 160, 90, "RGB(232,238,247)", 1.3, "Новый подпроцесс", 12),
        "gateway:exclusive" => new("Шлюз «или»", "diamond", 50, 50, "RGB(255,255,153)", 1.3, "X", 16),
        "gateway:parallel" => new("Шлюз «и»", "diamond", 50, 50, "RGB(255,255,153)", 1.3, "+", 18),
        "gateway:inclusive" => new("Шлюз «включающий»", "diamond", 50, 50, "RGB(255,255,153)", 1.3, "O", 16),
        "gateway:event_based" => new("Шлюз «событийный»", "diamond", 50, 50, "RGB(255,255,153)", 1.3, "O", 16),
        "gateway:complex" => new("Шлюз «комплексный»", "diamond", 50, 50, "RGB(255,255,153)", 1.3, "*", 18),
        "gateway:event_based_start" => new("Шлюз «событийный, запуск процесса»", "diamond", 50, 50, "RGB(255,255,153)", 1.3, "O", 16),
        "gateway:parallel_event_based" => new("Шлюз «параллельный событийный, запуск процесса»", "diamond", 50, 50, "RGB(255,255,153)", 1.3, "O+", 14),
        _ => EventSpec(kind),
    };

    /// <summary>Вид события «event:положение[:тип]»: по имени фигуры импорт определяет и положение, и тип (сообщение, таймер…).</summary>
    private static Spec? EventSpec(string kind)
    {
        var parts = kind.Split(':');
        if (parts[0] != "event" || parts.Length < 2) return null;
        var (name, fill, line, text) = parts[1] switch
        {
            "start" => ("Начальное событие", "RGB(153,255,102)", 1.3, "Начало"),
            "intermediate" => ("Промежуточное событие", "RGB(255,153,51)", 1.3, "Событие"),
            "end" => ("Конечное событие", "RGB(255,130,98)", 3.2, "Конец"),
            _ => ("", "", 0.0, ""),
        };
        if (name == "") return null;
        if (parts.Length > 2 && TriggerNames.TryGetValue(parts[2], out var t)) { name += $" «{t}»"; text = char.ToUpper(t[0]) + t[1..]; }
        return new(name, "oval", 36, 36, fill, line, text, 11);
    }

    /// <summary>Типы событий: ключ модели → слово в имени фигуры (по нему импорт распознаёт триггер).</summary>
    private static readonly Dictionary<string, string> TriggerNames = new()
    {
        ["message"] = "сообщение", ["timer"] = "таймер", ["conditional"] = "условное", ["signal"] = "сигнал",
        ["error"] = "ошибка", ["escalation"] = "эскалация", ["terminate"] = "завершение процесса",
        ["link"] = "ссылка", ["multiple"] = "множественное", ["parallel_multiple"] = "параллельное множественное", ["compensation"] = "компенсация",
    };

    /// <summary>
    /// Команды меню «Действия», как в Business Studio: окна и диалоги самого Visio (выравнивание, распределение, привязка, параметры
    /// страницы, панорама, размер и положение, формат по образцу, печать), размер страницы по содержимому и масштаб 100 %.
    /// Возвращает false, если команда неизвестна или Visio её не выполнил.
    /// </summary>
    public bool RunCommand(string name)
    {
        var ids = new Dictionary<string, int>
        {
            ["align"] = 1049, ["distribute"] = 1230, ["snapglue"] = 1084, ["pagesetup"] = 1076,
            ["panzoom"] = 1653, ["sizepos"] = 1670, ["formatpainter"] = 1271, ["print"] = 1010,
            ["cut"] = 1020, ["copy"] = 1021, ["paste"] = 1022, ["delete"] = 1023, ["selectall"] = 1025,
        };
        try
        {
            if (name == "zoom100") { SetZoom(1); return true; }
            if (name == "fitcontent") { visio.Ocx.Window.Page.ResizeToFitContents(); return true; }
            if (!ids.TryGetValue(name, out var id)) return false;
            dynamic app = visio.Ocx.Window.Application;
            app.DoCmd((short)id);
            return true;
        }
        catch { return false; }
    }

    /// <summary>Фокус клавиатуры — в окне Visio (тогда горячие клавиши «Действий» относятся к диаграмме).</summary>
    public bool HasFocusWithin => visio.ContainsFocus || ContainsFocus;

    /// <summary>Включает инструмент окна Visio: «connector» — соединительная линия, иначе обычный указатель.</summary>
    public void SetTool(string tool) => Try(() =>
    {
        const int visCmdDRPointerTool = 1219, visCmdDRConnectorTool = 1225;
        dynamic app = visio.Ocx.Window.Application;
        app.DoCmd((short)(tool == "connector" ? visCmdDRConnectorTool : visCmdDRPointerTool));
    });

    private const double PxIn = 1.0 / 96.0; // пиксель диаграммы → дюймы Visio

    /// <summary>
    /// Рисует на текущей странице фигуру из палитры. Фигура — обычная (без мастера): мастера «Фигур документа» подвешивают
    /// сохранение документа в окне Visio. client — точка в окне (пиксели); null — центр видимой части страницы.
    /// Возвращает подпись созданной фигуры или null.
    /// </summary>
    public string? DropMaster(string kind, Point? client)
    {
        var spec = SpecFor(kind);
        if (spec == null || LoadedSession == null) return null;
        dynamic win = visio.Ocx.Window;
        dynamic page = win.Page;

        // видимая область страницы в дюймах: по ней точка окна переводится в координаты страницы (Visio: y вверх)
        double left = 0, top = 0, width = 0, height = 0;
        double x, y;
        try
        {
            win.GetViewRect(ref left, ref top, ref width, ref height);
            var p = client ?? new Point(visio.ClientSize.Width / 2, visio.ClientSize.Height / 2);
            x = left + p.X / (double)Math.Max(1, visio.ClientSize.Width) * width;
            y = top - p.Y / (double)Math.Max(1, visio.ClientSize.Height) * height;
        }
        catch
        {
            x = Convert.ToDouble(page.PageSheet.CellsU["PageWidth"].ResultIU) / 2;
            y = Convert.ToDouble(page.PageSheet.CellsU["PageHeight"].ResultIU) / 2;
        }

        double hw = spec.W * PxIn / 2, hh = spec.H * PxIn / 2;
        dynamic shape = spec.Shape switch
        {
            "oval" => page.DrawOval(x - hw, y - hh, x + hw, y + hh),
            "diamond" => page.DrawPolyline(new[] { x, y + hh, x + hw, y, x, y - hh, x - hw, y, x, y + hh }, 0),
            _ => page.DrawRectangle(x - hw, y - hh, x + hw, y + hh),
        };
        Try(() => shape.NameU = spec.Name);
        Try(() => shape.CellsU["FillForegnd"].FormulaU = spec.Fill);
        Try(() => shape.CellsU["LineColor"].FormulaU = "RGB(0,0,0)");
        Try(() => shape.CellsU["LineWeight"].ResultIU = spec.Line / 72.0);
        if (spec.Shape == "round") Try(() => shape.CellsU["Rounding"].ResultIU = 10 * PxIn);
        shape.Text = spec.Text;
        Try(() => shape.CellsU["Char.Size"].ResultIU = spec.FontPx * 0.75 / 72.0);
        if (spec.Shape == "oval")
        {
            // подпись события — под фигурой, как в нашей выгрузке
            Try(() => shape.CellsU["VerticalAlign"].ResultIU = 0);
            Try(() => { shape.CellsU["TxtPinY"].FormulaU = "-" + F((3 + 15) * PxIn); shape.CellsU["TxtWidth"].ResultIU = 120 * PxIn; shape.CellsU["TxtHeight"].ResultIU = 30 * PxIn; });
        }
        // событие с типом: значок триггера — примитивами поверх круга, всё собирается в группу
        var kp = kind.Split(':');
        if (kp.Length > 2 && spec.Shape == "oval")
            Try(() =>
            {
                dynamic grp = DrawEventGlyph(win, page, shape, kp[1], kp[2], x, y);
                grp.NameU = spec.Name;
            });
        Try(() => win.DeselectAll());
        return spec.Text;
    }

    private System.Text.Json.JsonElement? glyphs;

    /// <summary>Скачивает у сервера значки триггеров (примитивы: круги и ломаные), которыми рисуются события с типом.</summary>
    public async Task PrepareEventShapesAsync(ServerHost server)
    {
        if (glyphs != null) return;
        try
        {
            var json = await ServerHost.Http.GetStringAsync($"{server.Url}/api/visio/event-glyphs");
            glyphs = System.Text.Json.JsonDocument.Parse(json).RootElement.GetProperty("glyphs").Clone();
        }
        catch { glyphs = null; /* без значков событие рисуется кругом с подписью */ }
    }

    private static string F(double v) => v.ToString("0.#####", System.Globalization.CultureInfo.InvariantCulture);

    /// <summary>
    /// Рисует значок триггера поверх события (центр cx, cy в дюймах) примитивами Visio и собирает круг и значок в группу.
    /// Выбрасывающие события (конечное) — залитый значок, ждущие — контурный; у промежуточного есть внутреннее кольцо.
    /// </summary>
    private dynamic DrawEventGlyph(dynamic win, dynamic page, dynamic oval, string position, string trigger, double cx, double cy)
    {
        var parts = new List<dynamic> { oval };
        if (position == "intermediate")
        {
            dynamic ring = page.DrawOval(cx - 14 * PxIn, cy - 14 * PxIn, cx + 14 * PxIn, cy + 14 * PxIn);
            ring.CellsU["FillPattern"].FormulaU = "0";
            ring.CellsU["LineWeight"].ResultIU = 1.3 / 72.0;
            parts.Add(ring);
        }
        if (glyphs is { } all && all.TryGetProperty(trigger, out var g) && g.TryGetProperty(position == "end" ? "throw" : "catch", out var list))
        {
            foreach (var p in list.EnumerateArray())
            {
                var filled = p.TryGetProperty("filled", out var f) && f.GetBoolean();
                if (p.GetProperty("kind").GetString() == "circle")
                {
                    var r = p.GetProperty("r").GetDouble() * PxIn;
                    parts.Add(page.DrawOval(cx - r, cy - r, cx + r, cy + r));
                    parts[^1].CellsU["FillPattern"].FormulaU = filled ? "1" : "0";
                    if (filled) parts[^1].CellsU["FillForegnd"].FormulaU = "RGB(0,0,0)";
                    continue;
                }
                var closed = p.TryGetProperty("closed", out var c) && c.GetBoolean();
                var light = p.TryGetProperty("light", out var l) && l.GetBoolean();
                var pts = new List<double>();
                foreach (var pt in p.GetProperty("pts").EnumerateArray()) { pts.Add(cx + pt[0].GetDouble() * PxIn); pts.Add(cy - pt[1].GetDouble() * PxIn); }
                if (closed) { pts.Add(pts[0]); pts.Add(pts[1]); }
                dynamic line = page.DrawPolyline(pts.ToArray(), 0);
                line.CellsU["FillPattern"].FormulaU = filled && closed ? "1" : "0";
                if (filled && closed) line.CellsU["FillForegnd"].FormulaU = "RGB(0,0,0)";
                line.CellsU["LineColor"].FormulaU = light ? "RGB(255,255,255)" : "RGB(0,0,0)";
                line.CellsU["LineWeight"].ResultIU = 1.0 / 72.0;
                parts.Add(line);
            }
        }
        if (parts.Count == 1) return oval;
        win.DeselectAll();
        foreach (var part in parts) win.Select(part, 2 /* visSelect */);
        return win.Selection.Group();
    }

    /// <summary>
    /// Форматирование выделенных фигур Visio (панель над меню фигуры): шрифт крупнее и мельче, полужирный и курсив, заливка, выравнивание текста
    /// по горизонтали и вертикали, порядок наложения. Это оформление документа Visio: в модель оно не возвращается.
    /// </summary>
    public void FormatSelection(string op, Color? color)
    {
        try
        {
            dynamic win = visio.Ocx.Window;
            dynamic sel = win.Selection;
            int n = (int)sel.Count;
            for (int i = 1; i <= n; i++)
            {
                dynamic sh = sel[i];
                switch (op)
                {
                    case "bigger":
                    case "smaller":
                        Try(() => { var c = sh.CellsU["Char.Size"]; double v = Convert.ToDouble(c.ResultIU) + (op == "bigger" ? 1 : -1) / 72.0; if (v >= 4 / 72.0) c.ResultIU = v; });
                        break;
                    case "bold":
                    case "italic":
                        Try(() => { var c = sh.CellsU["Char.Style"]; int v = (int)Convert.ToDouble(c.ResultIU); int bit = op == "bold" ? 1 : 2; c.FormulaU = (v ^ bit).ToString(); });
                        break;
                    case "fill":
                        if (color is { } col) Try(() => sh.CellsU["FillForegnd"].FormulaU = $"RGB({col.R},{col.G},{col.B})");
                        break;
                    case "left": Try(() => sh.CellsU["Para.HorzAlign"].FormulaU = "0"); break;
                    case "center": Try(() => sh.CellsU["Para.HorzAlign"].FormulaU = "1"); break;
                    case "right": Try(() => sh.CellsU["Para.HorzAlign"].FormulaU = "2"); break;
                    case "top": Try(() => sh.CellsU["VerticalAlign"].FormulaU = "0"); break;
                    case "middle": Try(() => sh.CellsU["VerticalAlign"].FormulaU = "1"); break;
                    case "bottom": Try(() => sh.CellsU["VerticalAlign"].FormulaU = "2"); break;
                    case "front": Try(() => sh.BringToFront()); break;
                    case "back": Try(() => sh.SendToBack()); break;
                }
            }
        }
        catch { /* ничего не выделено или Visio занят */ }
    }

    /// <summary>Записывает пользовательскую ячейку фигуры (User.имя): фигура получает метку модели, как у фигур нашей выгрузки.</summary>
    private static void SetUser(dynamic holder, string name, string value)
    {
        const short visSectionUser = 242;
        var cell = "User." + name;
        if ((short)holder.CellExistsU[cell, 0] == 0) holder.AddNamedRow(visSectionUser, name, 0);
        holder.CellsU[cell].FormulaU = "\"" + value.Replace("\"", "\"\"") + "\"";
    }

    /// <summary>
    /// После приёма правок: новые фигуры помечаются id созданных шагов и потоков (pm_k, pm_id, pm_n), а id попадают в список нарисованного
    /// на странице (pm_manifest). Без меток следующий приём правок создал бы эти шаги ещё раз.
    /// </summary>
    public int TagCreated(System.Text.Json.JsonElement changes)
    {
        dynamic doc = visio.Ocx.Document;
        var tagged = 0;
        var wasSaved = Convert.ToInt32(doc.Saved) != 0;
        void Tag(string pageName, string shapeId, string kind, string id, bool node)
        {
            try
            {
                dynamic page = doc.Pages.ItemU[pageName];
                dynamic shape = page.Shapes.ItemFromID[int.Parse(shapeId)];
                SetUser(shape, "pm_k", kind);
                SetUser(shape, "pm_id", id);
                SetUser(shape, "pm_n", Regex.Replace((string)shape.Text ?? "", @"\s+", " ").Trim());
                // в список нарисованного на странице: n — шаги, f — потоки
                dynamic sheet = page.PageSheet;
                var raw = (short)sheet.CellExistsU["User.pm_manifest", 0] == 0 ? "{}" : (string)sheet.CellsU["User.pm_manifest"].ResultStr[""];
                var m = System.Text.Json.Nodes.JsonNode.Parse(string.IsNullOrWhiteSpace(raw) ? "{}" : raw)!.AsObject();
                var key = node ? "n" : "f";
                var list = m[key] as System.Text.Json.Nodes.JsonArray ?? new System.Text.Json.Nodes.JsonArray();
                list.Add(id);
                m[key] = list;
                SetUser(sheet, "pm_manifest", m.ToJsonString());
                tagged++;
            }
            catch { /* страницы или фигуры уже нет (удалили, пока шёл приём правок) */ }
        }
        foreach (var x in changes.GetProperty("shapeMap").EnumerateArray()) Tag(x.GetProperty("page").GetString()!, x.GetProperty("shapeId").GetString()!, "node", x.GetProperty("nodeId").GetString()!, true);
        foreach (var x in changes.GetProperty("flowMap").EnumerateArray()) Tag(x.GetProperty("page").GetString()!, x.GetProperty("shapeId").GetString()!, "flow", x.GetProperty("flowId").GetString()!, false);
        // пометки — не правки пользователя: документ остаётся «сохранённым» и не вызывает новый приём правок
        if (wasSaved) doc.Saved = true;
        return tagged;
    }

    /// <summary>Выделенная в Visio фигура: вид метки (node, fn, flow…) и id объекта модели; null — ничего не выделено или у фигуры нет метки.</summary>
    public (string Kind, string Id)? SelectedTag()
    {
        try
        {
            dynamic sel = visio.Ocx.Window.Selection;
            if ((int)sel.Count < 1) return null;
            dynamic shape = sel[1];
            var kind = User(shape, "pm_k");
            var id = User(shape, "pm_id");
            return kind != null && id != null ? (kind, id) : null;
        }
        catch { return null; }
    }

    /// <summary>Выделяет в Visio фигуру объекта модели на текущей странице (по команде студии); false — такой фигуры на странице нет.</summary>
    public bool SelectNode(string nodeId)
    {
        const short visSelect = 2;
        try
        {
            dynamic win = visio.Ocx.Window;
            foreach (dynamic s in win.Page.Shapes)
            {
                if (User(s, "pm_id") != nodeId) continue;
                win.DeselectAll();
                win.Select(s, visSelect);
                return true;
            }
        }
        catch { }
        return false;
    }

    /// <summary>«Выделить все подобные»: выделяет на текущей странице фигуры объектов модели с этими id; возвращает, сколько выделено.</summary>
    public int SelectMany(ICollection<string> ids)
    {
        const short visSelect = 2;
        var n = 0;
        try
        {
            dynamic win = visio.Ocx.Window;
            win.DeselectAll();
            foreach (dynamic s in win.Page.Shapes)
            {
                var id = User(s, "pm_id");
                if (id == null || User(s, "pm_k") != "node" || !ids.Contains(id)) continue;
                win.Select(s, visSelect);
                n++;
            }
        }
        catch { }
        return n;
    }

    /// <summary>
    /// Правый щелчок: выделяет объект модели под курсором (client — точка в окне Visio), как при щелчке левой кнопкой. Уже выделенную
    /// фигуру не трогает (меню действует на всё выделение); под курсором нет объекта модели — выделение снимается.
    /// </summary>
    public void SelectAt(Point client)
    {
        const short visSelect = 2;
        const short visSpatialOverlap = 1, visSpatialContainedIn = 4, visSpatialFrontToBack = 4;
        try
        {
            dynamic win = visio.Ocx.Window;
            dynamic page = win.Page;
            double left = 0, top = 0, width = 0, height = 0;
            win.GetViewRect(ref left, ref top, ref width, ref height);
            var x = left + client.X / (double)Math.Max(1, visio.ClientSize.Width) * width;
            var y = top - client.Y / (double)Math.Max(1, visio.ClientSize.Height) * height;
            dynamic found = page.SpatialSearch(x, y, (short)(visSpatialContainedIn | visSpatialOverlap), 0.04, (short)visSpatialFrontToBack);
            dynamic? hit = null;
            for (var i = 1; i <= (int)found.Count; i++)
            {
                dynamic sh = found[i];
                var k = User(sh, "pm_k");
                if (k is "node" or "flow" or "fn" or "arrow") { hit = sh; break; }
            }
            dynamic sel = win.Selection;
            if (hit != null)
            {
                for (var i = 1; i <= (int)sel.Count; i++) if ((int)sel[i].ID == (int)hit.ID) return; // уже выделена
                win.DeselectAll();
                win.Select(hit, visSelect);
            }
            else win.DeselectAll();
        }
        catch { /* окно Visio ещё не готово */ }
    }

    /// <summary>Экранный прямоугольник окна Visio (для перехвата правого щелчка).</summary>
    public Rectangle ScreenBounds => RectangleToScreen(ClientRectangle);

    /// <summary>Для самопроверки: меняет текст фигуры шага на текущей странице.</summary>
    public bool SetTextOf(string nodeId, string text)
    {
        try
        {
            foreach (dynamic s in visio.Ocx.Window.Page.Shapes)
            {
                if (User(s, "pm_id") != nodeId) continue;
                s.Text = text;
                return true;
            }
        }
        catch { }
        return false;
    }

    /// <summary>Курсор находится над окном Visio (пользователь работает в нём): автоприём правок откладывается.</summary>
    public bool CursorInside => RectangleToScreen(ClientRectangle).Contains(Cursor.Position);

    /// <summary>Точка экрана в координатах окна Visio.</summary>
    public Point ToClient(Point screen) => PointToClient(screen);

    /// <summary>Число фигур на текущей странице (для самопроверки).</summary>
    public int ShapeCount
    {
        get { try { return (int)visio.Ocx.Window.Page.Shapes.Count; } catch { return -1; } }
    }

    /// <summary>Переключает окно на страницу нужной диаграммы; false — такой страницы в документе нет.</summary>
    public bool ShowDiagram(Diagram d)
    {
        foreach (dynamic page in visio.Ocx.Document.Pages)
        {
            dynamic sheet = page.PageSheet;
            var kind = User(sheet, "pm_page") ?? "";
            bool match = d.Kind == "bpmn"
                ? kind == "bpmn" && User(sheet, "pm_scope") == d.Id
                : kind.StartsWith("idef0:") && User(sheet, "pm_ro") != "1" && User(sheet, "pm_ctx") != "1" && User(sheet, "pm_parent") == d.Id;
            if (!match) continue;
            // переход на страницу Visio считает изменением документа; настоящие правки пользователя от этого не теряются
            bool wasSaved = (bool)visio.Ocx.Document.Saved;
            visio.Ocx.Window.Page = page;
            FitPage();
            if (wasSaved) visio.Ocx.Document.Saved = true;
            return true;
        }
        return false;
    }

    public string CurrentPageName
    {
        get { try { return (string)visio.Ocx.Window.Page.Name; } catch { return ""; } }
    }

    /// <summary>Сохраняет документ из окна Visio и отправляет серверу как правки сессии. Возвращает ответ сервера (JSON).</summary>
    public async Task<string> SendEditsAsync(ServerHost server, bool deleteMissing = false)
    {
        if (LoadedSession == null) throw new InvalidOperationException("В Visio ничего не открыто");
        await Task.Delay(100); // Visio заканчивает обработку только что созданных фигур в очереди окна; сохранение без паузы подвисает
        var file = Path.Combine(work, $"{LoadedSession}.edited.vsdx");
        if (File.Exists(file)) File.Delete(file);
        // Окно прячется на время сохранения: пока оно видно, Visio при SaveAs зацикливается (рисует изменённую уже показанную
        // страницу), а скрытому окну рисовать нечего — сохранение занимает доли секунды
        var wasVisible = Visible;
        Visible = false;
        System.Windows.Forms.Application.DoEvents();
        try
        {
            Trace?.Invoke("SaveAs: старт");
            visio.Ocx.Document.SaveAs(file);
            Trace?.Invoke("SaveAs: готово");
        }
        finally { Visible = wasVisible; }
        var content = Convert.ToBase64String(await File.ReadAllBytesAsync(file));
        var body = new StringContent(System.Text.Json.JsonSerializer.Serialize(new { content, deleteMissing }), System.Text.Encoding.UTF8, "application/json");
        Trace?.Invoke("POST правок: старт");
        var resp = await ServerHost.Http.PostAsync($"{server.Url}/api/sessions/{LoadedSession}/diagram-import/vsdx", body);
        Trace?.Invoke("POST правок: ответ получен");
        var text = await resp.Content.ReadAsStringAsync();
        if (!resp.IsSuccessStatusCode) throw new InvalidOperationException($"Сервер ответил {(int)resp.StatusCode}: {text}");
        // документ теперь совпадает с моделью на сервере: новая версия принимается за загруженную, чтобы не открывать файл заново
        using var doc = System.Text.Json.JsonDocument.Parse(text);
        LoadedUpdatedAt = doc.RootElement.GetProperty("session").GetProperty("updatedAt").GetString();
        visio.Ocx.Document.Saved = true; // SaveAs в файл для сервера не должен оставлять документ «изменённым»
        return text;
    }

    /// <summary>Для самопроверки: страница текущей диаграммы, нарисованная самим Visio, в PNG.</summary>
    public void ExportCurrentPage(string png) => visio.Ocx.Window.Page.Export(png);

    /// <summary>Для самопроверки: переименовывает первый шаг модели на странице BPMN (метка pm_k = node).</summary>
    public string RenameFirstNode(string suffix)
    {
        dynamic doc = visio.Ocx.Document;
        foreach (dynamic page in doc.Pages)
        {
            if (!((string)page.Name).StartsWith("BPMN")) continue;
            foreach (dynamic s in page.Shapes)
            {
                if (User(s, "pm_k") != "node") continue;
                string t = s.Text;
                if (string.IsNullOrWhiteSpace(t)) continue;
                s.Text = t + suffix;
                return $"{page.Name}: {t}";
            }
        }
        throw new InvalidOperationException("Не нашёл шаг BPMN для переименования");
    }
}
