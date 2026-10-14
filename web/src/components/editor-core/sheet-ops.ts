import type { FrameField, IdefFrame } from "@shared/idef0Frame";
import type { ProcessLogicModel } from "../../types";

/** Где в модели лежат настройки листов: у диаграмм IDEF0 и у диаграмм BPMN (ключ — id функции или операции, "" — верхняя диаграмма). */
export type SheetFrames = "idef0_frames" | "bpmn_frames";

export interface FramePatch {
  show?: boolean;
  grid?: boolean;
  /** null — вернуть автоматический лист (по содержимому диаграммы). */
  rect?: { x: number; y: number; w: number; h: number } | null;
  /** Надпись штампа; пустая — вернуть автоматическую. */
  text?: { field: FrameField; value: string };
}

/**
 * Настройки рамки листа диаграммы: показать или скрыть рамку и сетку, задать положение и размер, переопределить надпись штампа.
 * Значения по умолчанию не хранятся; без изменений возвращается та же модель (шаг истории не создаётся).
 */
export function setSheetFrame(m: ProcessLogicModel, field: SheetFrames, key: string, patch: FramePatch): ProcessLogicModel {
  const cur: IdefFrame = m[field]?.[key] ?? {};
  const next: IdefFrame = { ...cur };
  if (patch.show !== undefined) next.show = patch.show;
  if (patch.grid !== undefined) next.grid = patch.grid;
  if (patch.rect !== undefined) {
    for (const k of ["x", "y", "w", "h"] as const) {
      if (patch.rect === null) delete next[k];
      else next[k] = Math.round(patch.rect[k]);
    }
  }
  if (patch.text) {
    const texts = { ...(cur.texts ?? {}) };
    if (patch.text.value.trim()) texts[patch.text.field] = patch.text.value.trim();
    else delete texts[patch.text.field];
    next.texts = Object.keys(texts).length ? texts : undefined;
  }
  // значение по умолчанию не храним: у IDEF0 рамка показана, у BPMN — скрыта
  if (next.show === (field === "idef0_frames")) delete next.show;
  if (next.grid === true) delete next.grid;
  if (!next.texts) delete next.texts;
  const frames = { ...(m[field] ?? {}) };
  if (Object.keys(next).length) frames[key] = next;
  else delete frames[key];
  if (JSON.stringify(frames[key]) === JSON.stringify(m[field]?.[key])) return m;
  return { ...m, [field]: Object.keys(frames).length ? frames : undefined };
}
