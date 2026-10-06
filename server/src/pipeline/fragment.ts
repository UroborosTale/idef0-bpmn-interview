import type { Fragment, Speaker } from "../types/model.js";

const INTERVIEWER_LABELS = /^(вопрос|аналитик|интервьюер|ведущий|модератор|q)\s*[:\-–]/iu;
const OWNER_LABELS = /^(владелец( процесса)?|ответ|owner|a)\s*[:\-–]/iu;
const PARTICIPANT_LABEL = /^([а-яёa-z][а-яёa-z .]{1,40})\s*[:\-–]/iu;

/**
 * Разбивает сырой текст интервью на фрагменты (реплика/абзац) с ID
 * и эвристически определяет спикера (ФТ-1.1, ФТ-1.2).
 */
export function fragmentText(raw: string): Fragment[] {
  const normalized = raw.replace(/\r\n/g, "\n").trim();
  const rawParas = normalized
    .split(/\n{1,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const fragments: Fragment[] = [];
  let idx = 0;

  for (const para of rawParas) {
    idx += 1;
    const id = `f${idx}`;
    let speaker: Speaker = "unknown";
    let label: string | undefined;
    let text = para;

    if (INTERVIEWER_LABELS.test(para)) {
      speaker = "interviewer";
      const m = para.match(INTERVIEWER_LABELS);
      label = m?.[0].replace(/[:\-–]$/, "").trim();
      text = para.slice(m![0].length).trim();
    } else if (OWNER_LABELS.test(para)) {
      speaker = "owner";
      const m = para.match(OWNER_LABELS);
      label = m?.[0].replace(/[:\-–]$/, "").trim();
      text = para.slice(m![0].length).trim();
    } else if (PARTICIPANT_LABEL.test(para) && para.length < 400) {
      const m = para.match(PARTICIPANT_LABEL)!;
      label = m[1].trim();
      text = para.slice(m[0].length).trim();
      speaker = /вопрос|\?$/iu.test(label) ? "interviewer" : "participant";
    } else if (para.endsWith("?") && para.length < 200) {
      speaker = "interviewer";
    } else {
      // сплошной рассказ владельца без разметки спикеров
      speaker = "owner";
    }

    if (!text) continue;
    fragments.push({ id, index: idx, speaker, speaker_label: label, text });
  }

  return fragments;
}

/** Нормализация терминов по словарю организации (ФТ-1.3). */
export function normalizeTerms(fragments: Fragment[], dictionary: Record<string, string>): Fragment[] {
  if (!dictionary || Object.keys(dictionary).length === 0) return fragments;
  const entries = Object.entries(dictionary).sort((a, b) => b[0].length - a[0].length);
  return fragments.map((f) => {
    let text = f.text;
    for (const [from, to] of entries) {
      const re = new RegExp(`\\b${from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "giu");
      text = text.replace(re, to);
    }
    return { ...f, text };
  });
}

const FIO_PATTERN = /\b([А-ЯЁ][а-яё]+)\s([А-ЯЁ])\.\s?([А-ЯЁ])\.\b/gu;
const FULL_FIO_PATTERN = /\b([А-ЯЁ][а-яё]+)\s([А-ЯЁ][а-яё]+)\s([А-ЯЁ][а-яё]+(ич|вна|инична))\b/gu;

/** Обезличивание ФИО перед отправкой во внешнюю LLM (ФТ-1.4). */
export function anonymizeFragments(fragments: Fragment[]): Fragment[] {
  let counter = 0;
  const seen = new Map<string, string>();
  function replace(match: string): string {
    if (!seen.has(match)) {
      counter += 1;
      seen.set(match, `Сотрудник №${counter}`);
    }
    return seen.get(match)!;
  }
  return fragments.map((f) => ({
    ...f,
    text: f.text.replace(FULL_FIO_PATTERN, replace).replace(FIO_PATTERN, replace),
  }));
}
