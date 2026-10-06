import { Router } from "express";
import { nanoid } from "nanoid";
import { getSession, updateSession, addVersion, editBlockReason } from "../repo.js";
import type { SessionRespondent, InterviewTrack } from "../repo.js";
import { fragmentText } from "../pipeline/fragment.js";
import { extractModel } from "../pipeline/extract.js";
import { detectGaps } from "../pipeline/gaps.js";
import { validateModel } from "../pipeline/validate.js";
import { generateBpmn } from "../pipeline/bpmn.js";
import { generateIdef0 } from "../pipeline/idef0.js";
import { getLLMProvider } from "../llm/provider.js";
import { startTrackChat, turnTrackChat } from "../pipeline/trackInterview.js";
import { mergeTracks } from "../pipeline/multiInterview.js";
import { logAgentStep } from "../pipeline/agents.js";
import { logAudit } from "../db.js";
import type { ProcessLogicModel } from "../types/model.js";

export const multiInterviewRouter = Router();

/** ФТ-М4.1.1: список респондентов и их дорожек интервью. */
multiInterviewRouter.get("/sessions/:id/respondents", (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json(
    session.respondents.map((r) => ({
      ...r,
      track: session.tracks.find((t) => t.respondentId === r.id) ?? null,
    }))
  );
});

/** Создаёт респондента и его дорожку интервью (текст или чат) за один вызов. */
multiInterviewRouter.post("/sessions/:id/respondents", (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const { name, roleId, weight, mode } = req.body as { name: string; roleId?: string | null; weight?: number; mode: "text" | "chat" };
  if (!name || !mode) {
    res.status(400).json({ error: "name and mode are required" });
    return;
  }
  const respondent: SessionRespondent = { id: `resp_${nanoid(8)}`, name, roleId: roleId ?? null, weight: weight ?? 1 };
  const track: InterviewTrack = { id: `track_${nanoid(8)}`, respondentId: respondent.id, mode, fragments: [], rawText: "", chat: [], status: "pending" };
  const updated = updateSession(req.params.id, { respondents: [...session.respondents, respondent], tracks: [...session.tracks, track] });
  logAudit(req.params.id, "analyst", "respondent_added", { name, mode });
  res.status(201).json({ respondent, track: updated.tracks.find((t) => t.id === track.id) });
});

multiInterviewRouter.delete("/sessions/:id/respondents/:respondentId", (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const respondents = session.respondents.filter((r) => r.id !== req.params.respondentId);
  const tracks = session.tracks.filter((t) => t.respondentId !== req.params.respondentId);
  const updated = updateSession(req.params.id, { respondents, tracks });
  res.json(updated);
});

function findTrack(session: NonNullable<ReturnType<typeof getSession>>, trackId: string): InterviewTrack | undefined {
  return session.tracks.find((t) => t.id === trackId);
}

/** Дорожка в режиме текста: загрузка готового текста интервью респондента. */
multiInterviewRouter.post("/sessions/:id/tracks/:trackId/ingest-text", (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const track = findTrack(session, req.params.trackId);
  if (!track) {
    res.status(404).json({ error: "track not found" });
    return;
  }
  const { text } = req.body as { text: string };
  if (!text || !text.trim()) {
    res.status(400).json({ error: "text is required" });
    return;
  }
  const fragments = fragmentText(text);
  const tracks = session.tracks.map((t) => (t.id === track.id ? { ...t, fragments, rawText: text, status: "completed" as const } : t));
  const updated = updateSession(req.params.id, { tracks });
  res.json(updated);
});

/** Дорожка в режиме чата: старт — вопрос адаптирован к роли респондента (ФТ-М4.2.2). */
multiInterviewRouter.post("/sessions/:id/tracks/:trackId/interview/start", (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const track = findTrack(session, req.params.trackId);
  if (!track) {
    res.status(404).json({ error: "track not found" });
    return;
  }
  const respondent = session.respondents.find((r) => r.id === track.respondentId);
  const startedTrack = startTrackChat(track, respondent, session.meta.processName);
  const tracks = session.tracks.map((t) => (t.id === track.id ? startedTrack : t));
  const updated = updateSession(req.params.id, { tracks });
  res.json(updated.tracks.find((t) => t.id === track.id));
});

