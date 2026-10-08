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

const PORT_GAP = 20; // минимальный зазор между фигурами, чтобы идти «вправо»
const DETOUR = 24; // отступ линии обхода от фигур

/**
 * Ортогональная маршрутизация стрелки между двумя фигурами (соглашения BPMN, как в bpmn.io/Camunda Modeler).
 * Стрелка всегда выходит и входит в середину стороны фигуры (у ромба и круга это вершина):
 *  - на одной линии — прямая; если на пути другие фигуры — обход поверху (вверх из источника, вниз в цель);
 *  - вправо и на другой уровень — излом посередине; от шлюза ветка уходит из верхней/нижней вершины и входит в цель
 *    слева, к шлюзу стрелка идёт горизонтально и входит в его верхнюю/нижнюю вершину;
 *  - друг над другом — вертикальная линия;
 *  - назад (цель левее) — петля под фигурами или над ними, вход в цель снизу/сверху (у событий и шлюзов — только поверху).
 */
export function waypoints(from: Box, to: Box, obstacles: Box[] = [], kinds: EndKinds = {}): Pt[] {
  const fcx = from.x + from.w / 2;
  const fcy = from.y + from.h / 2;
  const tcx = to.x + to.w / 2;
  const tcy = to.y + to.h / 2;
  const R: Pt = [from.x + from.w, fcy];
  const L: Pt = [to.x, tcy];
  const fromTop: Pt = [fcx, from.y];
  const fromBottom: Pt = [fcx, from.y + from.h];
  const toTop: Pt = [tcx, to.y];
  const toBottom: Pt = [tcx, to.y + to.h];
  const forward = to.x >= from.x + from.w + PORT_GAP;
  const fromGateway = kinds.fromType === "gateway";
  const toGateway = kinds.toType === "gateway";
  const between = (o: Box, a: number, b: number) => o.x + o.w > Math.min(a, b) && o.x < Math.max(a, b);

  // граничное событие: линия уходит вниз от нижней границы задачи
  if (kinds.fromBoundary) {
    if (tcy > from.y + from.h + 8 && to.x + to.w > fcx) {
      return forward || tcx > fcx ? [fromBottom, [fcx, tcy], L] : [fromBottom, [fcx, tcy], [to.x + to.w, tcy]];
    }
    const y = Math.max(from.y + from.h, to.y + to.h) + DETOUR;
    return [fromBottom, [fcx, y], [tcx, y], toBottom];
  }

  if (forward) {
    if (Math.abs(fcy - tcy) < 0.5) {
      // прямая не должна идти сквозь фигуры между источником и целью — обходим сверху
      const blockers = obstacles.filter((o) => between(o, R[0], L[0]) && o.y - 4 < fcy && o.y + o.h + 4 > fcy);
      if (blockers.length === 0) return [R, L];
      const upY = Math.min(from.y, to.y, ...blockers.map((o) => o.y)) - DETOUR;
      return [fromTop, [fcx, upY], [tcx, upY], toTop];
    }
    const down = tcy > fcy;
    // ветка шлюза: из вершины вертикально до уровня цели, дальше горизонтально в цель слева
    if (fromGateway && L[0] - fcx > 24) return [down ? fromBottom : fromTop, [fcx, tcy], L];
    // стрелка к шлюзу: горизонтально до его оси, затем в верхнюю или нижнюю вершину
    if (toGateway && tcx - R[0] > 24) return [R, [tcx, fcy], down ? toTop : toBottom];
    const midX = R[0] + (L[0] - R[0]) / 2;
    return [R, [midX, fcy], [midX, tcy], L];
  }

  // цель не правее источника: друг над другом или петля назад
  const overlapX = to.x < from.x + from.w && to.x + to.w > from.x;
  if (overlapX) {
    if (Math.abs(fcx - tcx) < 0.5) return tcy >= fcy ? [fromBottom, toTop] : [fromTop, toBottom];
    const midY = tcy >= fcy ? (from.y + from.h + to.y) / 2 : (to.y + to.h + from.y) / 2;
    return tcy >= fcy ? [fromBottom, [fcx, midY], [tcx, midY], toTop] : [fromTop, [fcx, midY], [tcx, midY], toBottom];
  }
  // у событий и шлюзов подпись стоит под фигурой — петля под ними пересекла бы её, поэтому такие петли идут поверху
  const labelled = (t?: string) => t === "gateway" || t === "event";
  if (tcy >= fcy && !labelled(kinds.fromType) && !labelled(kinds.toType)) {
    // петля под фигурами: ниже всего, что лежит между источником и целью
    const inSpan = obstacles.filter((o) => between(o, fcx, tcx));
    const y = Math.max(from.y + from.h, to.y + to.h, ...inSpan.map((o) => o.y + o.h)) + DETOUR;
    return [fromBottom, [fcx, y], [tcx, y], toBottom];
  }
  const inSpan = obstacles.filter((o) => between(o, fcx, tcx));
  const y = Math.min(from.y, to.y, ...inSpan.map((o) => o.y)) - DETOUR;
  return [fromTop, [fcx, y], [tcx, y], toTop];
}

/**
 * Где подписать стрелку (условие ветки): у начала маршрута, чтобы подпись читалась рядом с шлюзом, а не посреди длинной линии.
 * Горизонтальный первый отрезок — подпись над ним; вертикальный — справа от него.
 */
export function flowLabelPoint(points: Pt[]): { x: number; y: number; anchor: "middle" | "start" } {
  const [a, b] = [points[0], points[1] ?? points[0]];
  const horizontal = Math.abs(a[1] - b[1]) < 0.5;
  if (horizontal) {
    const len = Math.abs(b[0] - a[0]);
    const dir = b[0] >= a[0] ? 1 : -1;
    return { x: a[0] + dir * Math.min(len / 2, 34), y: a[1] - 6, anchor: "middle" };
  }
  const len = Math.abs(b[1] - a[1]);
  const dir = b[1] >= a[1] ? 1 : -1;
  return { x: a[0] + 6, y: a[1] + dir * Math.min(len / 2, 22) + (dir > 0 ? 0 : -2), anchor: "start" };
}