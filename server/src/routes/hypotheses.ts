import { Router } from "express";
import { nanoid } from "nanoid";
import { getSession, createSession, updateSession, addVersion } from "../repo.js";
import { db, logAudit } from "../db.js";
import { generateHypotheses, applyHypothesis, TEMPLATE_LABEL, type Hypothesis, type HypothesisTemplate } from "../pipeline/hypotheses.js";
import { analyzeBottlenecks, analyzeCost } from "../pipeline/analytics.js";
import { diffModels } from "../pipeline/diff.js";
import { validateModel } from "../pipeline/validate.js";
import { generateBpmn } from "../pipeline/bpmn.js";
import { generateIdef0 } from "../pipeline/idef0.js";
import { logAgentStep } from "../pipeline/agents.js";

export const hypothesesRouter = Router();

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

interface RoleRateRow {
  role_name: string;
  rate: number;
}
function loadRatesMap(): Map<string, number> {
  const rows = db.prepare(`SELECT role_name, rate FROM role_rates`).all() as RoleRateRow[];
  return new Map(rows.map((r) => [r.role_name.toLowerCase(), r.rate] as const));
}

interface HypothesisRow {
  id: string;
  session_id: string;
  template: string;
  title: string;
  description: string;
  affected_element_ids_json: string;
  minutes_saved: number | null;
  cost_saved: number | null;
  risks: string;
  assumptions: string;
  status: string;
  applied_session_id: string | null;
  created_at: string;
}
function rowOut(r: HypothesisRow) {
  return {
    id: r.id,
    template: r.template as HypothesisTemplate,
    templateLabel: TEMPLATE_LABEL[r.template as HypothesisTemplate] ?? r.template,
    title: r.title,
    description: r.description,
    affectedElementIds: JSON.parse(r.affected_element_ids_json) as string[],
    minutesSaved: r.minutes_saved,
    costSaved: r.cost_saved,
    risks: r.risks,
    assumptions: r.assumptions,
    status: r.status,
    appliedSessionId: r.applied_session_id,
    createdAt: r.created_at,
  };
}

/** ФТ-М2.4.1/2.4.2: (пере)генерация гипотез TO-BE — заменяет предложенные ранее, сохраняет применённые/отклонённые. */
hypothesesRouter.post("/sessions/:id/tobe-hypotheses/generate", (req, res) => {
  const session = requireReady(req, res);
  if (!session) return;
  const hyps = generateHypotheses(session.model!, loadRatesMap());

  db.prepare(`DELETE FROM tobe_hypotheses WHERE session_id = ? AND status = 'proposed'`).run(req.params.id);
  const insert = db.prepare(
    `INSERT INTO tobe_hypotheses (id, session_id, template, title, description, affected_element_ids_json, minutes_saved, cost_saved, risks, assumptions, status, applied_session_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', NULL, ?)`
  );
  const now = new Date().toISOString();
  for (const h of hyps) {
    insert.run(h.id, req.params.id, h.template, h.title, h.description, JSON.stringify(h.affectedElementIds), h.minutesSaved, h.costSaved, h.risks, h.assumptions, now);
  }
  logAgentStep(req.params.id, `run_${nanoid(10)}`, 1, "analyst", `Сформировано гипотез TO-BE: ${hyps.length}`);
  const rows = db.prepare(`SELECT * FROM tobe_hypotheses WHERE session_id = ? ORDER BY created_at DESC`).all(req.params.id) as HypothesisRow[];
  res.json(rows.map(rowOut));
});

/** Список гипотез сессии (все статусы). */
hypothesesRouter.get("/sessions/:id/tobe-hypotheses", (req, res) => {
  const rows = db.prepare(`SELECT * FROM tobe_hypotheses WHERE session_id = ? ORDER BY created_at DESC`).all(req.params.id) as HypothesisRow[];
  res.json(rows.map(rowOut));
});

