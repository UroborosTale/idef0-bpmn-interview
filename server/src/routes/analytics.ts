import { Router } from "express";
import { getSession, updateSession, editBlockReason } from "../repo.js";
import { db, logAudit } from "../db.js";
import { analyzeBottlenecks, analyzeCost, analyzeSensitivity, generateTimingGaps } from "../pipeline/analytics.js";
import { detectAntipatterns } from "../pipeline/antipatterns.js";
import { logAgentStep } from "../pipeline/agents.js";
import { nanoid } from "nanoid";

export const analyticsRouter = Router();

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

/** ФТ-М2.1: узкие места — время цикла, ожидание, передачи, согласования, циклы, тепловая карта. */
analyticsRouter.get("/sessions/:id/analytics/bottlenecks", (req, res) => {
  const session = requireReady(req, res);
  if (!session) return;
  res.json(analyzeBottlenecks(session.model!));
});

/** ФТ-М2.1.3: если данных о длительности нет — добавляет вопросы в пробелы (переиспользует интерфейс интервью М4). */
analyticsRouter.post("/sessions/:id/analytics/request-timing-gaps", (req, res) => {
  const session = requireReady(req, res);
  if (!session) return;
  const block = editBlockReason(session);
  if (block) {
    res.status(409).json({ error: block });
    return;
  }
  const timingGaps = generateTimingGaps(session.model!);
  const existingIds = new Set(session.model!.gaps.map((g) => g.id));
  const newGaps = timingGaps.filter((g) => !existingIds.has(g.id));
  const model = { ...session.model!, gaps: [...session.model!.gaps, ...newGaps] };
  updateSession(req.params.id, { model });
  logAudit(req.params.id, "analyst", "timing_gaps_requested", { count: newGaps.length });
  res.json({ added: newGaps.length, gaps: newGaps });
});

/** ФТ-М2.3: антипаттерны — двойной ввод, ручная передача, избыточное согласование, шаг без выхода, петля без выхода, пинг-понг. */
analyticsRouter.get("/sessions/:id/analytics/antipatterns", (req, res) => {
  const session = requireReady(req, res);
  if (!session) return;
  const findings = detectAntipatterns(session.model!);
  logAgentStep(req.params.id, `run_${nanoid(10)}`, 1, "analyst", `Найдено антипаттернов: ${findings.length}`);
  res.json(findings);
});

// --- ФТ-М2.2: ставки ролей (общий справочник, не привязан к сессии) ---
interface RoleRateRow {
  role_key: string;
  role_name: string;
  rate: number;
  unit: string;
}
analyticsRouter.get("/role-rates", (_req, res) => {
  res.json(db.prepare(`SELECT * FROM role_rates ORDER BY role_name`).all());
});
analyticsRouter.put("/role-rates/:roleKey", (req, res) => {
  const { role_name, rate, unit } = req.body as { role_name: string; rate: number; unit?: string };
  if (!role_name || typeof rate !== "number") {
    res.status(400).json({ error: "role_name and numeric rate are required" });
    return;
  }
  db.prepare(
    `INSERT INTO role_rates (role_key, role_name, rate, unit) VALUES (?, ?, ?, ?)
     ON CONFLICT(role_key) DO UPDATE SET role_name = excluded.role_name, rate = excluded.rate, unit = excluded.unit`
  ).run(req.params.roleKey, role_name, rate, unit ?? "per_hour");
  res.json({ role_key: req.params.roleKey, role_name, rate, unit: unit ?? "per_hour" } satisfies RoleRateRow);
});
analyticsRouter.delete("/role-rates/:roleKey", (req, res) => {
  db.prepare(`DELETE FROM role_rates WHERE role_key = ?`).run(req.params.roleKey);
  res.status(204).end();
});

function loadRatesMap(): Map<string, number> {
  const rows = db.prepare(`SELECT * FROM role_rates`).all() as RoleRateRow[];
  return new Map(rows.map((r) => [r.role_name.toLowerCase(), r.rate] as const));
}

/** ФТ-М2.2.1/2.2.2: трудозатраты по ролям и стоимость экземпляра/периода. */
analyticsRouter.get("/sessions/:id/analytics/cost", (req, res) => {
  const session = requireReady(req, res);
  if (!session) return;
  const frequencyParam = req.query.frequency ? Number(req.query.frequency) : undefined;
  res.json(analyzeCost(session.model!, loadRatesMap(), frequencyParam));
});

/** ФТ-М2.2.3: анализ чувствительности к частоте и длительности. */
analyticsRouter.get("/sessions/:id/analytics/sensitivity", (req, res) => {
  const session = requireReady(req, res);
  if (!session) return;
  const baseFrequency = req.query.frequency ? Number(req.query.frequency) : session.model!.process.frequency_per_month ?? null;
  res.json(analyzeSensitivity(session.model!, loadRatesMap(), baseFrequency));
});

/** Сохранение частоты процесса (используется расчётом стоимости, если не передана явно). */
analyticsRouter.put("/sessions/:id/analytics/frequency", (req, res) => {
  const session = requireReady(req, res);
  if (!session) return;
  const block = editBlockReason(session);
  if (block) {
    res.status(409).json({ error: block });
    return;
  }
  const { frequency_per_month } = req.body as { frequency_per_month: number | null };
  const model = { ...session.model!, process: { ...session.model!.process, frequency_per_month } };
  updateSession(req.params.id, { model });
  res.json({ frequency_per_month });
});
