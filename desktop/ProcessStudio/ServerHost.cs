using System.Diagnostics;
using System.Net;
using System.Net.Sockets;

/// <summary>API-сервер приложения (Node): запускается вместе с окном, отдаёт и веб-интерфейс (WEB_DIST), и /api.</summary>
internal sealed class ServerHost : IDisposable
{
    private Process? process;
    private readonly string repo;
    private readonly string dataDir;
    public int Port { get; private set; }
    public string Url => $"http://127.0.0.1:{Port}";
    public string Log => log.ToString();
    private readonly System.Text.StringBuilder log = new();
    public static readonly HttpClient Http = new(new HttpClientHandler { UseProxy = false }) { Timeout = TimeSpan.FromSeconds(120) };

    public ServerHost(string repo, string dataDir) => (this.repo, this.dataDir) = (repo, dataDir);

    private static int FreePort()
    {
        var l = new TcpListener(IPAddress.Loopback, 0);
        l.Start();
        var port = ((IPEndPoint)l.LocalEndpoint).Port;
        l.Stop();
        return port;
    }

    /// <summary>Запускает сервер и ждёт, пока он ответит на /api/health.</summary>
    public async Task StartAsync()
    {
        Port = FreePort();
        var web = Path.Combine(repo, "web", "dist");
        if (!File.Exists(Path.Combine(web, "index.html"))) throw new InvalidOperationException($"Нет собранного веб-интерфейса: {web}. Выполните npm run build.");
        var tsx = Path.Combine(repo, "node_modules", "tsx", "dist", "cli.mjs");
        var psi = new ProcessStartInfo("node", $"\"{tsx}\" src/index.ts")
        {
            WorkingDirectory = Path.Combine(repo, "server"),
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        psi.Environment["PORT"] = Port.ToString();
        psi.Environment["HOST"] = "127.0.0.1";
        psi.Environment["WEB_DIST"] = web;
        psi.Environment["DATA_DIR"] = dataDir;
        psi.Environment["BACKUP_INTERVAL_HOURS"] = "0";
        process = Process.Start(psi) ?? throw new InvalidOperationException("Не удалось запустить node");
        process.OutputDataReceived += (_, e) => { if (e.Data != null) log.AppendLine(e.Data); };
        process.ErrorDataReceived += (_, e) => { if (e.Data != null) log.AppendLine(e.Data); };
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();

        var deadline = DateTime.UtcNow.AddSeconds(90);
        while (DateTime.UtcNow < deadline)
        {
            if (process.HasExited) throw new InvalidOperationException("Сервер завершился при запуске:\n" + Log);
            try { if ((await Http.GetAsync($"{Url}/api/health")).IsSuccessStatusCode) return; } catch { /* ещё не слушает */ }
            await Task.Delay(400);
        }
        throw new TimeoutException("Сервер не ответил за 90 с:\n" + Log);
    }

    public void Dispose()
    {
        if (process is { HasExited: false })
        {
            // дерево процессов: node может породить дочерние
            try { Process.Start(new ProcessStartInfo("taskkill", $"/PID {process.Id} /T /F") { CreateNoWindow = true, UseShellExecute = false })?.WaitForExit(5000); } catch { }
        }
        process?.Dispose();
    }
}
