import { Router } from "express";
import { getSession, updateSession, editBlockReason } from "../repo.js";
import { logAudit } from "../db.js";
import { computeCriticality, generateAdaptiveDepthGaps } from "../pipeline/adaptiveDepth.js";

export const adaptiveDepthRouter = Router();

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

/** ФТ-М4.5.1/4.5.3: оценка критичности участков процесса. */
adaptiveDepthRouter.get("/sessions/:id/adaptive-depth/criticality", (req, res) => {
  const session = requireReady(req, res);
  if (!session) return;
  res.json(computeCriticality(session.model!));
});

/** ФТ-М4.5.2: добавить вопросы на доуточнение критичных, но слабо детализированных участков (в пробелы — переиспользует М4). */
adaptiveDepthRouter.post("/sessions/:id/adaptive-depth/request-gaps", (req, res) => {
  const session = requireReady(req, res);
  if (!session) return;
  const block = editBlockReason(session);
  if (block) {
    res.status(409).json({ error: block });
    return;
  }
  const newGapsAll = generateAdaptiveDepthGaps(session.model!);
  const existingIds = new Set(session.model!.gaps.map((g) => g.id));
  const newGaps = newGapsAll.filter((g) => !existingIds.has(g.id));
  const model = { ...session.model!, gaps: [...session.model!.gaps, ...newGaps] };
  updateSession(req.params.id, { model });
  logAudit(req.params.id, "analyst", "adaptive_depth_gaps_requested", { count: newGaps.length });
  res.json({ added: newGaps.length, gaps: newGaps });
});
