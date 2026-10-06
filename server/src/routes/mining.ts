import { Router } from "express";
import { nanoid } from "nanoid";
import { getSession, updateSession, addVersion, editBlockReason } from "../repo.js";
import { db, logAudit } from "../db.js";
import { parseEventLogCsv, buildDirectlyFollowsGraph, suggestActivityMappings, computeConformance, applyDurationsFromLog, type MiningEvent } from "../pipeline/mining.js";

export const miningRouter = Router();

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

interface MiningLogRow {
  id: string;
  session_id: string;
  filename: string | null;
  events_json: string;
  created_at: string;
}
interface MiningMappingRow {
  session_id: string;
  activity: string;
  node_id: string | null;
  confirmed: number;
}

function loadLog(sessionId: string): { row: MiningLogRow; events: MiningEvent[] } | null {
  const row = db.prepare(`SELECT * FROM mining_logs WHERE session_id = ? ORDER BY created_at DESC LIMIT 1`).get(sessionId) as MiningLogRow | undefined;
  if (!row) return null;
  return { row, events: JSON.parse(row.events_json) as MiningEvent[] };
}

function loadConfirmedMapping(sessionId: string): Map<string, string> {
  const rows = db.prepare(`SELECT * FROM mining_mappings WHERE session_id = ? AND confirmed = 1 AND node_id IS NOT NULL`).all(sessionId) as MiningMappingRow[];
  return new Map(rows.map((r) => [r.activity, r.node_id as string] as const));
}

/** ФТ-М4.3.1: импорт журнала событий CSV (case_id, activity, timestamp, resource) — заменяет предыдущий журнал сессии. */
miningRouter.post("/sessions/:id/mining/import", (req, res) => {
  const session = requireReady(req, res);
  if (!session) return;
  const { csv, filename } = req.body as { csv: string; filename?: string };
  if (!csv || !csv.trim()) {
    res.status(400).json({ error: "csv обязателен" });
    return;
  }
  let events;
  try {
    events = parseEventLogCsv(csv);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
    return;
  }

  db.prepare(`DELETE FROM mining_logs WHERE session_id = ?`).run(req.params.id);
  db.prepare(`DELETE FROM mining_mappings WHERE session_id = ?`).run(req.params.id);
  const logId = `mlog_${nanoid(10)}`;
  db.prepare(`INSERT INTO mining_logs (id, session_id, filename, events_json, created_at) VALUES (?, ?, ?, ?, ?)`).run(
    logId,
    req.params.id,
    filename ?? null,
    JSON.stringify(events),
    new Date().toISOString()
  );

  const dfg = buildDirectlyFollowsGraph(events);
  const suggestions = suggestActivityMappings(dfg.activities, session.model!);
  const insertMapping = db.prepare(`INSERT INTO mining_mappings (session_id, activity, node_id, confirmed) VALUES (?, ?, ?, 0)`);
  for (const s of suggestions) insertMapping.run(req.params.id, s.activity, s.nodeId);

  logAudit(req.params.id, "analyst", "mining_log_imported", { events: events.length, cases: dfg.caseCount, activities: dfg.activities.length });
  res.json({ logId, eventCount: events.length, caseCount: dfg.caseCount, dfg, suggestions });
});

/** Текущий журнал сессии (сводка) + граф непосредственного следования. */
miningRouter.get("/sessions/:id/mining/log", (req, res) => {
  const loaded = loadLog(req.params.id);
  if (!loaded) {
    res.status(404).json({ error: "журнал не импортирован" });
    return;
  }
  const dfg = buildDirectlyFollowsGraph(loaded.events);
  res.json({ logId: loaded.row.id, filename: loaded.row.filename, eventCount: loaded.events.length, caseCount: dfg.caseCount, dfg, importedAt: loaded.row.created_at });
});

/** ФТ-М4.3.2: список сопоставлений активность↔действие PLM (со статусом подтверждения). */
miningRouter.get("/sessions/:id/mining/mappings", (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const rows = db.prepare(`SELECT * FROM mining_mappings WHERE session_id = ?`).all(req.params.id) as MiningMappingRow[];
  const nodeById = new Map((session.model?.nodes ?? []).map((n) => [n.id, n.name] as const));
  res.json(rows.map((r) => ({ activity: r.activity, nodeId: r.node_id, nodeName: r.node_id ? nodeById.get(r.node_id) ?? null : null, confirmed: !!r.confirmed })));
});

