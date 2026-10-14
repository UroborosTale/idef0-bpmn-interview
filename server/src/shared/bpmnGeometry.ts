/**
 * Геометрия диаграммы BPMN — общая для генератора (server/src/pipeline/bpmn.ts, layout.ts) и редактора
 * в браузере (web подключает этот файл через псевдоним @shared): размеры фигур, дорожки и маршрутизация стрелок.
 */

export type Pt = [number, number];

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Размеры фигур: задача 150×90 и подпроцесс 160×90 — как на диаграммах Business Studio (длинные названия умещаются в 4 строки),
// шлюзы 50×50 и события 36×36 — по соглашениям OMG BPMN DI.
export const SIZE: Record<string, { w: number; h: number }> = {
  task: { w: 150, h: 90 },
  subprocess: { w: 160, h: 90 },
  gateway: { w: 50, h: 50 },
  event: { w: 36, h: 36 },
};

export const LANE_H = 150;
export const START_Y = 60;
/** Высота дорожки настраивается: не меньше MIN_LANE_H (под фигуру 80 и значки данных над и под ней ещё нужно место) и не больше MAX_LANE_H. */
export const MIN_LANE_H = 120;
export const MAX_LANE_H = 600;
/** Допустимая высота дорожки: кратна 10, в пределах MIN_LANE_H…MAX_LANE_H. */
export const clampLaneHeight = (h: number): number => Math.min(MAX_LANE_H, Math.max(MIN_LANE_H, Math.round(h / 10) * 10));
/** Высота дорожки по настройке; нет настройки или она не число — стандартная LANE_H. */
export const laneHeightOf = (h: number | null | undefined): number => (typeof h === "number" && Number.isFinite(h) ? clampLaneHeight(h) : LANE_H);
/** Ширина дорожек диаграммы (правый край) настраивается: не меньше MIN_DIAGRAM_W (и не меньше, чем нужно фигурам) и не больше MAX_DIAGRAM_W. */
export const MIN_DIAGRAM_W = 600;
export const MAX_DIAGRAM_W = 20000;
/** Допустимая ширина дорожек: кратна 10, в пределах MIN_DIAGRAM_W…MAX_DIAGRAM_W. */
export const clampDiagramWidth = (w: number): number => Math.min(MAX_DIAGRAM_W, Math.max(MIN_DIAGRAM_W, Math.round(w / 10) * 10));
/** Верхняя граница каждой дорожки по высотам дорожек сверху вниз. */
export function laneTops(heights: number[]): number[] {
  let y = START_Y;
  return heights.map((h) => {
    const top = y;
    y += h;
    return top;
  });
}
/** Левый край дорожек; полоса подписи дорожки — LABEL_W, фигуры начинаются правее (MIN_X). */
export const LANE_X = 80;
export const LABEL_W = 37;
export const MIN_X = LANE_X + LABEL_W + 23; // = 140: на сетке 10

export const sizeOf = (n: { type: string }) => SIZE[n.type] ?? SIZE.task;

/** Что известно о концах стрелки, кроме рамок: от этого зависит, с какой стороны фигуры стрелка выходит и входит. */
export interface EndKinds {
  /** Тип фигуры-источника и цели: у шлюзов ветки уходят из верхней и нижней вершины, к шлюзу стрелки сверху и снизу входят в вершину. */
  fromType?: string;
  toType?: string;
  /** Источник — граничное событие на нижней границе задачи: стрелка уходит вниз. */
  fromBoundary?: boolean;
}

export { wrapText, labelBox, LABEL_CHARS, LABEL_LINES } from "./bpmnLabels.js";

// Прокладка стрелок — bpmnRouting.ts (по всей диаграмме сразу; waypoints — маршрут одной стрелки).
export { waypoints, routeFlows } from "./bpmnRouting.js";
export type { RouteFlow, RouteNode } from "./bpmnRouting.js";

/**
 * Где подписать стрелку (условие ветки): у начала маршрута, чтобы подпись читалась рядом с шлюзом, а не посреди длинной линии.
 * Горизонтальный первый отрезок — подпись над ним. Вертикальный: если за ним идёт горизонтальный (ветка шлюза вверх или вниз
 * к цели), подпись стоит над горизонтальным отрезком сразу за поворотом — у разных веток из одной вершины это разные места, и подписи
 * не накладываются; иначе — справа от вертикального.
 */
export function flowLabelPoint(points: Pt[]): { x: number; y: number; anchor: "middle" | "start" } {
  const [a, b] = [points[0], points[1] ?? points[0]];
  const horizontal = Math.abs(a[1] - b[1]) < 0.5;
  if (horizontal) {
    const len = Math.abs(b[0] - a[0]);
    const dir = b[0] >= a[0] ? 1 : -1;
    return { x: a[0] + dir * Math.min(len / 2, 34), y: a[1] - 6, anchor: "middle" };
  }
  const c = points[2];
  if (c && Math.abs(b[1] - c[1]) < 0.5) {
    const len2 = Math.abs(c[0] - b[0]);
    const dir2 = c[0] >= b[0] ? 1 : -1;
    return { x: b[0] + dir2 * Math.min(len2 / 2, 34), y: b[1] - 6, anchor: "middle" };
  }
  const len = Math.abs(b[1] - a[1]);
  const dir = b[1] >= a[1] ? 1 : -1;
  return { x: a[0] + 6, y: a[1] + dir * Math.min(len / 2, 22) + (dir > 0 ? 0 : -2), anchor: "start" };
}
