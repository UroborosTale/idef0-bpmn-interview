import { Router } from "express";
import { createSession, deleteSession, getSession, listSessionSummaries, updateSession, addVersion, editBlockReason, versionSummaries } from "../repo.js";
import type { SessionMeta } from "../repo.js";
import { ProcessLogicModel, emptyModel } from "../types/model.js";
import { validateModel } from "../pipeline/validate.js";
import { generateBpmn } from "../pipeline/bpmn.js";
import { generateIdef0 } from "../pipeline/idef0.js";
import { detectGaps } from "../pipeline/gaps.js";
import { logAudit } from "../db.js";
import { providerStatus } from "../llm/provider.js";
import { usageForSession } from "../llm/usage.js";

export const sessionsRouter = Router();

sessionsRouter.get("/provider-status", (_req, res) => {
  res.json(providerStatus());
});

sessionsRouter.get("/sessions", (_req, res) => {
  res.json(listSessionSummaries());
});

sessionsRouter.post("/sessions", (req, res) => {
  const body = req.body as { title?: string; mode?: "A" | "B"; meta: SessionMeta };
  if (!body?.meta?.processName) {
    res.status(400).json({ error: "meta.processName is required" });
    return;
  }
  const meta: SessionMeta = {
    processName: body.meta.processName,
    department: body.meta.department,
    owner: body.meta.owner,
    modelType: body.meta.modelType ?? "AS-IS",
    decompositionDepth: body.meta.decompositionDepth ?? 2,
    notations: body.meta.notations ?? ["IDEF0", "BPMN"],
    confidential: body.meta.confidential ?? false,
  };
  const session = createSession({ title: body.title || meta.processName, mode: body.mode ?? "A", meta });
  res.status(201).json(session);
});

/**
 * Режим «рисовать с нуля»: сессия сразу с пустой моделью, без текста интервью и LLM — аналитик строит
 * процесс в студии. Диаграммы собираются из пустой модели, первая версия фиксируется.
 */
sessionsRouter.post("/sessions/blank", async (req, res) => {
  const body = req.body as { title?: string; meta?: SessionMeta };
  if (!body?.meta?.processName?.trim()) {
    res.status(400).json({ error: "meta.processName is required" });
    return;
  }
  const meta: SessionMeta = {
    processName: body.meta.processName.trim(),
    department: body.meta.department,
    owner: body.meta.owner,
    modelType: body.meta.modelType ?? "AS-IS",
    decompositionDepth: body.meta.decompositionDepth ?? 2,
    notations: body.meta.notations ?? ["IDEF0", "BPMN"],
    confidential: body.meta.confidential ?? false,
  };
  const session = createSession({ title: body.title || meta.processName, mode: "A", meta });
  const model = emptyModel({ id: `proc_${Date.now()}`, name: meta.processName, owner: meta.owner, department: meta.department, type: meta.modelType, decomposition_depth: meta.decompositionDepth, notations: meta.notations });
  const bpmn = await generateBpmn(model);
  updateSession(session.id, { model, validation: validateModel(model), bpmnXml: bpmn.xml, idef0: generateIdef0(model), status: "ready", diagramsStale: false });
  logAudit(session.id, "analyst", "blank_session_created");
  addVersion(session.id, "Пустая модель");
  res.status(201).json(sessionForClient(getSession(session.id)!));
});

/** Сессия для клиента: версии — без моделей (снимки целиком отдаёт /sessions/:id/versions/...). */
export function sessionForClient(session: NonNullable<ReturnType<typeof getSession>>) {
  return { ...session, versions: versionSummaries(session.id) };
}

sessionsRouter.get("/sessions/:id", (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json(sessionForClient(session));
});

/** Расход LLM по сессии: вызовы, токены, оценка стоимости. */
sessionsRouter.get("/sessions/:id/llm-usage", (req, res) => {
  res.json(usageForSession(req.params.id));
});

sessionsRouter.delete("/sessions/:id", (req, res) => {
  deleteSession(req.params.id);
  res.status(204).end();
});

sessionsRouter.patch("/sessions/:id", (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const body = req.body as { title?: string; meta?: SessionMeta };
  // мета правится слиянием: устаревший клиент не затирает чужие изменения; доступ агентов — отдельное решение аналитика для конфиденциальной
  // сессии, поэтому он сбрасывается, когда конфиденциальность включают заново, и не хранится у обычных сессий
  let meta = body.meta ? { ...session.meta, ...body.meta } : undefined;
  if (meta && (!meta.confidential || (!session.meta.confidential && body.meta?.agentAccess === undefined))) meta = { ...meta, agentAccess: false };
  const updated = updateSession(req.params.id, { title: body.title, meta });
  logAudit(req.params.id, "analyst", "session_meta_updated", body);
  res.json(updated);
});

/**
 * Правка модели вручную (редактор, ФТ-9.1). Принимает частичную модель
 * (обычно с изменённым узлом/связью), помечает диаграммы как устаревшие
 * (ФТ-8.2), даёт возможность пересобрать их отдельным вызовом.
 */
sessionsRouter.put("/sessions/:id/model", (req, res) => {
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
  // Защита от потерянных правок: клиент присылает updatedAt сессии, с которой начинал правку.
  // Если с тех пор модель изменилась (другая вкладка, повторная обработка) — отказ, правки остаются в черновике.
  const base = req.header("X-Base-Updated-At");
  if (base && base !== session.updatedAt) {
    res.status(409).json({ error: "Модель изменилась после того, как вы начали правку (другая вкладка или повторная обработка). Ваши правки сохранены в черновике редактора: обновите страницу — редактор предложит применить черновик поверх новой модели.", conflict: true });
    return;
  }
  const parsed = ProcessLogicModel.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid model", details: parsed.error.flatten() });
    return;
  }
  const model = parsed.data;
  model.gaps = detectGaps(model);
  const validation = validateModel(model);
  updateSession(req.params.id, { model, validation, diagramsStale: true });
  logAudit(req.params.id, "analyst", "model_edited");
  const updated = addVersion(req.params.id, "Ручная правка модели");
  res.json(updated);
});

/** Пересборка BPMN/IDEF0 из текущей модели после ручной правки (ФТ-8.2). */
sessionsRouter.post("/sessions/:id/rebuild-diagrams", async (req, res) => {
  const session = getSession(req.params.id);
  if (!session || !session.model) {
    res.status(404).json({ error: "no model" });
    return;
  }
  const bpmn = await generateBpmn(session.model);
  const idef0 = generateIdef0(session.model);
  const updated = updateSession(req.params.id, { bpmnXml: bpmn.xml, idef0, diagramsStale: false });
  res.json(updated);
});

// Версионирование (снимок/утверждение/откат/сравнение) вынесено в routes/versions.ts (М7.1).

sessionsRouter.post("/sessions/:id/comments", (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const { element_id, text, author } = req.body as { element_id: string | null; text: string; author?: string };
  if (!text) {
    res.status(400).json({ error: "text is required" });
    return;
  }
  const comment = { id: `c_${Date.now()}_${Math.round(Math.random() * 1e6)}`, element_id, text, author: author || "аналитик", ts: new Date().toISOString() };
  const updated = updateSession(req.params.id, { comments: [...session.comments, comment] });
  res.status(201).json(updated);
});
