import type { Fragment, Speaker } from "../types/model.js";

const INTERVIEWER_LABELS = /^(вопрос|аналитик|интервьюер|ведущий|модератор|q)\s*[:\-–]/iu;
const OWNER_LABELS = /^(владелец( процесса)?|ответ|owner|a)\s*[:\-–]/iu;
const PARTICIPANT_LABEL = /^([а-яёa-z][а-яёa-z .\-]{1,40}?)(:|—|–|\s-\s)\s*/iu;
/** Подписи полей документа («Наименование процесса:», «Цель:») — не спикеры. */
const DOC_FIELD_LABEL = /(наименование|цель|инициатор|владелец|участник|триггер|результат|предуслови|сценари|этап|процесс)/iu;

const HEADING = /^\s*#{1,6}\s+/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;
const HORIZONTAL_RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;

/** Markdown-разметка строки → обычный текст: заголовки, списки, выделение, ссылки. */
function stripMarkdown(line: string): string {
  return line
    .replace(/^>\s?/, "")
    .replace(/^#{1,6}\s+/, "")
    .replace(LIST_ITEM, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s.,;:)!?]|$)/g, "$1$2")
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s.,;:)!?]|$)/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Абзацы текста: пустая строка разделяет абзацы, одиночные переносы внутри абзаца склеиваются.
 * Заголовки Markdown — структура документа, а не реплика; пункты списков остаются отдельными репликами.
 */
function textParagraphs(raw: string): string[] {
  const paragraphs: string[] = [];
  let current = "";
  const flush = () => {
    const p = current.replace(/\s+/g, " ").trim();
    if (p) paragraphs.push(p);
    current = "";
  };
  for (const rawLine of raw.replace(/\r\n/g, "\n").split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      flush();
      continue;
    }
    if (HEADING.test(line) || HORIZONTAL_RULE.test(line)) {
      flush();
      continue;
    }
    const item = LIST_ITEM.test(line);
    const cleaned = stripMarkdown(line);
    if (!cleaned) continue;
    if (item) flush();
    // «Участники процесса:» — подпись к списку, самостоятельной репликой не считается
    if (cleaned.endsWith(":") && cleaned.split(/\s+/).length <= 8) {
      flush();
      continue;
    }
    const startsSpeaker = INTERVIEWER_LABELS.test(cleaned) || OWNER_LABELS.test(cleaned) || PARTICIPANT_LABEL.test(cleaned);
    if (!current) {
      current = cleaned;
      continue;
    }
    if (startsSpeaker || (/[.!?…]$/.test(current) && /^[A-ZА-ЯЁ«"„\d]/u.test(cleaned))) {
      flush();
      current = cleaned;
      continue;
    }
    current += ` ${cleaned}`;
  }
  flush();
  return paragraphs;
}

/**
 * Разбивает сырой текст интервью на фрагменты (реплика/абзац) с ID
 * и эвристически определяет спикера (ФТ-1.1, ФТ-1.2).
 */
export function fragmentText(raw: string): Fragment[] {
  const fragments: Fragment[] = [];
  let idx = 0;

  for (const para of textParagraphs(raw)) {
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
      const candidate = m[1].trim();
      const colon = m[2] === ":";
      // «Наименование процесса:», «Цель:» — поля документа, а не спикер
      if (!(colon && (DOC_FIELD_LABEL.test(candidate) || candidate.split(/\s+/).length > 3))) {
        label = candidate;
        text = para.slice(m[0].length).trim();
        speaker = /вопрос|\?$/iu.test(label) ? "interviewer" : "participant";
      }
    }
    if (speaker === "unknown" && para.endsWith("?") && para.length < 200) speaker = "interviewer";
    // сплошной рассказ владельца без разметки спикеров
    if (speaker === "unknown") speaker = "owner";

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
