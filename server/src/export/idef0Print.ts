import { generateIdef0 } from "../pipeline/idef0.js";
import type { ProcessLogicModel } from "../types/model.js";
import { frameKey, sheetFormatOf } from "../shared/idef0Frame.js";

/** Бумага в миллиметрах (портретная ориентация: ширина × высота). */
export const PAPER_MM: Record<string, [number, number]> = { A4: [210, 297], A3: [297, 420], A2: [420, 594] };
export type Orientation = "landscape" | "portrait";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Диаграмма IDEF0 по адресу выгрузки: context, decomposition (верхняя), код функции (A2, C025.01.00…). Свежая раскладка из модели. */
export function idef0Svg(model: ProcessLogicModel, diagram: string): { svg: string; frameKey: string } | null {
  const r = generateIdef0(model);
  if (diagram === "context") return { svg: r.contextSvg, frameKey: "ctx" };
  if (diagram === "decomposition") return { svg: r.decompositionSvg, frameKey: frameKey(null) };
  const child = r.children.find((c) => c.code === diagram);
  return child ? { svg: child.svg, frameKey: frameKey(child.parentNodeId) } : null;
}

/** Размер SVG в пикселях по его атрибутам width и height. */
const sizeOf = (svg: string): { w: number; h: number } => ({
  w: Number(/<svg[^>]*\swidth="([\d.]+)"/.exec(svg)?.[1] ?? 0) || 1,
  h: Number(/<svg[^>]*\sheight="([\d.]+)"/.exec(svg)?.[1] ?? 0) || 1,
});

export interface PrintOptions {
  /** A4, A3 или A2; без значения — по формату листа диаграммы (если он стандартный), иначе A4. */
  paper?: string;
  /** Без значения — по пропорциям листа. */
  orientation?: Orientation;
}

/** Выбранная бумага и ориентация для листа диаграммы. */
export function printSetup(model: ProcessLogicModel, key: string, svg: string, opts: PrintOptions): { paper: string; orientation: Orientation } {
  const frame = model.idef0_frames?.[key];
  const std = frame?.w !== undefined && frame?.h !== undefined ? sheetFormatOf(frame.w, frame.h) : null;
  const paper = opts.paper && PAPER_MM[opts.paper] ? opts.paper : std?.id ?? "A4";
  const { w, h } = sizeOf(svg);
  const orientation: Orientation = opts.orientation ?? (std ? (std.portrait ? "portrait" : "landscape") : w >= h ? "landscape" : "portrait");
  return { paper, orientation };
}

/**
 * Страница для печати одного листа: бумага нужного формата, лист по центру с сохранением пропорций (масштаб подбирается сам).
 * Из браузера — «Печать» (Ctrl+P → «Сохранить как PDF»); тот же HTML отдаёт и PDF-выгрузка.
 */
export function idef0PrintHtml(model: ProcessLogicModel, diagram: string, opts: PrintOptions = {}): { html: string; paper: string; orientation: Orientation } | null {
  const found = idef0Svg(model, diagram);
  if (!found) return null;
  const { paper, orientation } = printSetup(model, found.frameKey, found.svg, opts);
  const [pw, ph] = PAPER_MM[paper];
  const [w, h] = orientation === "landscape" ? [ph, pw] : [pw, ph];
  // собственный размер SVG убираем: лист растягивается на страницу, пропорции держит preserveAspectRatio
  const fitted = found.svg.replace(/<svg([^>]*?)\swidth="[\d.]+"\s+height="[\d.]+"/, '<svg$1 width="100%" height="100%" preserveAspectRatio="xMidYMid meet"');
  const html = `<!DOCTYPE html>
<html lang="ru"><head><meta charset="utf-8"><title>${esc(model.process.name)} — ${esc(diagram)} (${paper})</title>
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
  return { html, paper, orientation };
}