/** Дорожка в режиме чата: очередной ход — извлечение мини-модели дорожки и подбор следующего вопроса (ФТ-М4.2.3: можно прерывать и продолжать). */
multiInterviewRouter.post("/sessions/:id/tracks/:trackId/interview/turn", async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const track = findTrack(session, req.params.trackId);
  if (!track) {
    res.status(404).json({ error: "track not found" });
    return;
  }
  const { text } = req.body as { text: string };
  if (!text || !text.trim()) {
    res.status(400).json({ error: "text is required" });
    return;
  }

  try {
    const updatedTrack = await turnTrackChat(session.id, session.meta, track, text);
    const tracks = session.tracks.map((t) => (t.id === track.id ? updatedTrack : t));
    const updated = updateSession(req.params.id, { tracks });
    res.json(updated.tracks.find((t) => t.id === track.id));
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

multiInterviewRouter.post("/sessions/:id/tracks/:trackId/finish", (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const track = findTrack(session, req.params.trackId);
  if (!track) {
    res.status(404).json({ error: "track not found" });
    return;
  }
  const tracks = session.tracks.map((t) => (t.id === track.id ? { ...t, status: "completed" as const } : t));
  const updated = updateSession(req.params.id, { tracks });
  res.json(updated.tracks.find((t) => t.id === track.id));
});

/** ФТ-М4.1.2: сводит все дорожки с материалом в единую модель, фиксируя расхождения. */
multiInterviewRouter.post("/sessions/:id/tracks/merge", async (req, res) => {
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
  const tracksWithContent = session.tracks.filter((t) => t.fragments.length > 0);
  if (tracksWithContent.length === 0) {
    res.status(400).json({ error: "ни одна дорожка не содержит текста интервью" });
    return;
  }
  try {
    const provider = getLLMProvider();
    const trackInputs = [];
    for (const t of tracksWithContent) {
      const respondent = session.respondents.find((r) => r.id === t.respondentId);
      const model: ProcessLogicModel = await extractModel(t.fragments, provider, {
        processId: session.id,
        processName: session.meta.processName,
        modelType: session.meta.modelType,
        department: session.meta.department,
        owner: session.meta.owner,
        decompositionDepth: session.meta.decompositionDepth,
      });
      trackInputs.push({ trackId: t.id, respondentId: t.respondentId, respondentName: respondent?.name ?? t.respondentId, weight: respondent?.weight ?? 1, model });
    }
    const { model: mergedModel } = mergeTracks(trackInputs, session.meta, session.id);
    mergedModel.gaps = detectGaps(mergedModel);
    const validation = validateModel(mergedModel);
    const bpmn = await generateBpmn(mergedModel);
    const idef0 = generateIdef0(mergedModel);

    updateSession(req.params.id, {
      model: mergedModel,
      validation,
      bpmnXml: bpmn.xml,
      idef0,
      status: "ready",
      diagramsStale: false,
      provider: provider.name,
    });
    logAudit(req.params.id, "analyst", "tracks_merged", { tracks: tracksWithContent.length, discrepancies: mergedModel.discrepancies.length });
    logAgentStep(
      req.params.id,
      `run_${nanoid(10)}`,
      1,
      "merger",
      `Слито дорожек: ${tracksWithContent.length}, расхождений: ${mergedModel.discrepancies.length}`
    );
    const updated = addVersion(req.params.id, `Слияние ${tracksWithContent.length} дорожек интервью`);
    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

/** ФТ-М4.1.4: список расхождений с вариантами и вопросами. */
multiInterviewRouter.get("/sessions/:id/discrepancies", (req, res) => {
  const session = getSession(req.params.id);
  if (!session || !session.model) {
    res.status(404).json({ error: "модель ещё не построена" });
    return;
  }
  res.json(session.model.discrepancies);
});

/** Разрешение расхождения: выбранное значение применяется к элементу модели, если применимо. */
multiInterviewRouter.post("/sessions/:id/discrepancies/:discId/resolve", (req, res) => {
  const session = getSession(req.params.id);
  if (!session || !session.model) {
    res.status(404).json({ error: "модель ещё не построена" });
    return;
  }
  const disc = session.model.discrepancies.find((d) => d.id === req.params.discId);
  if (!disc) {
    res.status(404).json({ error: "discrepancy not found" });
    return;
  }
  const block = editBlockReason(session);
  if (block) {
    res.status(409).json({ error: block });
    return;
  }
  const { resolved_value, respondent_id } = req.body as { resolved_value?: string; respondent_id?: string };
  const chosenValue = resolved_value ?? disc.variants.find((v) => v.respondent_id === respondent_id)?.value ?? disc.variants[0]?.value ?? null;

  let model = session.model;
  if (chosenValue && disc.kind === "executor") {
    const role = model.roles.find((r) => r.name === chosenValue);
    if (role) {
      model = { ...model, nodes: model.nodes.map((n) => (n.id === disc.element_id ? { ...n, role_id: role.id } : n)) };
    }
  } else if (chosenValue && disc.kind === "timing") {
    model = { ...model, nodes: model.nodes.map((n) => (n.id === disc.element_id ? { ...n, duration: chosenValue } : n)) };
  }
  model = {
    ...model,
    discrepancies: model.discrepancies.map((d) => (d.id === disc.id ? { ...d, status: "resolved" as const, resolved_value: chosenValue } : d)),
  };
  const validation = validateModel(model);
  updateSession(req.params.id, { model, validation });
  logAudit(req.params.id, "analyst", "discrepancy_resolved", { discId: disc.id, chosenValue });
  const updated = addVersion(req.params.id, `Разрешено расхождение: ${disc.question.slice(0, 60)}`);
  res.json(updated);
});
