import { Router } from "express";
import { getSession, updateSession } from "../repo.js";
import { buildRegulation } from "../pipeline/regulation.js";
import { buildRegulationHtml, buildRegulationDocx } from "../export/regulation.js";
import { diffModels } from "../pipeline/diff.js";
import { logAgentStep } from "../pipeline/agents.js";
import { logAudit } from "../db.js";
import { nanoid } from "nanoid";

export const regulationRouter = Router();

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

/** ФТ-М1.1.4: множество id элементов PLM, изменившихся с момента последней генерации регламента. */
function computeChangedIds(session: NonNullable<ReturnType<typeof getSession>>): Set<string> {
  if (session.regulationSnapshotSeq == null) return new Set(); // регламент ещё не генерировался — не помечаем ничего
  const snap = session.versions.find((v) => v.seq === session.regulationSnapshotSeq);
  if (!snap || !session.model) return new Set();
  const d = diffModels(snap.model, session.model);
  const changed = new Set<string>();
  const collect = (part: { added: { id: string }[]; removed: { id: string }[]; changed: { id: string }[] }) => {
    for (const x of part.added) changed.add(x.id);
    for (const x of part.removed) changed.add(x.id);
    for (const x of part.changed) changed.add(x.id);
  };
  collect(d.nodes);
  collect(d.flows);
  collect(d.roles);
  collect(d.systems);
  collect(d.data);
  collect(d.controls);
  collect(d.kpi);
  if (d.process) {
    // process-level изменения (цель/триггер/результат/владелец) затрагивают раздел "Общие положения" целиком
    changed.add("__process__");
  }
  return changed;
}

function staleParagraphIds(session: NonNullable<ReturnType<typeof getSession>>): Set<string> {
  const changed = computeChangedIds(session);
  if (changed.size === 0) return new Set();
  const paragraphs = buildRegulation(session.model!);
  const stale = new Set<string>();
  for (const p of paragraphs) {
    if (p.section === "general" && changed.has("__process__")) {
      stale.add(p.id);
      continue;
    }
    if (p.sourceRefs.some((ref) => changed.has(ref))) stale.add(p.id);
  }
  return stale;
}

/** ФТ-М1.1.4: какие абзацы устарели после изменения модели с момента последней генерации. */
regulationRouter.get("/sessions/:id/regulation/staleness", (req, res) => {
  const session = requireReady(req, res);
  if (!session) return;
  const stale = staleParagraphIds(session);
  res.json({
    generatedAtSeq: session.regulationSnapshotSeq,
    currentSeq: session.versions[session.versions.length - 1]?.seq ?? null,
    staleCount: stale.size,
    staleParagraphIds: [...stale],
  });
});

/** Отмечает регламент как перегенерированный на текущую версию модели (снимает флаг устаревания). */
regulationRouter.post("/sessions/:id/regulation/mark-generated", (req, res) => {
  const session = requireReady(req, res);
  if (!session) return;
  const seq = session.versions[session.versions.length - 1]?.seq ?? null;
  updateSession(req.params.id, { regulationSnapshotSeq: seq });
  logAudit(req.params.id, "analyst", "regulation_generated", { seq });
  logAgentStep(req.params.id, `run_${nanoid(10)}`, 1, "documentalist", `Сгенерирован регламент по версии seq=${seq}`);
  res.json({ regulationSnapshotSeq: seq });
});

/** ФТ-М1.1.2/1.1.5: HTML-предпросмотр (?structureOnly=1 — только каркас разделов). */
regulationRouter.get("/sessions/:id/regulation/preview", (req, res) => {
  const session = requireReady(req, res);
  if (!session) return;
  const structureOnly = req.query.structureOnly === "1";
  const stale = staleParagraphIds(session);
  res.type("text/html; charset=utf-8").send(buildRegulationHtml(session, { structureOnly, staleIds: stale }));
});

regulationRouter.get("/sessions/:id/regulation/export.html", (req, res) => {
  const session = requireReady(req, res);
  if (!session) return;
  const structureOnly = req.query.structureOnly === "1";
  res.setHeader("Content-Disposition", `attachment; filename="regulation.html"`);
  res.type("text/html; charset=utf-8").send(buildRegulationHtml(session, { structureOnly }));
});

/** ФТ-М1.1.1: экспорт в реальный .docx. */
regulationRouter.get("/sessions/:id/regulation/export.docx", async (req, res) => {
  const session = requireReady(req, res);
  if (!session) return;
  const structureOnly = req.query.structureOnly === "1";
  const buf = await buildRegulationDocx(session, { structureOnly });
  res.setHeader("Content-Disposition", `attachment; filename="regulation.docx"`);
  res.type("application/vnd.openxmlformats-officedocument.wordprocessingml.document").send(buf);
});
