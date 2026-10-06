import { Router } from "express";
import { getSession } from "../repo.js";
import { idef0ToDrawio } from "../pipeline/idef0.js";
import { buildAlbumHtml } from "../export/album.js";
import { buildVsdx } from "../export/vsdx.js";
import { buildProtocolMarkdown } from "../export/protocol.js";
import { buildStatementsMarkdown } from "../export/statements.js";
import { buildQuestionsText } from "../export/questions.js";

export const exportRouter = Router();

function asciiFallback(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return ascii || "export";
}

function attachment(res: any, filename: string) {
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${asciiFallback(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`
  );
}

function requireReady(req: any, res: any): ReturnType<typeof getSession> | null {
  const session = getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: "not found" });
    return null;
  }
  if (!session.model) {
    res.status(400).json({ error: "модель ещё не построена — выполните запуск обработки" });
    return null;
  }
  return session;
}

exportRouter.get("/sessions/:id/export/bpmn", (req, res) => {
  const session = requireReady(req, res);
  if (!session || !session.bpmnXml) {
    if (session) res.status(400).json({ error: "диаграмма BPMN ещё не сгенерирована" });
    return;
  }
  attachment(res, `${session.meta.processName}.bpmn`);
  res.type("application/xml").send(session.bpmnXml);
});

exportRouter.get("/sessions/:id/export/model.json", (req, res) => {
  const session = requireReady(req, res);
  if (!session) return;
  attachment(res, `${session.meta.processName}.model.json`);
  res.type("application/json").send(JSON.stringify(session.model, null, 2));
});

exportRouter.get("/sessions/:id/export/idef0/:diagram.svg", (req, res) => {
  const session = requireReady(req, res);
  if (!session || !session.idef0) {
    if (session) res.status(400).json({ error: "диаграмма IDEF0 ещё не сгенерирована" });
    return;
  }
  const map: Record<string, string> = {
    context: session.idef0.contextSvg,
    decomposition: session.idef0.decompositionSvg,
    tree: session.idef0.nodeTreeSvg,
  };
  // диаграммы декомпозиции вложенных функций адресуются кодом: .../idef0/A2.svg, A21.svg
  const svg = map[req.params.diagram] ?? session.idef0.children?.find((c) => c.code === req.params.diagram)?.svg;
  if (!svg) {
    res.status(404).json({ error: "неизвестная диаграмма" });
    return;
  }
  attachment(res, `${session.meta.processName}.idef0-${req.params.diagram}.svg`);
  res.type("image/svg+xml").send(svg);
});

exportRouter.get("/sessions/:id/export/vsdx", async (req, res) => {
  const session = requireReady(req, res);
  if (!session) return;
  try {
    const buf = await buildVsdx(session.model!);
    attachment(res, `${session.meta.processName}.vsdx`);
    res.type("application/vnd.ms-visio.drawing").send(buf);
  } catch (e) {
    res.status(500).json({ error: `не удалось собрать VSDX: ${(e as Error).message}` });
  }
});

exportRouter.get("/sessions/:id/export/idef0.drawio", (req, res) => {
  const session = requireReady(req, res);
  if (!session || !session.idef0) return;
  const xml = idef0ToDrawio(session.model!, session.idef0);
  attachment(res, `${session.meta.processName}.idef0.drawio`);
  res.type("application/xml").send(xml);
});

exportRouter.get("/sessions/:id/export/questions.txt", (req, res) => {
  const session = requireReady(req, res);
  if (!session) return;
  res.type("text/plain; charset=utf-8").send(buildQuestionsText(session));
});

exportRouter.get("/sessions/:id/export/protocol.md", (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: "not found" });
    return;
  }
  attachment(res, `${session.meta.processName}.protocol.md`);
  res.type("text/markdown; charset=utf-8").send(buildProtocolMarkdown(session));
});

exportRouter.get("/sessions/:id/export/statements.md", (req, res) => {
  const session = requireReady(req, res);
  if (!session) return;
  attachment(res, `${session.meta.processName}.statements.md`);
  res.type("text/markdown; charset=utf-8").send(buildStatementsMarkdown(session));
});

exportRouter.get("/sessions/:id/export/album.html", async (req, res) => {
  const session = requireReady(req, res);
  if (!session) return;
  res.type("text/html; charset=utf-8").send(await buildAlbumHtml(session));
});

exportRouter.get("/sessions/:id/export/album.pdf", async (req, res) => {
  const session = requireReady(req, res);
  if (!session) return;
  try {
    const { chromium } = await import("playwright");
    const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || "/opt/pw-browsers/chromium";
    const browser = await chromium.launch({ executablePath, args: ["--no-sandbox"] }).catch(() => chromium.launch());
    const page = await browser.newPage();
    await page.setContent(await buildAlbumHtml(session), { waitUntil: "networkidle" });
    const pdf = await page.pdf({ format: "A4", printBackground: true, margin: { top: "16mm", bottom: "16mm", left: "14mm", right: "14mm" } });
    await browser.close();
    attachment(res, `${session.meta.processName}.album.pdf`);
    res.type("application/pdf").send(pdf);
  } catch (e) {
    res.status(501).json({
      error: "PDF-рендеринг недоступен в этом окружении (нет Chromium). Используйте /export/album.html и печать в PDF из браузера.",
      details: (e as Error).message,
    });
  }
});
