import { Router } from "express";
import { getSession } from "../repo.js";
import { idef0ToDrawio } from "../pipeline/idef0.js";
import { buildAlbumHtml } from "../export/album.js";
import { buildVsdx } from "../export/vsdx.js";
import { launchPdfBrowser } from "../export/pdfBrowser.js";
import { PAPER_MM, idef0PrintHtml, type Orientation } from "../export/idef0Print.js";
import { generateBpmn } from "../pipeline/bpmn.js";
import { idef0Codes } from "../shared/idef0Layout.js";
import { bpmnHosts } from "../shared/codes.js";
import JSZip from "jszip";
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

/**
 * BPMN операции: ?scope=<id операции> строит диаграмму BPMN этой операции по текущей модели.
 * Без scope отдаётся общая схема процесса.
 */
exportRouter.get("/sessions/:id/export/bpmn", async (req, res, next) => {
  const scope = typeof req.query.scope === "string" ? req.query.scope : "";
  if (scope) {
    const session = requireReady(req, res);
    if (!session) return;
    const host = session.model!.nodes.find((n) => n.id === scope);
    if (!host) {
      res.status(404).json({ error: "операция не найдена" });
      return;
    }
    const code = idef0Codes(session.model!).get(scope) ?? scope;
    attachment(res, `${code} ${host.name}.bpmn`);
    res.type("application/xml").send((await generateBpmn(session.model!, scope)).xml);
    return;
  }
  next();
});

/** Атлас процессов: диаграммы BPMN всех операций с шагами — архивом, файл на операцию «код название.bpmn». */
exportRouter.get("/sessions/:id/export/bpmn.zip", async (req, res) => {
  const session = requireReady(req, res);
  if (!session) return;
  const model = session.model!;
  const codes = idef0Codes(model);
  const zip = new JSZip();
  let count = 0;
  for (const host of bpmnHosts(model)) {
    if (!model.nodes.some((n) => n.bpmn_scope === host.id)) continue;
    zip.file(`${codes.get(host.id)} ${host.name}.bpmn`.replace(/[\\/:*?"<>|]+/g, "_"), (await generateBpmn(model, host.id)).xml);
    count++;
  }
  if (count === 0) {
    res.status(400).json({ error: "нет операций с диаграммами BPMN" });
    return;
  }
  attachment(res, `${session.meta.processName}.bpmn.zip`);
  res.type("application/zip").send(await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
});

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

/** Параметры печати листа IDEF0: paper (A4, A3, A2) и orientation (landscape, portrait); без них — по формату листа диаграммы. */
function printOptions(req: { query: Record<string, unknown> }): { paper?: string; orientation?: Orientation } | null {
  const paper = typeof req.query.paper === "string" ? req.query.paper.toUpperCase() : undefined;
  const orientation = typeof req.query.orientation === "string" ? req.query.orientation : undefined;
  if ((paper && !PAPER_MM[paper]) || (orientation && orientation !== "landscape" && orientation !== "portrait")) return null;
  return { paper, orientation: orientation as Orientation | undefined };
}

/** Страница для печати листа IDEF0: бумага нужного формата, лист вписан по центру. */
exportRouter.get("/sessions/:id/export/idef0/:diagram.print.html", (req, res) => {
  const session = requireReady(req, res);
  if (!session) return;
  const opts = printOptions(req);
  if (!opts) {
    res.status(400).json({ error: "paper: A4, A3 или A2; orientation: landscape или portrait" });
    return;
  }
  const page = idef0PrintHtml(session.model!, req.params.diagram, opts);
  if (!page) {
    res.status(404).json({ error: "неизвестная диаграмма" });
    return;
  }
  res.type("text/html; charset=utf-8").send(page.html);
});

/** Лист IDEF0 в PDF (нужен Chromium, как у альбома); без него — подсказка про страницу печати. */
exportRouter.get("/sessions/:id/export/idef0/:diagram.pdf", async (req, res) => {
  const session = requireReady(req, res);
  if (!session) return;
  const opts = printOptions(req);
  if (!opts) {
    res.status(400).json({ error: "paper: A4, A3 или A2; orientation: landscape или portrait" });
    return;
  }
  const page = idef0PrintHtml(session.model!, req.params.diagram, opts);
  if (!page) {
    res.status(404).json({ error: "неизвестная диаграмма" });
    return;
  }
  try {
    const browser = await launchPdfBrowser();
    try {
      const p = await browser.newPage();
      await p.setContent(page.html, { waitUntil: "load" });
      const pdf = await p.pdf({ format: page.paper as "A4", landscape: page.orientation === "landscape", printBackground: true, preferCSSPageSize: true, margin: { top: "0", bottom: "0", left: "0", right: "0" } });
      attachment(res, `${session.meta.processName}.idef0-${req.params.diagram}.${page.paper}.pdf`);
      res.type("application/pdf").send(pdf);
    } finally {
      await browser.close();
    }
  } catch (e) {
    res.status(501).json({
      error: `PDF-рендеринг недоступен в этом окружении (нет Chromium). Откройте /export/idef0/${req.params.diagram}.print.html и сохраните страницу в PDF из браузера.`,
      details: (e as Error).message,
    });
  }
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
    const browser = await launchPdfBrowser();
    let pdf: Buffer;
    try {
      const page = await browser.newPage();
      await page.setContent(await buildAlbumHtml(session), { waitUntil: "networkidle" });
      pdf = await page.pdf({ format: "A4", printBackground: true, margin: { top: "16mm", bottom: "16mm", left: "14mm", right: "14mm" } });
    } finally {
      await browser.close();
    }
    attachment(res, `${session.meta.processName}.album.pdf`);
    res.type("application/pdf").send(pdf);
  } catch (e) {
    res.status(501).json({
      error: "PDF-рендеринг недоступен в этом окружении (нет Chromium). Используйте /export/album.html и печать в PDF из браузера.",
      details: (e as Error).message,
    });
  }
});
