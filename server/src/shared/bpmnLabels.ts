import type { Box } from "./bpmnGeometry.js";

/** Подписи событий и шлюзов: перенос текста и рамка под фигурой — общие для маршрутизатора и редактора. */
/** Перенос текста по словам: не больше maxLines строк по maxChars знаков, лишнее обрезается многоточием. */
export function wrapText(text: string, maxChars: number, maxLines: number): string[] {
  const lines: string[] = [];
  let cur = "";
  for (let word of text.split(/\s+/).filter(Boolean)) {
    while (word.length > maxChars) {
      if (cur) {
        lines.push(cur);
        cur = "";
      }
      lines.push(word.slice(0, maxChars));
      word = word.slice(maxChars);
    }
    if (!cur) cur = word;
    else if ((cur + " " + word).length <= maxChars) cur += " " + word;
    else {
      lines.push(cur);
      cur = word;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const cut = lines.slice(0, maxLines);
    cut[maxLines - 1] = cut[maxLines - 1].replace(/.{0,1}$/, "…");
    return cut;
  }
  return lines;
}

/** Подпись события и шлюза стоит под фигурой (редактор рисует её так же): до 3 строк по 20 знаков. */
export const LABEL_CHARS = 20;
export const LABEL_LINES = 3;
const LABEL_CHAR_W = 5.8; // средняя ширина знака при кегле 11
const LABEL_LINE_H = 13;
const LABEL_GAP = 3; // просвет между фигурой и подписью
const LANE_LABEL_MARGIN = 2; // подпись не должна касаться линии дорожки

/** Сторона подписи фигуры: под фигурой, а если до линии дорожки места нет — над ней. */
export type LabelSide = "below" | "above";

/**
 * Где рисовать подпись события или шлюза. Подпись всегда стоит под фигурой, но у фигуры, стоящей внизу дорожки,
 * она упиралась в линию дорожки (замечание с осмотра): тогда подпись уходит наверх — если и там есть место.
 * Правило одно на редактор, Visio и SVG-выгрузки, поэтому подпись везде стоит одинаково.
 */
export function labelSide(b: Box, text: string, band?: { top: number; bottom: number } | null): LabelSide {
  const rows = wrapText(text, LABEL_CHARS, LABEL_LINES).length;
  if (rows === 0 || !band) return "below";
  const h = rows * LABEL_LINE_H;
  if (b.y + b.h + LABEL_GAP + h <= band.bottom - LANE_LABEL_MARGIN) return "below";
  return b.y - LABEL_GAP - h >= band.top + LANE_LABEL_MARGIN ? "above" : "below";
}

/** Рамка подписи фигуры: по ней стрелки обходят текст. Подпись по умолчанию стоит по центру оси фигуры. */
export function labelBox(b: Box, text: string, side: LabelSide = "below"): Box | null {
  const lines = wrapText(text, LABEL_CHARS, LABEL_LINES);
  if (lines.length === 0) return null;
  const w = Math.max(...lines.map((l) => l.length)) * LABEL_CHAR_W + 4;
  const h = lines.length * LABEL_LINE_H;
  return { x: b.x + b.w / 2 - w / 2, y: side === "above" ? b.y - LABEL_GAP - h : b.y + b.h + LABEL_GAP, w, h };
}

