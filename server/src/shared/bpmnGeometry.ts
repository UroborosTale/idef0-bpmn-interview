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

// Размеры фигур по соглашениям OMG BPMN DI (bpmn.io/Camunda Modeler): 100×80 задачи, 50×50 шлюзы, 36×36 события.
export const SIZE: Record<string, { w: number; h: number }> = {
  task: { w: 100, h: 80 },
  subprocess: { w: 110, h: 80 },
  gateway: { w: 50, h: 50 },
  event: { w: 36, h: 36 },
};

export const LANE_H = 150;
export const START_Y = 60;
/** Левый край дорожек; полоса подписи дорожки — LABEL_W, фигуры начинаются правее (MIN_X). */
export const LANE_X = 80;
export const LABEL_W = 30;
export const MIN_X = LANE_X + LABEL_W + 20;

export const sizeOf = (n: { type: string }) => SIZE[n.type] ?? SIZE.task;

/** Что известно о концах стрелки, кроме рамок: от этого зависит, с какой стороны фигуры стрелка выходит и входит. */
export interface EndKinds {
  /** Тип фигуры-источника и цели: у шлюзов ветки уходят из верхней и нижней вершины, к шлюзу стрелки сверху и снизу входят в вершину. */
  fromType?: string;
  toType?: string;
  /** Источник — граничное событие на нижней границе задачи: стрелка уходит вниз. */
  fromBoundary?: boolean;
}

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