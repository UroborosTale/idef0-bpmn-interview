import { Router } from "express";
import { getSession, listSessions } from "../repo.js";
import { db } from "../db.js";
import { runChecklist } from "../pipeline/checklist.js";
import { buildAuditPackageHtml, buildAuditPackageZip } from "../export/auditPackage.js";

export const auditPackageRouter = Router();

interface ChecklistRuleRow {
  id: string;
  code: string;
  label: string;
  enabled: number;
}
interface RequirementRow {
  id: string;
  code: string;
  title: string;
  source: string;
}

function enabledChecklistRules(): { code: string; label: string }[] {
  return (db.prepare(`SELECT * FROM checklist_rules WHERE enabled = 1 ORDER BY label`).all() as ChecklistRuleRow[]).map((r) => ({
    code: r.code,
    label: r.label,
  }));
}

function requireReady(req: any, res: any) {
  const session = getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: "not found" });
    return null;
  }
  if (!session.model) {
    res.status(400).json({ error: "модель ещё не построена" });
    return null;
  }
  return session;
}

function asciiFallback(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return ascii || "audit-package";
}
function attachment(res: any, filename: string) {
  res.setHeader("Content-Disposition", `attachment; filename="${asciiFallback(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
}

/** ФТ-М6.4.1: HTML-предпросмотр пакета к аудиту по процессу. */
auditPackageRouter.get("/sessions/:id/audit-package/preview.html", async (req, res) => {
  const session = requireReady(req, res);
  if (!session) return;
  const checklist = runChecklist(session.model!, enabledChecklistRules());
  res.type("text/html; charset=utf-8").send(await buildAuditPackageHtml(session, checklist));
});

/** ФТ-М6.4.1: PDF-версия пакета к аудиту (обложка со сводкой, диаграммы, регламент, RACI, история версий). */
auditPackageRouter.get("/sessions/:id/audit-package/export.pdf", async (req, res) => {
  const session = requireReady(req, res);
  if (!session) return;
  const checklist = runChecklist(session.model!, enabledChecklistRules());
  try {
    const { chromium } = await import("playwright");
    const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || "/opt/pw-browsers/chromium";
    const browser = await chromium.launch({ executablePath, args: ["--no-sandbox"] }).catch(() => chromium.launch());
    const page = await browser.newPage();
    await page.setContent(await buildAuditPackageHtml(session, checklist), { waitUntil: "networkidle" });
    const pdf = await page.pdf({ format: "A4", printBackground: true, margin: { top: "16mm", bottom: "16mm", left: "14mm", right: "14mm" } });
    await browser.close();
    attachment(res, `${session.meta.processName}.audit-package.pdf`);
    res.type("application/pdf").send(pdf);
  } catch (e) {
    res.status(501).json({
      error: "PDF-рендеринг недоступен в этом окружении (нет Chromium). Используйте /audit-package/preview.html и печать в PDF из браузера.",
      details: (e as Error).message,
    });
  }
});

/** ФТ-М6.4.2: полный пакет документов к аудиту в .zip. */
auditPackageRouter.get("/sessions/:id/audit-package/export.zip", async (req, res) => {
  const session = requireReady(req, res);
  if (!session) return;
  const checklist = runChecklist(session.model!, enabledChecklistRules());
  const buf = await buildAuditPackageZip(session, checklist);
  attachment(res, `${session.meta.processName}.audit-package.zip`);
  res.type("application/zip").send(buf);
});

/** ФТ-М6.4.1: пакет к аудиту "по выбранному требованию" — сводка покрытия требования по всем сессиям, где оно связано с элементами модели. */
auditPackageRouter.get("/requirements/:reqId/audit-package", (req, res) => {
  const requirement = db.prepare(`SELECT * FROM requirements WHERE id = ?`).get(req.params.reqId) as RequirementRow | undefined;
  if (!requirement) {
    res.status(404).json({ error: "требование не найдено" });
    return;
  }
  const sessions = listSessions().filter((s) => s.model);
  const coverage = sessions
    .map((s) => {
      const links = s.model!.requirements_links.filter((l) => l.requirement_id === req.params.reqId);
      if (links.length === 0) return null;
      const elements = links.map((l) => {
        const node = s.model!.nodes.find((n) => n.id === l.element_id);
        const control = s.model!.controls.find((c) => c.id === l.element_id);
        return { elementId: l.element_id, name: node?.name ?? control?.name ?? l.element_id, coverage: l.coverage };
      });
      return { sessionId: s.id, processName: s.meta.processName, status: s.model!.process.status, elements };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  res.json({
    requirement: { id: requirement.id, code: requirement.code, title: requirement.title, source: requirement.source },
    coveredByProcessCount: coverage.length,
    totalProcessCount: sessions.length,
    coverage,
  });
});
