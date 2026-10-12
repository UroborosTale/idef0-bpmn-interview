import type { ArrowRoute, ProcessLogicModel } from "../../types";
import { ARROW_DIRS, FREE_END, MIN_FREE, PORT_SIDE, arrowRouteKey } from "@shared/idef0Layout";
import { insertJog, interiorOf, moveCorner, moveSegment, nearestSegment, orthogonalPath, positionOnSide, type Pt } from "@shared/bpmnManual";
import type { Arrow, Box } from "./geometry";

type M = ProcessLogicModel;

/**
 * Свободная правка стрелок IDEF0. Работает над ломаной, которая нарисована сейчас (автоматической или ручной): первая же правка делает
 * маршрут ручным — внутренние точки запоминаются как нарисованы. Маршрут лежит у функции, к которой привязана стрелка
 * (node.arrow_routes[«вид:сущность»]); рисует его общая раскладка (@shared/idef0Layout), поэтому SVG, VSDX и редактор совпадают.
 * Все функции чистые: перетаскивание можно пересчитывать от исходной ломаной на каждом шаге.
 */

/** Минимальная длина отрезка, на котором показывается ручка сдвига. */
export const MIN_HANDLE_LEN = 28;
/** Шаг сетки при перетаскивании свободного конца и излома. */
export const ARROW_GRID = 10;

type RouteArrow = Pick<Arrow, "kind" | "nodeId" | "entityId">;
type GeoArrow = RouteArrow & Pick<Arrow, "points">;

export const routeOf = (m: M, a: RouteArrow): ArrowRoute | undefined => m.nodes.find((n) => n.id === a.nodeId)?.arrow_routes?.[arrowRouteKey(a.kind, a.entityId)];

const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const finPt = (p: unknown): p is [number, number] => Array.isArray(p) && p.length === 2 && fin(p[0]) && fin(p[1]);
const half = (v: number) => Math.round(v * 2) / 2;
const frac = (v: number) => Math.min(1, Math.max(0, Math.round(v * 1000) / 1000));

/** Маршрут в чистом виде: числа округлены и ограничены, нечисловое отброшено. null — ничего не задано. */
function tidyRoute(r: ArrowRoute): ArrowRoute | null {
  const out: ArrowRoute = {};
  if (fin(r.pos)) out.pos = frac(r.pos);
  if (fin(r.from_pos)) out.from_pos = frac(r.from_pos);
  // пустой список точек — осмысленное значение: «без изломов, линия проложена кратчайшим ортогональным путём»
  if (Array.isArray(r.points) && r.points.every(finPt)) out.points = r.points.slice(0, 32).map(([x, y]) => [half(x), half(y)] as Pt);
  if (finPt(r.end)) out.end = [half(r.end[0]), half(r.end[1])];
  if (finPt(r.label) && (Math.abs(r.label[0]) >= 0.5 || Math.abs(r.label[1]) >= 0.5)) out.label = [half(r.label[0]), half(r.label[1])];
  return Object.keys(out).length ? out : null;
}

/**
 * Записать маршрут стрелки. Поля патча перекрывают прежние; undefined снимает поле; null снимает весь маршрут.
 * Пустой маршрут не хранится: ключ и пустой arrow_routes убираются.
 */
export function setArrowRoute(m: M, a: RouteArrow, patch: { [K in keyof ArrowRoute]?: ArrowRoute[K] | undefined } | null): M {
  const key = arrowRouteKey(a.kind, a.entityId);
  return {
    ...m,
    nodes: m.nodes.map((n) => {
      if (n.id !== a.nodeId) return n;
      const { [key]: prev, ...rest } = n.arrow_routes ?? {};
      const next = patch === null ? null : tidyRoute({ ...prev, ...patch });
      const routes = next ? { ...rest, [key]: next } : rest;
      const { arrow_routes: _drop, ...node } = n;
      return Object.keys(routes).length ? { ...node, arrow_routes: routes } : node;
    }),
  };
}

/** Убрать маршрут стрелки (вернуть автоматическую прокладку). */
export const resetArrow = (m: M, a: RouteArrow): M => setArrowRoute(m, a, null);

/** Стрелка вручную подправлена (есть что сбрасывать). */
export const hasManualRoute = (m: M, a: RouteArrow): boolean => !!routeOf(m, a);

// --- отрезки и изломы ---

/** Отрезок i сдвинут поперёк себя на d (горизонтальный — по y, вертикальный — по x). */
export const dragSegment = (m: M, a: GeoArrow, i: number, d: number): M => setArrowRoute(m, a, { points: interiorOf(moveSegment(a.points, i, d)) });

