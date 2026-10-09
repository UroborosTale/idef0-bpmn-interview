import type { Pt } from "@shared/bpmnManual";

/**
 * Направляющие выравнивания: ровные линии по горизонтали или вертикали, которые видны, пока перетаскиваемое (отрезок, излом или
 * конец стрелки, фигура, группа) совпадает с чем-то по одной из осей, и к которым оно прилипает. Чистые функции без React.
 */
/** Ровная линия по горизонтали (axis "y": линия на высоте at) или по вертикали (axis "x": на x = at) от from до to вдоль другой оси. */
export interface Guide {
  axis: "x" | "y";
  at: number;
  from: number;
  to: number;
}

/** Опорная линия: координата at по оси и протяжённость того, что на ней лежит (для длины направляющей). */
export interface GuideTarget {
  at: number;
  lo: number;
  hi: number;
}

type Box = { x: number; y: number; w: number; h: number };

/**
 * С чем можно выровнять: верх, середина и низ фигур (для оси y; левый край, середина и правый — для x) и вершины самой стрелки,
 * кроме тех, что сейчас перетаскиваются (skip — их индексы в ломаной). Порты концов стрелки не пропускаются: выровнять отрезок
 * по линии порта — значит выпрямить стрелку.
 */
export function guideTargets(axis: "x" | "y", boxes: Iterable<Box>, poly: Pt[], skip: number[] = [], others: Pt[][] = []): GuideTarget[] {
  const out = boxTargets(axis, boxes);
  const vertices = (pts: Pt[], skipIdx: number[]) =>
    pts.forEach((p, j) => {
      if (skipIdx.includes(j)) return;
      const [at, other] = axis === "y" ? [p[1], p[0]] : [p[0], p[1]];
      out.push({ at, lo: other, hi: other });
    });
  vertices(poly, skip);
  // вершины других стрелок: так можно выстроить параллельные стрелки на одной линии (оба конца отрезка дают протяжённость направляющей)
  for (const o of others) vertices(o, []);
  return out;
}

/** Опорные линии фигур по оси: верх, середина, низ (ось y) или левый край, середина, правый край (ось x). */
export function boxTargets(axis: "x" | "y", boxes: Iterable<Box>): GuideTarget[] {
  const out: GuideTarget[] = [];
  for (const b of boxes) {
    const [a0, a1, o0, o1] = axis === "y" ? [b.y, b.h, b.x, b.x + b.w] : [b.x, b.w, b.y, b.y + b.h];
    for (const at of [a0, a0 + a1 / 2, a0 + a1]) out.push({ at, lo: o0, hi: o1 });
  }
  return out;
}

/** Расстояние до опорной линии, ближе которого элемент к ней прилипает (в пикселях экрана). */
export const GUIDE_SNAP_PX = 6;

/**
 * Прилипание к ближайшей опорной линии не дальше tol. hit — все опорные линии на той же координате: направляющая тянется
 * через них все, чтобы было видно, с чем именно выровнено.
 */
export function snapAxis(value: number, targets: GuideTarget[], tol: number): { value: number; hit: GuideTarget[] } {
  let best: GuideTarget | null = null;
  for (const t of targets) if (Math.abs(t.at - value) <= tol && (!best || Math.abs(t.at - value) < Math.abs(best.at - value))) best = t;
  if (!best) return { value, hit: [] };
  const at = best.at;
  return { value: at, hit: targets.filter((t) => Math.abs(t.at - at) < 0.5) };
}

/** Направляющая через выровненные линии и сам перетаскиваемый элемент (own — его протяжённость вдоль другой оси), с запасом по краям. */
export function guideFor(axis: "x" | "y", at: number, hit: GuideTarget[], own: [number, number]): Guide {
  const lo = Math.min(own[0], own[1], ...hit.map((h) => h.lo));
  const hi = Math.max(own[0], own[1], ...hit.map((h) => h.hi));
  return { axis, at, from: lo - 16, to: hi + 16 };
}

/** Результат выравнивания прямоугольника: на сколько его сдвинуть, по каким осям он прилип и какие направляющие показать. */
export interface ShapeSnap {
  dx: number;
  dy: number;
  /** Прилип по оси: положение на ней — не по сетке, а точно по направляющей (сетку поверх не накладывать). */
  x: boolean;
  y: boolean;
  guides: Guide[];
}

/**
 * Выравнивание перетаскиваемого прямоугольника (фигуры или рамки группы) с остальными фигурами: его левый край, середина и правый
 * край ищут совпадение с такими же линиями других фигур, верх, середина и низ — с горизонтальными. Среди трёх своих линий
 * выбирается ближайшая к опорной (не дальше tol). centers — дополнительные горизонтальные линии только для середины (центры
 * дорожек: фигура, стоящая по центру дорожки, выровнена с остальными).
 */
export function snapShape(rect: Box, others: Iterable<Box>, tol: number, centers: number[] = []): ShapeSnap {
  const boxes = [...others];
  const best = (axis: "x" | "y") => {
    const [start, size] = axis === "x" ? [rect.x, rect.w] : [rect.y, rect.h];
    const edges = boxTargets(axis, boxes);
    // центры дорожек — только для середины фигуры
    const middle = axis === "y" ? [...edges, ...centers.map((at) => ({ at, lo: rect.x, hi: rect.x + rect.w }))] : edges;
    let found: { delta: number; value: number; hit: GuideTarget[] } | null = null;
    [start, start + size / 2, start + size].forEach((line, k) => {
      const s = snapAxis(line, k === 1 ? middle : edges, tol);
      if (s.hit.length === 0) return;
      const delta = s.value - line;
      if (!found || Math.abs(delta) < Math.abs(found.delta)) found = { delta, value: s.value, hit: s.hit };
    });
    return found as { delta: number; value: number; hit: GuideTarget[] } | null;
  };  const sx = best("x");
  const sy = best("y");
  const [dx, dy] = [sx?.delta ?? 0, sy?.delta ?? 0];
  const moved = { x: rect.x + dx, y: rect.y + dy, w: rect.w, h: rect.h };
  const guides: Guide[] = [];
  if (sx) guides.push(guideFor("x", sx.value, sx.hit, [moved.y, moved.y + moved.h]));
  if (sy) guides.push(guideFor("y", sy.value, sy.hit, [moved.x, moved.x + moved.w]));
  return { dx, dy, x: !!sx, y: !!sy, guides };
}