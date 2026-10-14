import { generateIdef0 } from "../pipeline/idef0.js";
import type { ProcessLogicModel } from "../types/model.js";
import { frameKey } from "../shared/idef0Frame.js";
import { sheetPrintHtml, sheetPrintSetup, svgSize, type Orientation, type PrintOptions } from "../shared/sheetPrint.js";

export { PAPER_MM, type Orientation, type PrintOptions } from "../shared/sheetPrint.js";

/** Диаграмма IDEF0 по адресу выгрузки: context, decomposition (верхняя), код функции (A2, C025.01.00…). Свежая раскладка из модели. */
export function idef0Svg(model: ProcessLogicModel, diagram: string): { svg: string; frameKey: string } | null {
  const r = generateIdef0(model);
  if (diagram === "context") return { svg: r.contextSvg, frameKey: "ctx" };
  if (diagram === "decomposition") return { svg: r.decompositionSvg, frameKey: frameKey(null) };
  const child = r.children.find((c) => c.code === diagram);
  return child ? { svg: child.svg, frameKey: frameKey(child.parentNodeId) } : null;
}

/** Выбранная бумага и ориентация для листа диаграммы. */
export function printSetup(model: ProcessLogicModel, key: string, svg: string, opts: PrintOptions): { paper: string; orientation: Orientation } {
  return sheetPrintSetup(model.idef0_frames?.[key], svgSize(svg), opts);
}

/** Страница для печати листа IDEF0 (см. sheetPrintHtml). */
export function idef0PrintHtml(model: ProcessLogicModel, diagram: string, opts: PrintOptions = {}): { html: string; paper: string; orientation: Orientation } | null {
  const found = idef0Svg(model, diagram);
  if (!found) return null;
  const { paper, orientation } = printSetup(model, found.frameKey, found.svg, opts);
  return { html: sheetPrintHtml(found.svg, `${model.process.name} — ${diagram}`, paper, orientation), paper, orientation };
}