/** ФТ-М2.4.3/2.4.4: применение принятой гипотезы — создаёт НОВУЮ TO-BE сессию, исходная модель не меняется. */
hypothesesRouter.post("/sessions/:id/tobe-hypotheses/:hypId/apply", async (req, res) => {
  const session = requireReady(req, res);
  if (!session) return;
  const row = db.prepare(`SELECT * FROM tobe_hypotheses WHERE id = ? AND session_id = ?`).get(req.params.hypId, req.params.id) as HypothesisRow | undefined;
  if (!row) {
    res.status(404).json({ error: "гипотеза не найдена" });
    return;
  }
  if (row.status !== "proposed") {
    res.status(409).json({ error: `гипотеза уже в статусе "${row.status}"` });
    return;
  }
  const hyp: Hypothesis = {
    id: row.id,
    template: row.template as HypothesisTemplate,
    title: row.title,
    description: row.description,
    affectedElementIds: JSON.parse(row.affected_element_ids_json),
    minutesSaved: row.minutes_saved,
    costSaved: row.cost_saved,
    risks: row.risks,
    assumptions: row.assumptions,
  };

  const toBeModel = applyHypothesis(session.model!, hyp);
  const validation = validateModel(toBeModel);
  const bpmn = await generateBpmn(toBeModel);
  const idef0 = generateIdef0(toBeModel);

  const newSession = createSession({
    title: `${session.title} — TO-BE (${TEMPLATE_LABEL[hyp.template]})`,
    mode: "A",
    meta: { ...session.meta, processName: `${session.meta.processName} (TO-BE)`, modelType: "TO-BE" },
  });
  updateSession(newSession.id, {
    fragments: session.fragments,
    rawText: session.rawText,
    model: toBeModel,
    validation,
    bpmnXml: bpmn.xml,
    idef0,
    status: "ready",
    diagramsStale: false,
  });
  addVersion(newSession.id, `Применена гипотеза: ${hyp.title}`);

  db.prepare(`UPDATE tobe_hypotheses SET status = 'applied', applied_session_id = ? WHERE id = ?`).run(newSession.id, hyp.id);
  logAudit(req.params.id, "analyst", "hypothesis_applied", { hypothesisId: hyp.id, template: hyp.template, newSessionId: newSession.id });

  res.json({ session: getSession(newSession.id), hypothesisId: hyp.id });
});

hypothesesRouter.post("/sessions/:id/tobe-hypotheses/:hypId/dismiss", (req, res) => {
  const result = db.prepare(`UPDATE tobe_hypotheses SET status = 'dismissed' WHERE id = ? AND session_id = ? AND status = 'proposed'`).run(req.params.hypId, req.params.id);
  if (result.changes === 0) {
    res.status(404).json({ error: "гипотеза не найдена или уже обработана" });
    return;
  }
  res.status(204).end();
});

// --- ФТ-М2.5: сравнение AS-IS и TO-BE ---

function buildCompareReport(asIsModel: any, toBeModel: any, rates: Map<string, number>) {
  const diff = diffModels(asIsModel, toBeModel);
  const bAsIs = analyzeBottlenecks(asIsModel);
  const bToBe = analyzeBottlenecks(toBeModel);
  const cAsIs = analyzeCost(asIsModel, rates);
  const cToBe = analyzeCost(toBeModel, rates);
  return {
    diff,
    delta: {
      stepCount: { before: asIsModel.nodes.filter((n: any) => n.type === "task" || n.type === "subprocess").length, after: toBeModel.nodes.filter((n: any) => n.type === "task" || n.type === "subprocess").length },
      handoffCount: { before: bAsIs.handoffCount, after: bToBe.handoffCount },
      cycleTimeMinutes: { before: bAsIs.mainPath?.totalMinutes ?? null, after: bToBe.mainPath?.totalMinutes ?? null },
      laborCostPerInstance: { before: cAsIs.totalCostPerInstance, after: cToBe.totalCostPerInstance },
    },
  };
}

hypothesesRouter.get("/sessions/:asIsId/compare/:toBeId", (req, res) => {
  const asIs = getSession(req.params.asIsId);
  const toBe = getSession(req.params.toBeId);
  if (!asIs?.model || !toBe?.model) {
    res.status(404).json({ error: "одна из сессий не найдена или не имеет модели" });
    return;
  }
  res.json(buildCompareReport(asIs.model, toBe.model, loadRatesMap()));
});

