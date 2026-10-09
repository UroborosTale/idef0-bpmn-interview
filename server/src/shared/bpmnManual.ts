/**
 * Ручной маршрут стрелки: свободные точки излома. Модуль общий для прокладки стрелок (shared/bpmnRouting.ts, экспорт BPMN) и
 * редактора в браузере: чистые функции над ломаной, без знания о фигурах и модели.
 *
 * Ломаная ортогональная: соседние точки лежат на одной горизонтали или вертикали. Пользователь хранит только внутренние точки
 * (порты концов выводятся из сторон и положения на стороне), поэтому при переносе фигур точки остаются на местах, а недостающие
 * колена достраивает orthogonalPath.
 */

export type Pt = [number, number];
export type Side = "L" | "R" | "T" | "B";

const OUT: Record<Side, Pt> = { R: [1, 0], L: [-1, 0], T: [0, -1], B: [0, 1] };
const EPS = 0.5;
/** Длина прямого отрезка у порта, прежде чем линия повернёт: стрелка выходит из фигуры под прямым углом. */
export const STUB = 20;
/** Размер ступеньки, которую даёт «добавить излом». */
export const JOG = 20;

const same = (a: Pt, b: Pt) => Math.abs(a[0] - b[0]) < EPS && Math.abs(a[1] - b[1]) < EPS;
const horizontal = (a: Pt, b: Pt) => Math.abs(a[1] - b[1]) < EPS;
const vertical = (a: Pt, b: Pt) => Math.abs(a[0] - b[0]) < EPS;
const len = (a: Pt, b: Pt) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);

/** Убирает совпадающие соседние точки и точки посреди прямого отрезка. Первая и последняя точки остаются. */
export function tidy(pts: Pt[]): Pt[] {
  const dedup = pts.filter((p, i) => i === 0 || !same(p, pts[i - 1]));
  return dedup.filter((p, i) => {
    if (i === 0 || i === dedup.length - 1) return true;
    const [a, b] = [dedup[i - 1], dedup[i + 1]];
    return !((vertical(a, p) && vertical(p, b)) || (horizontal(a, p) && horizontal(p, b)));
  });
}

/**
 * Ортогональная ломаная от порта p (сторона e) через точки pts к порту q (сторона n). Между точками, не лежащими на одной
 * линии, достраивается колено; у портов линия сначала идёт прямо от фигуры (отрезок STUB), чтобы стрелка не скользила вдоль
 * её стороны.
 */
export function orthogonalPath(p: Pt, e: Side, pts: Pt[], q: Pt, n: Side): Pt[] {
  const stubP: Pt = [p[0] + OUT[e][0] * STUB, p[1] + OUT[e][1] * STUB];
  const stubQ: Pt = [q[0] + OUT[n][0] * STUB, q[1] + OUT[n][1] * STUB];
  const via: Pt[] = [stubP, ...pts, stubQ, q];
  const out: Pt[] = [p];
  for (const cur of via) {
    const prev = out[out.length - 1];
    if (same(prev, cur)) continue;
    if (!horizontal(prev, cur) && !vertical(prev, cur)) {
      // колено: направление чередуется с предыдущим отрезком; первое колено от порта идёт вдоль нормали стороны
      const before = out.length > 1 ? out[out.length - 2] : null;
      const lastWasHorizontal = before ? horizontal(before, prev) : OUT[e][0] !== 0;
      out.push(lastWasHorizontal ? [prev[0], cur[1]] : [cur[0], prev[1]]);
    }
    out.push(cur);
  }
  return tidy(out);
}

/** Индекс ближайшей к точке вершины внутри ломаной (кроме концов); -1, если внутренних вершин нет. */
const innerNear = (poly: Pt[], v: Pt): number => {
  let best = -1;
  for (let i = 1; i < poly.length - 1; i++) if (best < 0 || len(poly[i], v) < len(poly[best], v)) best = i;
  return best;
};

/**
 * Сдвиг отрезка i (между вершинами i и i+1) поперёк самого себя на d. Соседние отрезки перпендикулярны ему, поэтому они просто
 * удлиняются или укорачиваются. Если отрезок упирается в порт, порт не двигается: у порта делается короткий прямой участок, а
 * сдвиг идёт после него. Вырожденный (нулевой) отрезок не двигается.
 */
export function moveSegment(poly: Pt[], i: number, d: number): Pt[] {
  if (i < 0 || i + 1 >= poly.length || Math.abs(d) < 1e-9) return poly;
  const [a, b] = [poly[i], poly[i + 1]];
  const isH = horizontal(a, b);
  if (!isH && !vertical(a, b)) return poly;
  const length = len(a, b);
  if (length < EPS) return poly;
  const along: Pt = isH ? [Math.sign(b[0] - a[0]), 0] : [0, Math.sign(b[1] - a[1])];
  const shift = (p: Pt): Pt => (isH ? [p[0], p[1] + d] : [p[0] + d, p[1]]);
  const stub = Math.min(STUB, length / 2);
  const out: Pt[] = poly.slice(0, i);
  if (i === 0) {
    const a2: Pt = [a[0] + along[0] * stub, a[1] + along[1] * stub];
    out.push(a, a2, shift(a2));
  } else out.push(shift(a));
  if (i + 1 === poly.length - 1) {
    const b2: Pt = [b[0] - along[0] * stub, b[1] - along[1] * stub];
    out.push(shift(b2), b2, b);
  } else out.push(shift(b));
  out.push(...poly.slice(i + 2));
  return tidy(out);
}

