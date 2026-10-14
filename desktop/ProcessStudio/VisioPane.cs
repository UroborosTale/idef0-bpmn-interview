using System.Windows.Forms;

/// <summary>Окно Visio внутри приложения: «Microsoft Visio 16.0 Drawing Control» (VISOCX.DLL) и обмен файлами .vsdx с сервером.</summary>
internal sealed class VisioControl : AxHost
{
    public VisioControl() : base("E4615FA3-23B0-4976-BD3E-D611DDBE330E") { }
    public dynamic Ocx => GetOcx()!;
}

internal sealed class VisioPane : Panel
{
    private readonly VisioControl visio = new();
    private readonly string work;
    private string? openedFor;

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

    public string? SessionId => openedFor;

    /// <summary>Выгружает .vsdx сессии с сервера и открывает его в окне Visio.</summary>
    public async Task OpenSessionAsync(ServerHost server, string sessionId)
    {
        Status?.Invoke("Выгрузка из сервера…");
        var bytes = await ServerHost.Http.GetByteArrayAsync($"{server.Url}/api/sessions/{sessionId}/export/vsdx");
        var file = Path.Combine(work, $"{sessionId}.vsdx");
        await File.WriteAllBytesAsync(file, bytes);
        visio.Ocx.Src = file;
        openedFor = sessionId;
        await Task.Delay(1500); // Visio загружает документ в фоне
        Status?.Invoke($"Открыто в Visio: {bytes.Length / 1024} КБ, страниц {(int)visio.Ocx.Document.Pages.Count}");
    }

    /// <summary>Сохраняет документ из окна Visio и отправляет серверу как правки сессии. Возвращает ответ сервера (JSON).</summary>
    public async Task<string> SendEditsAsync(ServerHost server)
    {
        if (openedFor == null) throw new InvalidOperationException("В Visio ничего не открыто");
        var file = Path.Combine(work, $"{openedFor}.edited.vsdx");
        if (File.Exists(file)) File.Delete(file);
        visio.Ocx.Document.SaveAs(file);
        var content = Convert.ToBase64String(await File.ReadAllBytesAsync(file));
        var body = new StringContent(System.Text.Json.JsonSerializer.Serialize(new { content }), System.Text.Encoding.UTF8, "application/json");
        var resp = await ServerHost.Http.PostAsync($"{server.Url}/api/sessions/{openedFor}/diagram-import/vsdx", body);
        var text = await resp.Content.ReadAsStringAsync();
        if (!resp.IsSuccessStatusCode) throw new InvalidOperationException($"Сервер ответил {(int)resp.StatusCode}: {text}");
        return text;
    }

    /// <summary>Для самопроверки: страница BPMN, нарисованная самим Visio, в PNG.</summary>
    public void ExportPage(string png)
    {
        foreach (dynamic page in visio.Ocx.Document.Pages)
        {
            if (((string)page.Name).StartsWith("BPMN")) { page.Export(png); return; }
        }
    }

    /// <summary>Для самопроверки: переименовывает первый шаг модели на странице BPMN (метка pm_k = node).</summary>
    public string RenameFirstNode(string suffix)
    {
        dynamic doc = visio.Ocx.Document;
        foreach (dynamic page in doc.Pages)
        {
            if (!((string)page.Name).StartsWith("BPMN")) continue;
            foreach (dynamic s in page.Shapes)
            {
                if ((short)s.CellExistsU["User.pm_k", 0] == 0) continue;
                if ((string)s.CellsU["User.pm_k"].ResultStr[""] != "node") continue;
                string t = s.Text;
                if (string.IsNullOrWhiteSpace(t)) continue;
                s.Text = t + suffix;
                return $"{page.Name}: {t}";
            }
        }
        throw new InvalidOperationException("Не нашёл шаг BPMN для переименования");
    }
}