function fmtMinutes(m: number | null): string {
  if (m === null) return "—";
  if (m >= 1440) return `${(m / 1440).toFixed(1)} дн.`;
  if (m >= 60) return `${(m / 60).toFixed(1)} ч.`;
  return `${m.toFixed(0)} мин.`;
}
function fmtMoney(v: number | null): string {
  return v === null ? "—" : `${v.toLocaleString("ru-RU", { maximumFractionDigits: 0 })} ₽`;
}
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildCompareHtml(asIsName: string, toBeName: string, report: ReturnType<typeof buildCompareReport>): string {
  const d = report.delta;
  const rows = [
    ["Число шагов", d.stepCount.before, d.stepCount.after],
    ["Передач между ролями", d.handoffCount.before, d.handoffCount.after],
    ["Время цикла (основной путь)", fmtMinutes(d.cycleTimeMinutes.before), fmtMinutes(d.cycleTimeMinutes.after)],
    ["Стоимость экземпляра процесса", fmtMoney(d.laborCostPerInstance.before), fmtMoney(d.laborCostPerInstance.after)],
  ];
  return `<!DOCTYPE html>
<html lang="ru"><head><meta charset="utf-8" /><title>Сравнение AS-IS/TO-BE — ${esc(asIsName)}</title>
<style>
  body { font-family: "Times New Roman", Georgia, serif; color:#111827; margin:0; padding:32px 48px; line-height:1.5; }
  h1 { font-size:20px; text-align:center; margin-bottom:4px; }
  .subtitle { text-align:center; color:#4b5563; font-size:13px; margin-bottom:24px; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th,td { border:1px solid #d1d5db; padding:6px 10px; text-align:left; }
  th { background:#f1f5f9; }
  h2 { font-size:15px; margin-top:26px; border-bottom:1px solid #d1d5db; padding-bottom:4px; }
  .stat { font-size:12px; color:#4b5563; margin:4px 0; }
</style></head>
<body>
  <h1>СРАВНЕНИЕ AS-IS / TO-BE</h1>
  <div class="subtitle">AS-IS: «${esc(asIsName)}» → TO-BE: «${esc(toBeName)}»</div>
  <h2>Таблица дельты</h2>
  <table><thead><tr><th>Показатель</th><th>AS-IS</th><th>TO-BE</th></tr></thead>
  <tbody>${rows.map((r) => `<tr><td>${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td></tr>`).join("")}</tbody></table>
  <h2>Изменения модели</h2>
  <div class="stat">Добавлено шагов: ${report.diff.nodes.added.length}, удалено: ${report.diff.nodes.removed.length}, изменено: ${report.diff.nodes.changed.length}</div>
  <div class="stat">Добавлено связей: ${report.diff.flows.added.length}, удалено: ${report.diff.flows.removed.length}, изменено: ${report.diff.flows.changed.length}</div>
  <div class="stat">Изменено ролей: ${report.diff.roles.added.length + report.diff.roles.removed.length + report.diff.roles.changed.length}</div>
</body></html>`;
}

hypothesesRouter.get("/sessions/:asIsId/compare/:toBeId/preview.html", (req, res) => {
  const asIs = getSession(req.params.asIsId);
  const toBe = getSession(req.params.toBeId);
  if (!asIs?.model || !toBe?.model) {
    res.status(404).json({ error: "одна из сессий не найдена или не имеет модели" });
    return;
  }
  const report = buildCompareReport(asIs.model, toBe.model, loadRatesMap());
  res.type("text/html; charset=utf-8").send(buildCompareHtml(asIs.meta.processName, toBe.meta.processName, report));
});

/** ФТ-М2.5.3: выгрузка сравнения в PDF (тот же подход, что и export/album.pdf — рендер HTML через headless Chromium). */
hypothesesRouter.get("/sessions/:asIsId/compare/:toBeId/export.pdf", async (req, res) => {
  const asIs = getSession(req.params.asIsId);
  const toBe = getSession(req.params.toBeId);
  if (!asIs?.model || !toBe?.model) {
    res.status(404).json({ error: "одна из сессий не найдена или не имеет модели" });
    return;
  }
  const report = buildCompareReport(asIs.model, toBe.model, loadRatesMap());
  const html = buildCompareHtml(asIs.meta.processName, toBe.meta.processName, report);
  try {
    const { chromium } = await import("playwright");
    const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || "/opt/pw-browsers/chromium";
    const browser = await chromium.launch({ executablePath, args: ["--no-sandbox"] }).catch(() => chromium.launch());
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle" });
    const pdf = await page.pdf({ format: "A4", printBackground: true, margin: { top: "16mm", bottom: "16mm", left: "14mm", right: "14mm" } });
    await browser.close();
    res.setHeader("Content-Disposition", `attachment; filename="compare-as-is-to-be.pdf"`);
    res.type("application/pdf").send(pdf);
  } catch (e) {
    res.status(501).json({
      error: "PDF-рендеринг недоступен в этом окружении (нет Chromium). Используйте /compare/.../preview.html и печать в PDF из браузера.",
      details: (e as Error).message,
    });
  }
});
