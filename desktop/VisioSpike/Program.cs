// Проверка идеи: окно с Microsoft Visio Drawing Control (VISOCX.DLL), открытие .vsdx, правка фигуры, сохранение, снимок.
// Аргументы: <вход.vsdx> <выход.vsdx> <папка для лога и снимка>
using System.Drawing;
using System.Drawing.Imaging;
using System.Text;
using System.Windows.Forms;

internal sealed class VisioControl : AxHost
{
    // «Microsoft Visio 16.0 Drawing Control»
    public VisioControl() : base("E4615FA3-23B0-4976-BD3E-D611DDBE330E") { }
    public object Ocx => GetOcx()!;
}

internal sealed class MainForm : Form
{
    private readonly VisioControl visio = new();
    private readonly StringBuilder log = new();
    private readonly string input, output, dir;

    public MainForm(string input, string output, string dir)
    {
        (this.input, this.output, this.dir) = (input, output, dir);
        Text = "Visio в окне приложения — проверка";
        Width = 1400; Height = 900;
        StartPosition = FormStartPosition.CenterScreen;
        ((System.ComponentModel.ISupportInitialize)visio).BeginInit();
        visio.Dock = DockStyle.Fill;
        Controls.Add(visio);
        ((System.ComponentModel.ISupportInitialize)visio).EndInit();
        Shown += async (_, _) => await Run();
    }

    private async Task Run()
    {
        try
        {
            dynamic ocx = visio.Ocx;
            log.AppendLine("control: создан");
            ocx.Src = input;
            await Task.Delay(4000);
            dynamic doc = ocx.Document;
            log.AppendLine($"документ: страниц {doc.Pages.Count}");
            // страница BPMN с листом: первая, где есть штамп «NODE:»
            dynamic? bpmn = null;
            foreach (dynamic pg in doc.Pages)
            {
                string name = pg.Name;
                if (!name.StartsWith("BPMN")) continue;
                foreach (dynamic s in pg.Shapes) { string t = s.Text; if (t == "NODE:") { bpmn = pg; break; } }
                if (bpmn != null) break;
            }
            if (bpmn == null) throw new Exception("нет страницы BPMN с листом");
            log.AppendLine($"страница «{bpmn.Name}», фигур {bpmn.Shapes.Count}");
            // переименовываем первый шаг модели (метка pm_k = node)
            foreach (dynamic s in bpmn.Shapes)
            {
                if ((short)s.CellExistsU["User.pm_k", 0] == 0) continue;
                string kind = s.CellsU["User.pm_k"].ResultStr[""];
                if (kind != "node") continue;
                string t = s.Text;
                if (string.IsNullOrWhiteSpace(t)) continue;
                log.AppendLine("переименован шаг: " + t.Replace(Environment.NewLine, " ").Replace("\n", " "));
                s.Text = t + " ИЗ_VISIO";
                break;
            }
            // Visio рисует страницу сам: так можно проверить внешний вид без снимка экрана
            bpmn.Export(Path.Combine(dir, "page-bpmn.png"));
            log.AppendLine("страница выгружена в PNG средствами Visio");
            doc.SaveAs(output);
            log.AppendLine($"сохранено: {output}");
            await Task.Delay(800);
            Snapshot();
            log.AppendLine("OK");
        }
        catch (Exception e) { log.AppendLine("ОШИБКА: " + e); }
        File.WriteAllText(Path.Combine(dir, "spike.log"), log.ToString());
        Close();
    }

    private void Snapshot()
    {
        var r = Bounds;
        using var bmp = new Bitmap(r.Width, r.Height);
        using (var g = Graphics.FromImage(bmp)) g.CopyFromScreen(r.Location, Point.Empty, r.Size);
        bmp.Save(Path.Combine(dir, "spike.png"), ImageFormat.Png);
    }
}

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        ApplicationConfiguration.Initialize();
        Application.Run(new MainForm(args[0], args[1], args[2]));
    }
}
