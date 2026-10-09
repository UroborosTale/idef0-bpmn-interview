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

/** Рамка подписи под фигурой: по ней стрелки обходят текст. Подпись по умолчанию стоит по центру оси фигуры. */
export function labelBox(b: Box, text: string): Box | null {
  const lines = wrapText(text, LABEL_CHARS, LABEL_LINES);
  if (lines.length === 0) return null;
  const w = Math.max(...lines.map((l) => l.length)) * LABEL_CHAR_W + 4;
  return { x: b.x + b.w / 2 - w / 2, y: b.y + b.h + 3, w, h: lines.length * LABEL_LINE_H };
}

