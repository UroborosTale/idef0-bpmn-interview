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

/**
 * Ортогональные точки перегиба стрелки между двумя фигурами (визуальное соглашение BPMN):
 * прямая на одном уровне (с обходом сверху фигур на пути), обход для обратных потоков,
 * иначе — излом посередине.
 */
export function waypoints(from: Box, to: Box, obstacles: Box[] = []): Pt[] {
  const sx = from.x + from.w;
  const sy = from.y + from.h / 2;
  const tx = to.x;
  const ty = to.y + to.h / 2;
  if (Math.abs(sy - ty) < 2) {
    // прямая стрелка не должна проходить сквозь фигуры между источником и целью — обходим сверху
    const blockers = obstacles.filter((o) => o.x + o.w > sx && o.x < tx && o.y - 4 < sy && o.y + o.h + 4 > sy);
    if (blockers.length === 0) return [[sx, sy], [tx, ty]];
    const upY = Math.min(from.y, to.y, ...blockers.map((o) => o.y)) - 20;
    return [[sx, sy], [sx + 12, sy], [sx + 12, upY], [tx - 12, upY], [tx - 12, ty], [tx, ty]];
  }
  // цель левее источника (обратный поток) — заводим линию вокруг фигур сверху или снизу, а не сквозь них
  if (tx < sx + 24) {
    const midY = sy < ty ? Math.min(from.y, to.y) - 24 : Math.max(from.y + from.h, to.y + to.h) + 24;
    return [[sx, sy], [sx + 20, sy], [sx + 20, midY], [tx - 20, midY], [tx - 20, ty], [tx, ty]];
  }
  const midX = sx + (tx - sx) / 2;
  return [[sx, sy], [midX, sy], [midX, ty], [tx, ty]];
}
