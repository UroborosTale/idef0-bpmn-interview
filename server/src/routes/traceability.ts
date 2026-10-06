import { Router } from "express";
import { getSession, updateSession, addVersion, editBlockReason } from "../repo.js";
import { db } from "../db.js";
import { buildTraceabilityReport, type RequirementCatalogEntry } from "../pipeline/traceability.js";

export const traceabilityRouter = Router();

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

function loadCatalog(): RequirementCatalogEntry[] {
  return db.prepare(`SELECT id, code, title FROM requirements ORDER BY source, code`).all() as RequirementCatalogEntry[];
}

/** ФТ-М6.3.1: список связей требование↔элемент модели для сессии. */
traceabilityRouter.get("/sessions/:id/requirements-links", (req, res) => {
  const session = requireReady(req, res);
  if (!session) return;
  res.json(session.model!.requirements_links);
});

/** ФТ-М6.3.1: добавить связь требование↔элемент. */
traceabilityRouter.post("/sessions/:id/requirements-links", (req, res) => {
  const session = requireReady(req, res);
  if (!session) return;
  const block = editBlockReason(session);
  if (block) {
    res.status(409).json({ error: block });
    return;
  }
  const { requirement_id, element_id, coverage } = req.body as { requirement_id: string; element_id: string; coverage?: "full" | "partial" };
  if (!requirement_id || !element_id) {
    res.status(400).json({ error: "requirement_id and element_id are required" });
    return;
  }
  const exists = session.model!.requirements_links.some((l) => l.requirement_id === requirement_id && l.element_id === element_id);
  const requirements_links = exists
    ? session.model!.requirements_links.map((l) => (l.requirement_id === requirement_id && l.element_id === element_id ? { ...l, coverage: coverage ?? l.coverage } : l))
    : [...session.model!.requirements_links, { requirement_id, element_id, coverage: coverage ?? "full" }];
  const model = { ...session.model!, requirements_links };
  updateSession(req.params.id, { model });
  const updated = addVersion(req.params.id, "Трассировка требований: добавлена связь");
  res.json(updated);
});

/** ФТ-М6.3.1: удалить связь требование↔элемент. */
traceabilityRouter.delete("/sessions/:id/requirements-links", (req, res) => {
  const session = requireReady(req, res);
  if (!session) return;
  const block = editBlockReason(session);
  if (block) {
    res.status(409).json({ error: block });
    return;
  }
  const { requirement_id, element_id } = req.body as { requirement_id: string; element_id: string };
  const requirements_links = session.model!.requirements_links.filter((l) => !(l.requirement_id === requirement_id && l.element_id === element_id));
  const model = { ...session.model!, requirements_links };
  updateSession(req.params.id, { model });
  const updated = addVersion(req.params.id, "Трассировка требований: удалена связь");
  res.json(updated);
});

/** ФТ-М6.3.2: отчёт трассировки — покрытие требований элементами модели, разрывы в обе стороны. */
traceabilityRouter.get("/sessions/:id/traceability", (req, res) => {
  const session = requireReady(req, res);
  if (!session) return;
  res.json(buildTraceabilityReport(session.model!, loadCatalog()));
});