/**
 * Перенос излома: вершина i (внутренняя) переходит в точку to, а два отрезка при ней сдвигаются вместе с ней (горизонтальный —
 * по y, вертикальный — по x), остальные изломы сохраняются.
 */
export function moveCorner(poly: Pt[], i: number, to: Pt): Pt[] {
  if (i < 1 || i + 1 >= poly.length) return poly;
  const v = poly[i];
  const [dx, dy] = [to[0] - v[0], to[1] - v[1]];
  // отрезок при вершине, идущий горизонтально, сдвигается по y; вертикальный — по x
  const segs = [i - 1, i];
  const hSeg = segs.find((s) => horizontal(poly[s], poly[s + 1]) && !same(poly[s], poly[s + 1]));
  const vSeg = segs.find((s) => vertical(poly[s], poly[s + 1]) && !same(poly[s], poly[s + 1]));
  let out = poly;
  let corner: Pt = v;
  if (hSeg !== undefined) {
    out = moveSegment(out, hSeg, dy);
    corner = [corner[0], corner[1] + dy];
  }
  if (vSeg !== undefined) {
    // после первого сдвига в ломаную могли добавиться точки: вертикальный отрезок ищем заново у перенесённой вершины
    const at = hSeg !== undefined ? innerNear(out, corner) : innerNear(out, v);
    const target = [at - 1, at].find((s) => s >= 0 && s + 1 < out.length && vertical(out[s], out[s + 1]) && !same(out[s], out[s + 1]));
    if (target !== undefined) out = moveSegment(out, target, dx);
  }
  return out;
}

/**
 * Ступенька на отрезке i в доле t от его начала: линия смещается на JOG в сторону и возвращается, получаются два новых излома,
 * которые затем двигают. Слишком короткий отрезок (меньше 3·JOG) не меняется.
 */
export function insertJog(poly: Pt[], i: number, t = 0.5): Pt[] {
  if (i < 0 || i + 1 >= poly.length) return poly;
  const [a, b] = [poly[i], poly[i + 1]];
  const isH = horizontal(a, b);
  if ((!isH && !vertical(a, b)) || len(a, b) < 3 * JOG) return poly;
  const k = Math.min(Math.max(t, 0.2), 0.8);
  const along: Pt = isH ? [Math.sign(b[0] - a[0]), 0] : [0, Math.sign(b[1] - a[1])];
  const perp: Pt = isH ? [0, 1] : [1, 0];
  const m: Pt = [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
  const m1: Pt = [m[0] - along[0] * JOG / 2, m[1] - along[1] * JOG / 2];
  const m2: Pt = [m[0] + along[0] * JOG / 2, m[1] + along[1] * JOG / 2];
  const off = (p: Pt): Pt => [p[0] + perp[0] * JOG, p[1] + perp[1] * JOG];
  return tidy([...poly.slice(0, i + 1), m1, off(m1), off(m2), m2, ...poly.slice(i + 1)]);
}

/** Внутренние точки ломаной (без портов) — то, что хранится в маршруте стрелки. */
export const interiorOf = (poly: Pt[]): Pt[] => poly.slice(1, -1).map(([x, y]) => [x, y] as Pt);

/** Ближайший к точке отрезок ломаной: индекс и расстояние. */
export function nearestSegment(poly: Pt[], at: Pt): { index: number; dist: number; t: number } | null {
  let best: { index: number; dist: number; t: number } | null = null;
  for (let i = 0; i + 1 < poly.length; i++) {
    const [a, b] = [poly[i], poly[i + 1]];
    const l2 = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2;
    if (l2 < 1e-9) continue;
    const t = Math.min(1, Math.max(0, ((at[0] - a[0]) * (b[0] - a[0]) + (at[1] - a[1]) * (b[1] - a[1])) / l2));
    const dist = Math.hypot(at[0] - (a[0] + (b[0] - a[0]) * t), at[1] - (a[1] + (b[1] - a[1]) * t));
    if (!best || dist < best.dist) best = { index: i, dist, t };
  }
  return best;
}

/** Положение точки вдоль стороны фигуры: 0…1 слева направо (у верха и низа) или сверху вниз (у левой и правой). */
export function positionOnSide(box: { x: number; y: number; w: number; h: number }, side: Side, at: Pt): number {
  const f = side === "L" || side === "R" ? (at[1] - box.y) / box.h : (at[0] - box.x) / box.w;
  return Math.min(0.9, Math.max(0.1, Math.round(f * 20) / 20));
}
