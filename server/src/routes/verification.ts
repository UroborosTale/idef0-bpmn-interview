import { Router } from "express";
import { getSession, updateSession, addVersion, editBlockReason } from "../repo.js";
import { buildParaphrase } from "../pipeline/verification.js";
import { extractModel } from "../pipeline/extract.js";
import { detectGaps } from "../pipeline/gaps.js";
import { validateModel } from "../pipeline/validate.js";
import { getLLMProvider } from "../llm/provider.js";
import { fragmentText } from "../pipeline/fragment.js";
import { diffModels } from "../pipeline/diff.js";
import { logAudit } from "../db.js";
import { ProcessLogicModel, type Fragment } from "../types/model.js";

export const verificationRouter = Router();

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

/** ФТ-М4.4.1: пересказ процесса обычным языком + статус подтверждения абзацев. */
verificationRouter.get("/sessions/:id/verification/preview", (req, res) => {
  const session = requireReady(req, res);
  if (!session) return;
  const paragraphs = buildParaphrase(session.model!);
  res.json({
    paragraphs,
    confirmed: session.verificationConfirmed,
  });
});

/** ФТ-М4.4.2: владелец подтверждает абзац как верный. */
verificationRouter.post("/sessions/:id/verification/paragraphs/:paragraphId/confirm", (req, res) => {
  const session = requireReady(req, res);
  if (!session) return;
  const confirmed = [...new Set([...session.verificationConfirmed, req.params.paragraphId])];
  updateSession(req.params.id, { verificationConfirmed: confirmed });
  logAudit(req.params.id, "owner", "verification_paragraph_confirmed", { paragraphId: req.params.paragraphId });
  res.json({ confirmed });
});

verificationRouter.post("/sessions/:id/verification/paragraphs/:paragraphId/unconfirm", (req, res) => {
  const session = requireReady(req, res);
  if (!session) return;
  const confirmed = session.verificationConfirmed.filter((id) => id !== req.params.paragraphId);
  updateSession(req.params.id, { verificationConfirmed: confirmed });
  res.json({ confirmed });
});

/**
 * ФТ-М4.4.3: правка абзаца превращается в изменение PLM через Ядро, но
 * СНАЧАЛА показывается аналитику как diff — ничего не применяется этим
 * вызовом. Правку добавляем как новый фрагмент интервью (как если бы
 * владелец сказал это на интервью) и заново прогоняем извлечение по всем
 * фрагментам; получившаяся модель возвращается вместе с diff к текущей —
 * применить её можно существующим PUT /sessions/:id/model (там уже есть
 * версионирование и пересчёт валидации).
 */
verificationRouter.post("/sessions/:id/verification/propose-edit", async (req, res) => {
  const session = requireReady(req, res);
  if (!session) return;
  const { text } = req.body as { text: string };
  if (!text || !text.trim()) {
    res.status(400).json({ error: "text is required" });
    return;
  }

  const offset = session.fragments.length;
  const newFragments: Fragment[] = fragmentText(text).map((f, i) => ({ ...f, id: `f${offset + i + 1}`, index: offset + i + 1, speaker: "owner" as const }));
  const allFragments = [...session.fragments, ...newFragments];

  try {
    const provider = getLLMProvider();
    const proposedModel = await extractModel(allFragments, provider, {
      processId: session.id,
      processName: session.meta.processName,
      modelType: session.meta.modelType,
      department: session.meta.department,
      owner: session.meta.owner,
      decompositionDepth: session.meta.decompositionDepth,
    });
    // сохраняем расширения PLM v2, которых нет в свежем извлечении (RACI, KPI, респонденты и т.п.)
    proposedModel.process = { ...session.model!.process, goal: proposedModel.process.goal, trigger: proposedModel.process.trigger, result: proposedModel.process.result };
    proposedModel.raci = session.model!.raci;
    proposedModel.discrepancies = session.model!.discrepancies;
    proposedModel.respondents = session.model!.respondents;

    const diff = diffModels(session.model!, proposedModel);
    res.json({ diff, proposedModel, proposedFragments: allFragments, proposedRawText: `${session.rawText}\n\n--- Правка через верификацию текстом ---\n\n${text}` });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

/**
 * Применяет правку, ранее показанную аналитику через propose-edit: сохраняет
 * И модель, И фрагменты вместе (иначе трассировка "показать в тексте" будет
 * ссылаться на несуществующие фрагменты) — поэтому не переиспользуем общий
 * PUT /sessions/:id/model, который фрагменты не трогает.
 */
verificationRouter.post("/sessions/:id/verification/apply-edit", (req, res) => {
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
  const { proposedModel, proposedFragments, proposedRawText } = req.body as { proposedModel: unknown; proposedFragments: Fragment[]; proposedRawText: string };
  const parsed = ProcessLogicModel.safeParse(proposedModel);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid model", details: parsed.error.flatten() });
    return;
  }
  const model = parsed.data;
  model.gaps = detectGaps(model);
  const validation = validateModel(model);
  updateSession(req.params.id, { model, validation, fragments: proposedFragments, rawText: proposedRawText ?? session.rawText, diagramsStale: true });
  logAudit(req.params.id, "analyst", "verification_edit_applied");
  const updated = addVersion(req.params.id, "Правка через верификацию текстом");
  res.json(updated);
});
