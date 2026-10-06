import type { ChatMessage, Gap, ProcessLogicModel, ValidationIssue } from "../types/model.js";
import { sortGapsByPriority } from "./gaps.js";
import { hasBlockingErrors } from "./validate.js";

const MAX_CONSECUTIVE_PER_TOPIC = 3;

export const INTERVIEW_OPENING_QUESTION =
  "Начнём. Расскажите, пожалуйста: какова цель этого процесса, что его запускает (триггер) и что является результатом (результатом можно считать документ, событие или решение)?";

/**
 * Ограничители режима Б (ФТ-2.7): не более N вопросов подряд по одной теме,
 * повторные вопросы запрещены. Выбирает следующий вопрос по приоритету
 * пробелов (ФТ-2.2), сначала отдавая приоритет элементам, отмеченным
 * владельцем как неверные (ФТ-2.5).
 */
export function selectNextQuestion(model: ProcessLogicModel, chat: ChatMessage[]): Gap | null {
  const askedTexts = new Set(chat.filter((m) => m.role === "assistant").map((m) => m.text));
  const assistantWithGap = chat.filter((m) => m.role === "assistant" && m.gap_id);

  let consecTopic: string | null = null;
  let consecCount = 0;
  for (let i = assistantWithGap.length - 1; i >= 0; i--) {
    const m = assistantWithGap[i];
    const g = model.gaps.find((x) => x.id === m.gap_id);
    const topic = g?.topic ?? m.gap_id ?? "unknown";
    if (consecTopic === null) {
      consecTopic = topic;
      consecCount = 1;
    } else if (topic === consecTopic) {
      consecCount++;
    } else {
      break;
    }
  }
  const blockedTopic = consecCount >= MAX_CONSECUTIVE_PER_TOPIC ? consecTopic : null;

  const candidates = model.gaps.filter(
    (g) => g.status === "open" && !askedTexts.has(g.question) && g.topic !== blockedTopic
  );

  const flagged = candidates.find((g) => g.rule === "owner_flagged");
  if (flagged) return flagged;

  const sorted = sortGapsByPriority(candidates);
  return sorted[0] ?? null;
}

export function isInterviewComplete(model: ProcessLogicModel, validation: ValidationIssue[]): boolean {
  const hasBlockingGaps = model.gaps.some((g) => g.status === "open" && (g.priority === "critical" || g.priority === "important"));
  return !hasBlockingGaps && !hasBlockingErrors(validation);
}

/**
 * Переносит вручную заданные пробелы (владелец отметил элемент как неверный,
 * ФТ-2.5) через пересборку модели: детерминированный движок правил (ФТ-4) их
 * не порождает, поэтому их нужно явно сохранить между запусками конвейера.
 */
export function mergeManualGaps(previousGaps: Gap[], freshGaps: Gap[]): Gap[] {
  const manual = previousGaps.filter((g) => g.rule === "owner_flagged" && g.status === "open");
  const freshIds = new Set(freshGaps.map((g) => g.id));
  const carried = manual.filter((g) => !freshIds.has(g.id));
  return [...freshGaps, ...carried];
}
