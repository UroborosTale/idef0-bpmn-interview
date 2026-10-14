import { sheetFormatOf } from "./idef0Frame.js";

/** Бумага в миллиметрах (портретная ориентация: ширина × высота). */
export const PAPER_MM: Record<string, [number, number]> = { A4: [210, 297], A3: [297, 420], A2: [420, 594] };
export type Orientation = "landscape" | "portrait";

export interface PrintOptions {
  /** A4, A3 или A2; без значения — по формату листа диаграммы (если он стандартный), иначе A4. */
  paper?: string;
  /** Без значения — по пропорциям листа. */
  orientation?: Orientation;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Размер SVG в пикселях по его атрибутам width и height. */
export const svgSize = (svg: string): { w: number; h: number } => ({
  w: Number(/<svg[^>]*\swidth="([\d.]+)"/.exec(svg)?.[1] ?? 0) || 1,
  h: Number(/<svg[^>]*\sheight="([\d.]+)"/.exec(svg)?.[1] ?? 0) || 1,
});

/** Бумага и ориентация: явный выбор, иначе формат листа, заданного вручную (если стандартный), иначе A4 по пропорциям рисунка. */
export function sheetPrintSetup(frame: { w?: number; h?: number } | undefined, size: { w: number; h: number }, opts: PrintOptions): { paper: string; orientation: Orientation } {
  const std = frame?.w !== undefined && frame?.h !== undefined ? sheetFormatOf(frame.w, frame.h) : null;
  const paper = opts.paper && PAPER_MM[opts.paper] ? opts.paper : std?.id ?? "A4";
  const orientation: Orientation = opts.orientation ?? (std ? (std.portrait ? "portrait" : "landscape") : size.w >= size.h ? "landscape" : "portrait");
  return { paper, orientation };
}

/**
 * Страница для печати одного листа: бумага нужного формата, лист по центру с сохранением пропорций (масштаб подбирается сам).
 * Из браузера — «Печать» (Ctrl+P → «Сохранить как PDF»); тот же HTML отдаёт и PDF-выгрузка.
 */
export function sheetPrintHtml(svg: string, title: string, paper: string, orientation: Orientation): string {
  const [pw, ph] = PAPER_MM[paper];
  const [w, h] = orientation === "landscape" ? [ph, pw] : [pw, ph];
  // собственный размер SVG убираем: лист растягивается на страницу, пропорции держит preserveAspectRatio
  const fitted = svg.replace(/<svg([^>]*?)\swidth="[\d.]+"\s+height="[\d.]+"/, '<svg$1 width="100%" height="100%" preserveAspectRatio="xMidYMid meet"');
  return `<!DOCTYPE html>
<html lang="ru"><head><meta charset="utf-8"><title>${esc(title)} (${paper})</title>
<style>
  @page { size: ${paper} ${orientation}; margin: 0; }
  html, body { margin: 0; padding: 0; background: #fff; }
  .sheet { width: ${w}mm; height: ${h}mm; box-sizing: border-box; padding: 6mm; overflow: hidden; }
  .sheet svg { display: block; width: 100%; height: 100%; }
  .toolbar { position: fixed; top: 8px; right: 8px; font: 13px Arial, sans-serif; background: #fffbe6; border: 1px solid #e6c200; border-radius: 6px; padding: 6px 10px; }
  @media print { .toolbar { display: none; } }
</style></head>
<body>
<div class="toolbar">Лист ${paper}, ${orientation === "landscape" ? "альбомная" : "книжная"} ориентация. <button onclick="window.print()">Печать / PDF</button></div>
<div class="sheet">${fitted}</div>
</body></html>`;
}

/**
 * SVG, присланный со страницы редактора, перед печатью на сервере: только разметка рисунка —
 * без сценариев, обработчиков событий, вставок HTML и внешних ссылок. Не SVG — null.
 */
export function cleanSheetSvg(svg: string): string | null {
  const s = svg.trim().replace(/^<\?xml[^>]*\?>\s*/, "");
  if (!/^<svg[\s>]/.test(s) || !/<\/svg>\s*$/.test(s)) return null;
  return s
    .replace(/<(script|foreignObject|iframe|object|embed|style)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<(script|foreignObject|iframe|object|embed|style|image|use)\b[^>]*\/?>/gi, "")
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s(?:xlink:)?href\s*=\s*("(?!#)[^"]*"|'(?!#)[^']*')/gi, "");
}
