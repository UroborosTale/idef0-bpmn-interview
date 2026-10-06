import { extractModel } from "./extract.js";
import { detectGaps } from "./gaps.js";
import { validateModel } from "./validate.js";
import { getLLMProvider } from "../llm/provider.js";
import { INTERVIEW_OPENING_QUESTION, isInterviewComplete, selectNextQuestion } from "./interviewEngine.js";
import type { ChatMessage, Fragment, ValidationIssue } from "../types/model.js";
import type { InterviewTrack, SessionMeta, SessionRespondent } from "../repo.js";

/**
 * Общая логика чат-интервью одной дорожки (ФТ-М4.1/М4.2), переиспользуемая
 * и обычным маршрутом аналитика (routes/multiInterview.ts), и публичным
 * маршрутом по токену кампании (routes/campaigns.ts) — чтобы не дублировать
 * извлечение/подбор вопроса в двух местах.
 */

export function chatMsg(role: ChatMessage["role"], text: string, gap_id: string | null = null): ChatMessage {
  return { id: `m_${Date.now()}_${Math.round(Math.random() * 1e6)}`, role, text, ts: Date.now(), gap_id };
}

/** Извлечение "мини-модели" одной дорожки без генерации диаграмм — нужно только для gaps/next-question в процессе интервью. */
export async function extractTrackModel(sessionId: string, track: InterviewTrack, meta: SessionMeta) {
  const provider = getLLMProvider();
  const model = await extractModel(track.fragments, provider, {
    processId: sessionId,
    processName: meta.processName,
    modelType: meta.modelType,
    department: meta.department,
    owner: meta.owner,
    decompositionDepth: meta.decompositionDepth,
  });
  model.gaps = detectGaps(model);
  const validation: ValidationIssue[] = validateModel(model);
  return { model, validation };
}

/** ФТ-М4.2.2: открывающий вопрос, адаптированный к роли респондента. */
export function openingQuestionFor(processName: string, respondent: SessionRespondent | undefined): string {
  return respondent?.roleId
    ? `Начнём. Расскажите, пожалуйста, о своей части процесса «${processName}» — что вы делаете в роли «${respondent.roleId}», что получаете на входе и что передаёте дальше?`
    : INTERVIEW_OPENING_QUESTION;
}

export function startTrackChat(track: InterviewTrack, respondent: SessionRespondent | undefined, processName: string): InterviewTrack {
  if (track.chat.length > 0) return track;
  const chat = [chatMsg("assistant", openingQuestionFor(processName, respondent))];
  return { ...track, chat, status: "in_progress" };
}

/** ФТ-М4.2.3: можно прерывать и продолжать — каждый ход просто дописывает fragments/chat дорожки. */
export async function turnTrackChat(sessionId: string, meta: SessionMeta, track: InterviewTrack, text: string): Promise<InterviewTrack> {
  const lastAssistant = [...track.chat].reverse().find((m) => m.role === "assistant");
  const offset = track.fragments.length;
  const newFragment: Fragment = { id: `f${offset + 1}`, index: offset + 1, speaker: "owner", text };
  const fragments = [...track.fragments, newFragment];
  const chatAfterOwner: ChatMessage[] = [...track.chat, chatMsg("owner", text, lastAssistant?.gap_id ?? null)];

  const { model, validation } = await extractTrackModel(sessionId, { ...track, fragments }, meta);
  const complete = isInterviewComplete(model, validation);
  let chat = chatAfterOwner;
  const status: InterviewTrack["status"] = "in_progress";
  if (complete) {
    chat = [...chat, chatMsg("assistant", "Спасибо! Кажется, вашей части процесса собрано достаточно. Можете продолжить уточнения или завершить.")];
  } else {
    const nextGap = selectNextQuestion(model, chat);
    chat = [...chat, chatMsg("assistant", nextGap ? nextGap.question : "Уточните, пожалуйста, детали последнего шага, либо завершите интервью.", nextGap?.id ?? null)];
  }
  return { ...track, fragments, chat, status };
}
