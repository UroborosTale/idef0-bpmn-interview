import { Router } from "express";
import { getSession, updateSession, editBlockReason } from "../repo.js";
import { fragmentText } from "../pipeline/fragment.js";
import { runPipeline } from "../pipeline/run.js";
import { INTERVIEW_OPENING_QUESTION, isInterviewComplete, mergeManualGaps, selectNextQuestion } from "../pipeline/interviewEngine.js";
import { logAudit } from "../db.js";
import { addVersion } from "../repo.js";
import type { ChatMessage, Fragment } from "../types/model.js";

export const interviewRouter = Router();

function chatMsg(role: ChatMessage["role"], text: string, gap_id: string | null = null): ChatMessage {
  return { id: `m_${Date.now()}_${Math.round(Math.random() * 1e6)}`, role, text, ts: Date.now(), gap_id };
}

interviewRouter.post("/sessions/:id/interview/start", (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: "not found" });
    return;
  }
  if (session.chat.length > 0) {
    res.json(session);
    return;
  }
  const chat = [chatMsg("assistant", INTERVIEW_OPENING_QUESTION)];
  const updated = updateSession(req.params.id, { chat, status: "interviewing" });
  logAudit(req.params.id, "system", "interview_started");
  res.json(updated);
});

interviewRouter.post("/sessions/:id/interview/turn", async (req, res) => {
  const { text } = req.body as { text: string };
  const session = getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: "not found" });
    return;
  }
  if (!text || !text.trim()) {
    res.status(400).json({ error: "text is required" });
    return;
  }
  const block = editBlockReason(session);
  if (block) {
    res.status(409).json({ error: block });
    return;
  }

  const lastAssistant = [...session.chat].reverse().find((m) => m.role === "assistant");
  const offset = session.fragments.length;
  const newFragment: Fragment = { id: `f${offset + 1}`, index: offset + 1, speaker: "owner", text };
  const fragments = [...session.fragments, newFragment];
  const chatAfterOwner = [...session.chat, chatMsg("owner", text, lastAssistant?.gap_id ?? null)];

  updateSession(req.params.id, { fragments, chat: chatAfterOwner });

  try {
    const output = await runPipeline(session.id, fragments, session.meta);
    output.model.gaps = mergeManualGaps(session.model?.gaps ?? [], output.model.gaps);

    const complete = isInterviewComplete(output.model, output.validation);
    let chat = chatAfterOwner;
    let status: typeof session.status = "interviewing";

    if (complete) {
      chat = [...chat, chatMsg("assistant", "Спасибо! Похоже, основная информация о процессе собрана, критичных пробелов не осталось. Вы можете продолжить уточнения или завершить интервью — я подготовлю протокол и черновик моделей.")];
    } else {
      const nextGap = selectNextQuestion(output.model, chat);
      if (nextGap) {
        chat = [...chat, chatMsg("assistant", nextGap.question, nextGap.id)];
      } else {
        chat = [...chat, chatMsg("assistant", "Пока не удаётся сформулировать следующий вопрос — уточните, пожалуйста, детали последнего шага, либо завершите интервью.")];
        status = "interviewing";
      }
    }

    updateSession(req.params.id, {
      model: output.model,
      validation: output.validation,
      bpmnXml: output.bpmnXml,
      idef0: output.idef0,
      chat,
      status,
      diagramsStale: false,
      provider: output.providerName,
    });
    const updated = addVersion(req.params.id, "Ход интервью");
    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

/** Владелец отмечает элемент превью как неверный (ФТ-2.5). */
interviewRouter.post("/sessions/:id/interview/flag-element", (req, res) => {
  const { element_id, note } = req.body as { element_id: string; note?: string };
  const session = getSession(req.params.id);
  if (!session || !session.model) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const node = session.model.nodes.find((n) => n.id === element_id);
  const elementName = node?.name ?? element_id;
  const question = note
    ? `Вы отметили «${elementName}» как неверное: «${note}». Как должно быть на самом деле?`
    : `Вы отметили «${elementName}» как неверное. Как должно быть на самом деле?`;

  const gap = {
    id: `gap_flag_${Date.now()}`,
    rule: "owner_flagged",
    priority: "critical" as const,
    element_id,
    question,
    status: "open" as const,
    topic: `flag_${element_id}`,
    asked_count: 0,
  };
  const model = { ...session.model, gaps: [gap, ...session.model.gaps] };
  const chat = [...session.chat, chatMsg("assistant", question, gap.id)];
  const updated = updateSession(req.params.id, { model, chat });
  logAudit(req.params.id, "owner", "element_flagged", { element_id, note });
  res.json(updated);
});

interviewRouter.post("/sessions/:id/interview/finish", (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const chat = [...session.chat, chatMsg("assistant", "Интервью завершено. Спасибо! Протокол и черновик моделей доступны аналитику.")];
  const updated = updateSession(req.params.id, { chat, status: "completed" });
  logAudit(req.params.id, "owner", "interview_finished");
  res.json(updated);
});
