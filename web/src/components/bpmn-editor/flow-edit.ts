import type { ProcessLogicModel } from "../../types";
import { insertJog, interiorOf, moveCorner, moveSegment, nearestSegment, orthogonalPath, type Pt } from "@shared/bpmnManual";
import { setFlowRoute, type FlowSide } from "./model-ops";

type M = ProcessLogicModel;

/**
 * Свободная правка маршрута стрелки. Работает над ломаной, которая нарисована сейчас (автоматической или ручной): первая же правка
 * делает маршрут ручным — стороны фиксируются такими, какие есть, а внутренние точки запоминаются как нарисованы. Все функции чистые
 * (ломаная и стороны берутся из прокладки), поэтому перетаскивание можно пересчитывать от исходной ломаной на каждом шаге.
 */
export interface FlowGeometry {
  /** Ломаная от порта выхода до порта входа. */
  poly: Pt[];
  /** Какими сторонами стрелка выходит и входит сейчас. */
  from: FlowSide;
  to: FlowSide;
}

/** Минимальная длина отрезка, на котором показывается ручка сдвига и на котором можно добавить излом. */
export const MIN_HANDLE_LEN = 28;

const withPoly = (m: M, id: string, g: FlowGeometry, poly: Pt[]): M => setFlowRoute(m, id, { from_side: g.from, to_side: g.to, channel: undefined, points: interiorOf(poly) });

/** Отрезок i сдвинут поперёк себя на d (горизонтальный — по y, вертикальный — по x). */
export const dragSegment = (m: M, id: string, g: FlowGeometry, i: number, d: number): M => withPoly(m, id, g, moveSegment(g.poly, i, d));

/** Излом i (внутренняя вершина) перенесён в точку to; два отрезка при нём сдвигаются вместе с ним. */
export const dragCorner = (m: M, id: string, g: FlowGeometry, i: number, to: Pt): M => withPoly(m, id, g, moveCorner(g.poly, i, to));

/**
 * Добавить излом: на отрезке, ближайшем к точке at (или на самом длинном, если точка не задана), появляется ступенька из двух
 * изломов. Слишком короткий отрезок не меняется.
 */
export function addBend(m: M, id: string, g: FlowGeometry, at?: Pt): M {
  let index = -1;
  let t = 0.5;
  if (at) {
    const near = nearestSegment(g.poly, at);
    if (near) ({ index, t } = near);
  } else {
    let best = 0;
    g.poly.slice(1).forEach((p, i) => {
      const l = Math.abs(p[0] - g.poly[i][0]) + Math.abs(p[1] - g.poly[i][1]);
      if (l > best) (best = l, (index = i));
    });
  }
  if (index < 0) return m;
  const poly = insertJog(g.poly, index, t);
  return poly === g.poly ? m : withPoly(m, id, g, poly);
}

/**
 * Убрать излом i. Одна убранная точка часто ничего не упрощает: колено достраивается заново (у ступеньки — тем более). Поэтому
 * из окон в 1–4 соседние точки, содержащих излом, выбирается то, после которого у линии меньше всего изломов (при равенстве —
 * меньшее окно): ступенька убирается целиком, а одиночный излом — сам.
 */
export function removeBend(m: M, id: string, g: FlowGeometry, i: number): M {
  if (i < 1 || i >= g.poly.length - 1) return m;
  const pts = interiorOf(g.poly);
  const [p, q] = [g.poly[0], g.poly[g.poly.length - 1]];
  const at = i - 1;
  let best: { rest: Pt[]; corners: number; size: number } | null = null;
  for (let size = 1; size <= 4; size++) {
    for (let start = at - size + 1; start <= at; start++) {
      if (start < 0 || start + size > pts.length) continue;
      const rest = [...pts.slice(0, start), ...pts.slice(start + size)];
      const corners = orthogonalPath(p, g.from, rest, q, g.to).length - 2;
      if (!best || corners < best.corners) best = { rest, corners, size };
    }
  }
  // точки, оказавшиеся посреди прямого отрезка, — не изломы: их хранить незачем
  const path = orthogonalPath(p, g.from, best!.rest, q, g.to);
  const kept = best!.rest.filter((pt) => path.some((v) => Math.abs(v[0] - pt[0]) < 0.5 && Math.abs(v[1] - pt[1]) < 0.5));
  return setFlowRoute(m, id, { from_side: g.from, to_side: g.to, channel: undefined, points: kept });
}
