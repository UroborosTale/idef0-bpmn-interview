import { Router } from "express";
import { getSession, addVersion, rollbackToVersion, editBlockReason } from "../repo.js";
import { diffModels } from "../pipeline/diff.js";
import { logAudit } from "../db.js";

export const versionsRouter = Router();

/** М7.1: список версий модели (без полного слепка модели — только метаданные). */
versionsRouter.get("/sessions/:id/versions", (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json(
    session.versions.map((v) => ({
      seq: v.seq,
      version: v.version,
      major: v.major,
      ts: v.ts,
      note: v.note,
      author: v.author,
      nodeCount: v.model.nodes.length,
      flowCount: v.model.flows.length,
    }))
  );
});

/** Ручной снимок версии (минорная). Каждое значимое сохранение также создаёт снимок автоматически (см. routes/sessions.ts, routes/process.ts). */
versionsRouter.post("/sessions/:id/versions", (req, res) => {
  const note = (req.body?.note as string) || "снимок версии";
  const author = (req.body?.author as string) || "аналитик";
  try {
    const updated = addVersion(req.params.id, note, { author });
    res.json(updated);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

/**
 * ФТ-М7.1.1: быстрое утверждение — присваивает мажорную версию и статус
 * "approved" напрямую, без маршрута согласования (см. routes/review.ts для
 * полного пути аналитик→владелец→нормоконтролёр, ФТ-М7.2.1).
 */
versionsRouter.post("/sessions/:id/versions/approve", (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const block = editBlockReason(session);
  if (block) {
    res.status(409).json({ error: block });
    return;
  }
  const note = (req.body?.note as string) || "Утверждено";
  const author = (req.body?.author as string) || "владелец процесса";
  try {
    const updated = addVersion(req.params.id, note, { major: true, author });
    logAudit(req.params.id, author, "model_approved", { note });
    res.json(updated);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

/** ФТ-М7.1.3: откат к версии — создаёт новый снимок, история не переписывается. */
versionsRouter.post("/sessions/:id/versions/:seq/rollback", (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const block = editBlockReason(session);
  if (block) {
    res.status(409).json({ error: block });
    return;
  }
  const seq = Number(req.params.seq);
  const author = (req.body?.author as string) || "аналитик";
  try {
    const updated = rollbackToVersion(req.params.id, seq, author);
    res.json(updated);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

/** ФТ-М7.1.2: сравнение двух версий — diff PLM. Визуальный diff диаграмм строится на клиенте по added/removed/changed id. */
versionsRouter.get("/sessions/:id/versions/:a/diff/:b", (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const va = session.versions.find((v) => v.version === req.params.a || String(v.seq) === req.params.a);
  const vb = session.versions.find((v) => v.version === req.params.b || String(v.seq) === req.params.b);
  if (!va || !vb) {
    res.status(404).json({ error: "version not found" });
    return;
  }
  res.json({ from: { seq: va.seq, version: va.version }, to: { seq: vb.seq, version: vb.version }, diff: diffModels(va.model, vb.model) });
});
