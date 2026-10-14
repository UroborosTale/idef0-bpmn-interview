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

    public string? LoadedSession { get; private set; }
    public string? LoadedUpdatedAt { get; private set; }
    public event Action<string>? Status;

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
        var file = Path.Combine(work, $"{sessionId}.vsdx");
        await File.WriteAllBytesAsync(file, bytes);
        visio.Ocx.Src = file;
        LoadedSession = sessionId;
        LoadedUpdatedAt = updatedAt;
        visio.Ocx.Document.Saved = true;
        await Task.Delay(1500); // Visio загружает документ в фоне
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
    public async Task<string> SendEditsAsync(ServerHost server)
    {
        if (LoadedSession == null) throw new InvalidOperationException("В Visio ничего не открыто");
        var file = Path.Combine(work, $"{LoadedSession}.edited.vsdx");
        if (File.Exists(file)) File.Delete(file);
        visio.Ocx.Document.SaveAs(file);
        var content = Convert.ToBase64String(await File.ReadAllBytesAsync(file));
        var body = new StringContent(System.Text.Json.JsonSerializer.Serialize(new { content }), System.Text.Encoding.UTF8, "application/json");
        var resp = await ServerHost.Http.PostAsync($"{server.Url}/api/sessions/{LoadedSession}/diagram-import/vsdx", body);
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
