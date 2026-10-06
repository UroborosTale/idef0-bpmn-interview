import { Router } from "express";
import { getSession } from "../repo.js";
import { db } from "../db.js";
import { analyzeImpact, type AdjacentProcessImpact } from "../pipeline/impactAnalysis.js";
import { diffModels } from "../pipeline/diff.js";
import type { ProcessLogicModel } from "../types/model.js";

export const impactAnalysisRouter = Router();

interface ProcessLinkRow {
  id: string;
  from_process_id: string;
  to_process_id: string;
  data_label: string;
  confirmed: number;
}
interface ProcessRow {
  id: string;
  name: string;
  owner: string | null;
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/** ФТ-М7.3.1: смежные процессы через подтверждённые стыки (М3.2), чей data_label совпадает с изменённым объектом данных. */
function findAdjacentProcesses(sessionId: string, before: ProcessLogicModel, after: ProcessLogicModel): AdjacentProcessImpact[] {
  const registryRows = db.prepare(`SELECT id FROM processes WHERE session_id = ?`).all(sessionId) as { id: string }[];
  if (registryRows.length === 0) return [];
  const registryIds = registryRows.map((r) => r.id);

  const d = diffModels(before, after);
  const changedDataNames = new Set([...d.data.added, ...d.data.removed, ...d.data.changed.map((c) => c.after)].map((x) => norm(x.name)));
  if (changedDataNames.size === 0) return [];

  const placeholders = registryIds.map(() => "?").join(",");
  const links = db
    .prepare(`SELECT * FROM process_links WHERE confirmed = 1 AND (from_process_id IN (${placeholders}) OR to_process_id IN (${placeholders}))`)
    .all(...registryIds, ...registryIds) as ProcessLinkRow[];

  const out: AdjacentProcessImpact[] = [];
  for (const link of links) {
    if (!changedDataNames.has(norm(link.data_label))) continue;
    const otherId = registryIds.includes(link.from_process_id) ? link.to_process_id : link.from_process_id;
    const other = db.prepare(`SELECT * FROM processes WHERE id = ?`).get(otherId) as ProcessRow | undefined;
    if (!other) continue;
    out.push({ processId: other.id, name: other.name, owner: other.owner, reason: `изменился общий объект данных «${link.data_label}»` });
  }
  return out;
}

/** ФТ-М7.3: анализ влияния изменений с baseline-версии (по умолчанию — начало текущего цикла согласования либо первая версия). */
impactAnalysisRouter.get("/sessions/:id/impact", (req, res) => {
  const session = getSession(req.params.id);
  if (!session || !session.model) {
    res.status(400).json({ error: "модель ещё не построена" });
    return;
  }
  const sinceParam = req.query.since as string | undefined;
  const sinceSeq = sinceParam ? Number(sinceParam) : session.reviewRoute?.baselineSeq ?? session.versions[0]?.seq;
  const baseline = session.versions.find((v) => v.seq === sinceSeq) ?? session.versions[0];
  if (!baseline) {
    res.json({
      significance: "cosmetic",
      changedElementIds: [],
      changedNodeNames: [],
      adjacentProcesses: [],
      affectedDocuments: [],
      affectedRequirements: [],
      kpiChanged: false,
      note: "нет предыдущей версии для сравнения",
    });
    return;
  }
  const adjacent = findAdjacentProcesses(session.id, baseline.model, session.model);
  const report = analyzeImpact(baseline.model, session.model, adjacent);
  res.json({ ...report, baselineSeq: baseline.seq, currentSeq: session.versions[session.versions.length - 1]?.seq ?? null });
});