/** ФТ-М4.3.2: подтверждение/правка сопоставления активности с действием модели. */
miningRouter.put("/sessions/:id/mining/mappings/:activity", (req, res) => {
  const { nodeId, confirmed } = req.body as { nodeId: string | null; confirmed?: boolean };
  const activity = req.params.activity;
  const existing = db.prepare(`SELECT * FROM mining_mappings WHERE session_id = ? AND activity = ?`).get(req.params.id, activity) as MiningMappingRow | undefined;
  if (existing) {
    db.prepare(`UPDATE mining_mappings SET node_id = ?, confirmed = ? WHERE session_id = ? AND activity = ?`).run(nodeId, confirmed ? 1 : 0, req.params.id, activity);
  } else {
    db.prepare(`INSERT INTO mining_mappings (session_id, activity, node_id, confirmed) VALUES (?, ?, ?, ?)`).run(req.params.id, activity, nodeId, confirmed ? 1 : 0);
  }
  res.json({ activity, nodeId, confirmed: !!confirmed });
});

/** ФТ-М4.3.4: проверка соответствия (fitness/precision) по подтверждённым сопоставлениям. */
miningRouter.get("/sessions/:id/mining/conformance", (req, res) => {
  const session = requireReady(req, res);
  if (!session) return;
  const loaded = loadLog(req.params.id);
  if (!loaded) {
    res.status(404).json({ error: "журнал не импортирован" });
    return;
  }
  const mapping = loadConfirmedMapping(req.params.id);
  if (mapping.size === 0) {
    res.status(409).json({ error: "нет ни одного подтверждённого сопоставления активность↔действие — проверка соответствия невозможна" });
    return;
  }
  res.json(computeConformance(loaded.events, session.model!, mapping));
});

/** ФТ-М4.3.5: подставить в модель фактические длительности из журнала (по подтверждённым сопоставлениям). */
miningRouter.post("/sessions/:id/mining/apply-durations", (req, res) => {
  const session = requireReady(req, res);
  if (!session) return;
  const block = editBlockReason(session);
  if (block) {
    res.status(409).json({ error: block });
    return;
  }
  const loaded = loadLog(req.params.id);
  if (!loaded) {
    res.status(404).json({ error: "журнал не импортирован" });
    return;
  }
  const mapping = loadConfirmedMapping(req.params.id);
  if (mapping.size === 0) {
    res.status(409).json({ error: "нет ни одного подтверждённого сопоставления активность↔действие" });
    return;
  }
  const conformance = computeConformance(loaded.events, session.model!, mapping);
  const model = applyDurationsFromLog(session.model!, conformance.activityStats);
  updateSession(req.params.id, { model });
  logAudit(req.params.id, "analyst", "mining_durations_applied", { nodesUpdated: conformance.activityStats.filter((s) => s.mappedNodeId && s.avgMinutes !== null).length });
  const updated = addVersion(req.params.id, "Подставлены фактические длительности из журнала событий (process mining)");
  res.json(updated);
});

/** ФТ-М4.3.6: отчёт "как описывают" (модель) против "как происходит" (журнал). */
miningRouter.get("/sessions/:id/mining/report", (req, res) => {
  const session = requireReady(req, res);
  if (!session) return;
  const loaded = loadLog(req.params.id);
  if (!loaded) {
    res.status(404).json({ error: "журнал не импортирован" });
    return;
  }
  const mapping = loadConfirmedMapping(req.params.id);
  const dfg = buildDirectlyFollowsGraph(loaded.events);
  const conformance = mapping.size > 0 ? computeConformance(loaded.events, session.model!, mapping) : null;
  res.json({
    modelStepCount: session.model!.nodes.filter((n) => n.type === "task" || n.type === "subprocess").length,
    logActivityCount: dfg.activities.length,
    logCaseCount: dfg.caseCount,
    mappedActivityCount: mapping.size,
    conformance,
  });
});