/** Излом i (внутренняя вершина) перенесён в точку to; два отрезка при нём сдвигаются вместе с ним. */
export const dragCorner = (m: M, a: GeoArrow, i: number, to: Pt): M => setArrowRoute(m, a, { points: interiorOf(moveCorner(a.points, i, to)) });

/** Ступенька на отрезке, ближайшем к точке at (или на самом длинном, если точка не задана). Слишком короткий отрезок не меняется. */
export function addBend(m: M, a: GeoArrow, at?: Pt): M {
  let index = -1;
  let t = 0.5;
  if (at) {
    const near = nearestSegment(a.points, at);
    if (near) ({ index, t } = near);
  } else {
    let best = 0;
    a.points.slice(1).forEach((p, i) => {
      const l = Math.abs(p[0] - a.points[i][0]) + Math.abs(p[1] - a.points[i][1]);
      if (l > best) (best = l, (index = i));
    });
  }
  if (index < 0) return m;
  const poly = insertJog(a.points, index, t);
  return poly === a.points ? m : setArrowRoute(m, a, { points: interiorOf(poly) });
}

/**
 * Убрать излом i. Одна убранная точка часто ничего не упрощает (колено достраивается заново), поэтому из окон в 1–4 соседние точки
 * выбирается то, после которого у линии меньше всего изломов: ступенька убирается целиком, одиночный излом — сам.
 */
export function removeBend(m: M, a: GeoArrow, i: number): M {
  if (i < 1 || i >= a.points.length - 1) return m;
  const { from, to } = ARROW_DIRS[a.kind];
  const pts = interiorOf(a.points);
  const [p, q] = [a.points[0], a.points[a.points.length - 1]];
  const at = i - 1;
  let best: { rest: Pt[]; corners: number } | null = null;
  for (let size = 1; size <= 4; size++) {
    for (let start = at - size + 1; start <= at; start++) {
      if (start < 0 || start + size > pts.length) continue;
      const rest = [...pts.slice(0, start), ...pts.slice(start + size)];
      const corners = orthogonalPath(p, from, rest, q, to).length - 2;
      if (!best || corners < best.corners) best = { rest, corners };
    }
  }
  // точки, оказавшиеся посреди прямого отрезка, — не изломы: их хранить незачем
  const path = orthogonalPath(p, from, best!.rest, q, to);
  const kept = best!.rest.filter((pt) => path.some((v) => Math.abs(v[0] - pt[0]) < 0.5 && Math.abs(v[1] - pt[1]) < 0.5));
  return setArrowRoute(m, a, { points: kept });
}

// --- концы и подпись ---

/** Положение точки вдоль стороны блока, где лежит конец стрелки: 0,1…0,9 с шагом 0,05. */
export const fractionAlong = (box: Box, a: Pick<Arrow, "kind">, at: Pt, producer = false): number => positionOnSide(box, producer ? "R" : PORT_SIDE[a.kind], at);

/** Сдвинуть конец у блока вдоль его стороны (producer — конец у блока-источника связи). Остальной маршрут сохраняется. */
export const slideEnd = (m: M, a: RouteArrow, frac01: number, producer = false): M => setArrowRoute(m, a, producer ? { from_pos: frac01 } : { pos: frac01 });

/**
 * Свободный конец внешней стрелки в точке pt: по сетке и не ближе MIN_FREE к блоку по направлению стрелки
 * (вход — левее блока, управление — выше, выход — правее, механизм — ниже).
 */
export function clampFreeEnd(box: Box, kind: Arrow["kind"], pt: Pt): Pt {
  const g = (v: number) => Math.round(v / ARROW_GRID) * ARROW_GRID;
  const [x, y] = [g(pt[0]), g(pt[1])];
  switch (PORT_SIDE[kind]) {
    case "L":
      return [Math.min(x, box.x - MIN_FREE), y];
    case "R":
      return [Math.max(x, box.x + box.w + MIN_FREE), y];
    case "T":
      return [x, Math.min(y, box.y - MIN_FREE)];
    default:
      return [x, Math.max(y, box.y + box.h + MIN_FREE)];
  }
}

/** У стрелки есть свободный конец (внешний вход, управление, механизм или выход). */
export const hasFreeEnd = (a: Pick<Arrow, "kind">): boolean => FREE_END[a.kind] !== undefined;
/** Свободный конец — начало ломаной (вход, управление, механизм) или её конец (выход). */
export const freeEndIndex = (a: GeoArrow): number => (FREE_END[a.kind] === "end" ? a.points.length - 1 : 0);

export const setFreeEnd = (m: M, a: RouteArrow, pt: Pt): M => setArrowRoute(m, a, { end: pt });

/** Подпись сдвинута на (dx, dy) от обычного места. */
export const setLabelOffset = (m: M, a: RouteArrow, dx: number, dy: number): M => setArrowRoute(m, a, { label: [dx, dy] });
