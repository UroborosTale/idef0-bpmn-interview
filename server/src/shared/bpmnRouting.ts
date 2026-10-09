/**
 * Прокладка стрелок BPMN по всей диаграмме сразу — общий модуль генератора (BPMN, VSDX, альбом) и редактора в браузере.
 *
 * Стрелки нельзя прокладывать поодиночке: две ветки одного шлюза вышли бы из одной вершины, два потока вошли бы в одну
 * сторону задачи, а параллельные участки легли бы друг на друга. Поэтому маршрут строится в три шага:
 *  1. Стороны. Для каждой стрелки перебираются пары «сторона выхода × сторона входа»; у каждой пары есть шаблон ломаной
 *     (прямая, Г-образная, Z-образная, П-образная петля). Цена пары — изломы, длина, пересечения с фигурами и чужими
 *     стрелками, предпочтения по виду фигуры (в задачу входят слева, к шлюзу — в любую вершину) и занятость стороны:
 *     у ромба и круга порт одноразовый, у прямоугольника на одной стороне стрелки получают разные точки. Выбор уточняется
 *     несколькими проходами, пока он не перестанет меняться.
 *  2. Порты. Стрелки одной стороны фигуры раскладываются вдоль неё в порядке расположения концов (чтобы не пересекаться).
 *  3. Каналы. Средние участки Z- и П-образных стрелок (их положение свободно) разводятся так, чтобы не накладываться
 *     на другие стрелки и не задевать фигуры.
 */

import type { Box, EndKinds, Pt } from "./bpmnGeometry.js";
import { labelBox } from "./bpmnLabels.js";
import { orthogonalPath } from "./bpmnManual.js";

export type Side = "L" | "R" | "T" | "B";

export interface RouteNode {
  id: string;
  box: Box;
  /** task | subprocess | gateway | event | pool; от вида зависят предпочтения сторон и форма границы (ромб, круг). */
  type: string;
  /** Граничное событие: стрелка уходит вниз от нижней границы задачи. */
  boundary?: boolean;
  /** Над задачей стоят значки документов: верхняя сторона занята ассоциациями. */
  artifacts?: boolean;
  /** Под задачей стоят значки хранилищ данных (1С, ELMA…): нижняя сторона занята ассоциациями. */
  stores?: boolean;
  /** Название события или шлюза: оно подписано под фигурой, и чужие стрелки обходят текст (у задач название внутри фигуры). */
  label?: string;
}

/** Рамки подписей событий и шлюзов; owner — фигура-хозяин: её собственные стрелки подпись не задевают (редактор сдвигает подпись от линии). */
function labelsOf(nodes: RouteNode[]): { owner: string; box: Box }[] {
  return nodes.flatMap((n) => {
    const box = n.label && (n.type === "event" || n.type === "gateway") ? labelBox(n.box, n.label) : null;
    return box ? [{ owner: n.id, box }] : [];
  });
}

export interface RouteFlow {
  id: string;
  from: string;
  to: string;
  /** Поток сообщений между шагом и свёрнутым пулом: идёт строго вертикально (низ шага — верх пула). */
  message?: boolean;
  /**
   * Ручной маршрут (его задал пользователь): стороны выхода и входа и положение среднего участка. Такие стрелки
   * прокладываются первыми, остальные их обходят; если заданное не подходит по взаимному положению фигур, стрелка
   * прокладывается автоматически.
   */
  fixed?: { e?: Side; n?: Side; channel?: number; points?: Pt[]; ep?: number; np?: number } | null;
}

/**
 * Ручной маршрут модели в виде настройки прокладки; undefined — маршрут автоматический. points — свободные точки излома: линия идёт
 * строго через них (shared/bpmnManual.ts); ep и np — положение концов на сторонах (иначе концы разводятся сами).
 */
export const fixedRoute = (r: { from_side?: Side; to_side?: Side; channel?: number; from_pos?: number; to_pos?: number; points?: Pt[] } | null | undefined): RouteFlow["fixed"] => {
  if (!r) return undefined;
  const points = r.points && r.points.length > 0 ? r.points : undefined;
  if (!(r.from_side || r.to_side || r.channel !== undefined || r.from_pos !== undefined || r.to_pos !== undefined || points)) return undefined;
  return { e: r.from_side, n: r.to_side, channel: r.channel, ...(points ? { points } : {}), ...(r.from_pos !== undefined ? { ep: r.from_pos } : {}), ...(r.to_pos !== undefined ? { np: r.to_pos } : {}) };
};

/** Подвижный средний участок стрелки: по нему редактор рисует ручку и им же пользователь меняет маршрут. */
export interface RouteChannel {
  /** x — вертикальный участок (сдвигается по x), y — горизонтальный (по y). */
  axis: "x" | "y";
  /** Текущее положение (x или y). */
  at: number;
  /** Пределы перемещения (бесконечные у петли: наружу можно сколько угодно). */
  lo: number;
  hi: number;
  /** Середина участка — место ручки. */
  handle: Pt;
}

export interface RouteInfo {
  pts: Pt[];
  /** Какими сторонами стрелка выходит и входит (фактические, а не заданные). */
  from: Side;
  to: Side;
  channel?: RouteChannel;
  /** Маршрут взят из ручных настроек (иначе подобран автоматически). */
  manual: boolean;
}

const NORMAL: Record<Side, Pt> = { R: [1, 0], L: [-1, 0], T: [0, -1], B: [0, 1] };
const MIN = 12; // минимальная длина отрезка между изломами
const GAP = 24; // отступ линии обхода от фигур
const STEP = 10; // шаг разведения параллельных линий
const EPS = 0.5;
const CLEAR = 6; // зазор между линией и чужой фигурой: касание границы читается как «стрелка идёт сквозь фигуру»

const inflate = (b: Box, m: number): Box => ({ x: b.x - m, y: b.y - m, w: b.w + 2 * m, h: b.h + 2 * m });

// --- форма фигуры: точка на границе ---

/** Точка на стороне фигуры; frac — положение вдоль стороны (0,5 — середина, у ромба и круга — вершина). */
export function portPoint(box: Box, type: string, side: Side, frac: number): Pt {
  const { x, y, w, h } = box;
  const cx = x + w / 2;
  const cy = y + h / 2;
  if (side === "R" || side === "L") {
    const yy = y + frac * h;
    const dy = Math.abs(yy - cy);
    const half = type === "gateway" ? (w / 2) * (1 - dy / (h / 2)) : type === "event" ? Math.sqrt(Math.max(0, (w / 2) ** 2 - dy * dy)) : w / 2;
    return [side === "R" ? cx + half : cx - half, yy];
  }
  const xx = x + frac * w;
  const dx = Math.abs(xx - cx);
  const half = type === "gateway" ? (h / 2) * (1 - dx / (w / 2)) : type === "event" ? Math.sqrt(Math.max(0, (h / 2) ** 2 - dx * dx)) : h / 2;
  return [xx, side === "B" ? cy + half : cy - half];
}

// --- пересечения ---

const isH = (a: Pt, b: Pt) => Math.abs(a[1] - b[1]) < 1e-6;

/** Отрезок (горизонтальный или вертикальный) заходит внутрь прямоугольника. */
function cuts(a: Pt, b: Pt, r: Box): boolean {
  const x1 = Math.min(a[0], b[0]);
  const x2 = Math.max(a[0], b[0]);
  const y1 = Math.min(a[1], b[1]);
  const y2 = Math.max(a[1], b[1]);
  return x2 > r.x + EPS && x1 < r.x + r.w - EPS && y2 > r.y + EPS && y1 < r.y + r.h - EPS;
}

const length = (pts: Pt[]) => pts.reduce((s, p, i) => (i === 0 ? 0 : s + Math.abs(p[0] - pts[i - 1][0]) + Math.abs(p[1] - pts[i - 1][1])), 0);

/** Число перпендикулярных пересечений двух ломаных (не считая касаний в концах). */
export function crossingCount(a: Pt[], b: Pt[]): number {
  let n = 0;
  for (let i = 0; i + 1 < a.length; i++) {
    for (let j = 0; j + 1 < b.length; j++) {
      const [p1, p2, q1, q2] = [a[i], a[i + 1], b[j], b[j + 1]];
      if (isH(p1, p2) === isH(q1, q2)) continue;
      const [h1, h2, v1, v2] = isH(p1, p2) ? [p1, p2, q1, q2] : [q1, q2, p1, p2];
      const inX = v1[0] > Math.min(h1[0], h2[0]) + EPS && v1[0] < Math.max(h1[0], h2[0]) - EPS;
      const inY = h1[1] > Math.min(v1[1], v2[1]) + EPS && h1[1] < Math.max(v1[1], v2[1]) - EPS;
      if (inX && inY) n++;
    }
  }
  return n;
}

// --- шаблоны ломаных ---

interface Channel {
  /** Индекс первой точки среднего отрезка, который можно сдвигать. */
  i: number;
  /** x — вертикальный средний отрезок (сдвигается по x), y — горизонтальный (по y). */
  axis: "x" | "y";
  lo: number;
  hi: number;
  /** П-образная петля сдвигается только наружу: -1 вверх/влево, 1 вниз/вправо. */
  outward?: 1 | -1;
}

interface Built {
  pts: Pt[];
  channel?: Channel;
  hits: number;
  /** Сколько чужих подписей задевает ломаная: хуже изгиба, лучше пересечения (прохода сквозь фигуру это не касается). */
  soft: number;
}

interface Ctx {
  obstacles: { id: string; box: Box }[];
  labels: { owner: string; box: Box }[];
  from: string;
  to: string;
}

/** Сколько чужих подписей задевает ломаная. */
function softOf(pts: Pt[], ctx: Ctx): number {
  let n = 0;
  for (const l of ctx.labels) {
    if (l.owner === ctx.from || l.owner === ctx.to) continue;
    for (let i = 0; i + 1 < pts.length; i++) {
      if (cuts(pts[i], pts[i + 1], l.box)) {
        n++;
        break;
      }
    }
  }
  return n;
}

const made = (pts: Pt[], ctx: Ctx, channel?: Channel): Built => ({ pts, hits: hitsOf(pts, ctx), soft: softOf(pts, ctx), ...(channel ? { channel } : {}) });

/**
 * Сколько фигур задевает ломаная. Первый отрезок не проверяется против фигуры-источника, последний — против цели
 * (они начинаются и кончаются на границе); против всех остальных, в том числе против «чужого» конца, проверяется всё.
 */
function hitsOf(pts: Pt[], ctx: Ctx): number {
  let n = 0;
  for (const o of ctx.obstacles) {
    for (let i = 0; i + 1 < pts.length; i++) {
      if (i === 0 && o.id === ctx.from) continue;
      if (i === pts.length - 2 && o.id === ctx.to) continue;
      if (cuts(pts[i], pts[i + 1], o.id === ctx.from || o.id === ctx.to ? o.box : inflate(o.box, CLEAR))) {
        n++;
        break;
      }
    }
  }
  return n;
}

/** Положения линии вокруг base с шагом STEP внутри [lo, hi]: сначала ближайшие. */
function around(base: number, lo: number, hi: number, limit = 24): number[] {
  const out: number[] = [];
  const snap = (v: number) => Math.round(v * 2) / 2;
  if (base >= lo && base <= hi) out.push(snap(base));
  for (let k = 1; out.length < limit && (base + k * STEP <= hi || base - k * STEP >= lo); k++) {
    if (base + k * STEP <= hi) out.push(snap(base + k * STEP));
    if (base - k * STEP >= lo) out.push(snap(base - k * STEP));
  }
  return out;
}

/**
 * Ломаная для пары сторон; null — шаблон не подходит по взаимному положению (например, вход в левую сторону цели,
 * которая левее источника). П-образная петля (обе стороны одноимённые) подходит всегда.
 */
function build(p: Pt, e: Side, q: Pt, n: Side, ctx: Ctx): Built | null {
  const h0 = NORMAL[e];
  const h1: Pt = [-NORMAL[n][0], -NORMAL[n][1]]; // направление, в котором стрелка входит в цель
  const dot = h0[0] * h1[0] + h0[1] * h1[1];

  if (dot === 0) {
    // Г-образная: одна половина — вдоль выхода, вторая — вдоль входа
    const horizontalFirst = h0[0] !== 0;
    const corner: Pt = horizontalFirst ? [q[0], p[1]] : [p[0], q[1]];
    const ok = horizontalFirst ? (q[0] - p[0]) * h0[0] >= MIN && (q[1] - p[1]) * h1[1] >= MIN : (q[1] - p[1]) * h0[1] >= MIN && (q[0] - p[0]) * h1[0] >= MIN;
    if (!ok) return null;
    return made([p, corner, q], ctx);
  }

  const horizontal = h0[0] !== 0;
  if (dot === 1) {
    // Z-образная (или прямая): выход и вход смотрят в одну сторону
    const d = horizontal ? (q[0] - p[0]) * h0[0] : (q[1] - p[1]) * h0[1];
    const across = horizontal ? Math.abs(q[1] - p[1]) : Math.abs(q[0] - p[0]);
    if (d < MIN) return null;
    if (across < EPS) return made([p, q], ctx);
    if (d < 2 * MIN) return null;
    const lo = (horizontal ? Math.min(p[0], q[0]) : Math.min(p[1], q[1])) + MIN;
    const hi = (horizontal ? Math.max(p[0], q[0]) : Math.max(p[1], q[1])) - MIN;
    let best: Built | null = null;
    let spare = 0;
    for (const c of around((lo + hi + 2 * MIN) / 2, lo, hi, 30)) {
      const pts: Pt[] = horizontal ? [p, [c, p[1]], [c, q[1]], q] : [p, [p[0], c], [q[0], c], q];
      const hits = hitsOf(pts, ctx);
      if (best && hits > best.hits) continue;
      const b: Built = { pts, hits, soft: softOf(pts, ctx), channel: { i: 1, axis: horizontal ? "x" : "y", lo, hi } };
      // сначала меньше задетых фигур, при равенстве — меньше задетых подписей
      if (!best || b.hits < best.hits || b.soft < best.soft) best = b;
      // нашли положение без задетых фигур: подписи ищем обойти лишь среди ближайших к середине положений
      if (best.hits === 0 && (best.soft === 0 || ++spare >= LABEL_TRIES)) break;
    }
    return best;
  }

  // П-образная петля: обе стороны одноимённые; линия идёт снаружи обеих фигур
  const out = (horizontal ? h0[0] : h0[1]) as 1 | -1;
  const [a, b] = horizontal ? [p[0], q[0]] : [p[1], q[1]];
  let c = out > 0 ? Math.max(a, b) + GAP : Math.min(a, b) - GAP;
  const spanLo = horizontal ? Math.min(p[1], q[1]) : Math.min(p[0], q[0]);
  const spanHi = horizontal ? Math.max(p[1], q[1]) : Math.max(p[0], q[0]);
  // отодвигаем линию, пока она задевает фигуры на пути
  for (let guard = 0; guard < 16; guard++) {
    const probe: Pt[] = horizontal ? [[c, spanLo], [c, spanHi]] : [[spanLo, c], [spanHi, c]];
    const blocker = ctx.obstacles.find((o) => o.id !== ctx.from && o.id !== ctx.to && cuts(probe[0], probe[1], inflate(o.box, CLEAR)));
    if (!blocker) break;
    const bb = blocker.box;
    c = horizontal ? (out > 0 ? bb.x + bb.w + GAP : bb.x - GAP) : out > 0 ? bb.y + bb.h + GAP : bb.y - GAP;
    if (guard === 15) break;
  }
  const pts: Pt[] = horizontal ? [p, [c, p[1]], [c, q[1]], q] : [p, [p[0], c], [q[0], c], q];
  return made(pts, ctx, { i: 1, axis: horizontal ? "x" : "y", lo: -Infinity, hi: Infinity, outward: out });
}

// --- предпочтения и занятость ---

/** Надбавка к цене за использование стороны фигуры: по соглашениям BPMN в задачу входят слева, а выходят справа. */
function sidePref(n: RouteNode, side: Side, end: "out" | "in"): number {
  if (n.type === "pool") return side === "T" ? 0 : 200;
  if (n.type === "gateway") return side === "L" ? (end === "out" ? 60 : 0) : side === "R" ? (end === "in" ? 60 : 0) : side === "B" ? 6 : 0;
  const toward = end === "out" ? "R" : "L";
  const away = end === "out" ? "L" : "R";
  if (side === toward) return 0;
  if (side === away) return 60;
  const base = n.type === "event" ? (side === "B" && end === "out" ? 12 : 25) : 25;
  return base + (n.artifacts && side === "T" ? 60 : 0) + (n.stores && side === "B" ? 60 : 0);
}

/**
 * Сколько стрелок уже занимает сторону фигуры и какова цена ещё одной. В один вход входит одна стрелка, из одного выхода
 * выходит одна — у любой фигуры; на одной стороне стрелки делят точки только когда свободных сторон не осталось.
 * Пул принимает сколько угодно потоков сообщений.
 */
function occupancyCost(n: RouteNode, count: number): number {
  return count === 0 || n.type === "pool" ? 0 : 600 * count;
}

/** Сколько положений канала, не задевающих фигур, просматривается в поисках такого, что обходит и подписи. */
const LABEL_TRIES = 6;

/** До скольких стрелок на диаграмме стороны пересматриваются парами (дальше стоимость растёт быстрее пользы). */
const PAIR_MAX_FLOWS = 40;

/** Сколько лучших по отдельности сочетаний сторон первой стрелки перебирается при парном пересмотре. */
const PAIR_OPTIONS = 4;

/** Условное расстояние, на которое дуги уходят в сторону при упорядочении портов: больше любой диаграммы. */
const ARC_SPAN = 100_000;

/** Цена ломаной через чужую подпись: заметно больше изгиба, но меньше пересечения стрелок (150) и намного меньше прохода сквозь фигуру. */
const LABEL_HIT = 90;

// --- сборка ---

interface Choice {
  e: Side;
  n: Side;
  pts: Pt[];
  channel?: Channel;
}

type Seg = { axis: "x" | "y"; at: number; from: number; to: number };
const seg = (a: Pt, b: Pt): Seg => (isH(a, b) ? { axis: "y", at: a[1], from: Math.min(a[0], b[0]), to: Math.max(a[0], b[0]) } : { axis: "x", at: a[0], from: Math.min(a[1], b[1]), to: Math.max(a[1], b[1]) });
/** Два отрезка лежат на одной прямой и перекрываются. */
const clash = (s: Seg, t: Seg) => s.axis === t.axis && Math.abs(s.at - t.at) < 5 && Math.min(s.to, t.to) - Math.max(s.from, t.from) > 2;
/**
 * Две Z-образные стрелки «крест-накрест» (их концы лежат на одних и тех же двух линиях): как ни разводи каналы, их отрезки
 * на этих линиях лягут друг на друга, поэтому одной нужна другая форма. Бывает в двух видах: стрелки идут в одну сторону, а
 * линии начала и конца у них поменялись местами, или идут навстречу друг другу по одним и тем же линиям.
 */
function crossedZ(a: Pt[], b: Pt[]): boolean {
  if (a.length !== 4 || b.length !== 4) return false;
  const horizontal = isH(a[0], a[1]);
  if (isH(b[0], b[1]) !== horizontal) return false;
  const i = horizontal ? 1 : 0; // координата линии, на которой стоят концы
  const j = horizontal ? 0 : 1; // координата вдоль движения
  const near = (u: number, v: number) => Math.abs(u - v) < 3;
  const overlap = Math.min(Math.max(a[0][j], a[3][j]), Math.max(b[0][j], b[3][j])) - Math.max(Math.min(a[0][j], a[3][j]), Math.min(b[0][j], b[3][j]));
  if (near(a[0][i], a[3][i]) || overlap <= 40) return false;
  const sameWay = Math.sign(a[3][j] - a[0][j]) === Math.sign(b[3][j] - b[0][j]);
  return sameWay ? near(a[0][i], b[3][i]) && near(a[3][i], b[0][i]) : near(a[0][i], b[0][i]) && near(a[3][i], b[3][i]);
}
/** Неподвижные отрезки ломаной (без среднего канала, положение которого потом подбирается). */
const fixedSegs = (pts: Pt[], channel?: Channel): Seg[] => pts.slice(0, -1).flatMap((p, i) => (channel && i === channel.i ? [] : [seg(p, pts[i + 1])]));

/**
 * Маршруты всех стрелок: id стрелки → ломаная (extraObstacles — прочие рамки, которые стрелки обходят: значки документов).
 * Концы лежат на границе фигур (у ромба и круга — на их контуре), линии ортогональны; стрелки не выходят из одного
 * порта, не входят в один и не накладываются друг на друга.
 */
export function routeFlows(nodes: RouteNode[], flows: RouteFlow[], extraObstacles: Box[] = []): Map<string, Pt[]> {
  return new Map([...routeFlowsDetailed(nodes, flows, extraObstacles)].map(([id, r]) => [id, r.pts] as const));
}

/** Показатели прокладки: пересечения стрелок друг с другом, проходы сквозь фигуры, задетые подписи и суммарная длина линий. */
export interface RouteQuality {
  crossings: number;
  cuts: number;
  /** Сколько раз чужая стрелка идёт через подпись события или шлюза. */
  labels: number;
  /** Сколько пар подписей налезает друг на друга. */
  labelClash: number;
  length: number;
}

/**
 * Оценка готовой прокладки — по ней сравнивают варианты раскладки фигур. Пересечением считается перекрёстье
 * горизонтального и вертикального участков разных стрелок (касания и общие концы не в счёт); проходом сквозь фигуру —
 * участок, входящий в чужую фигуру (свои концы стрелки не считаются).
 */
export function routeQuality(nodes: RouteNode[], flows: RouteFlow[], routes: Map<string, Pt[]>, extraObstacles: Box[] = []): RouteQuality {
  type Seg = { id: string; a: Pt; b: Pt; h: boolean };
  const segs: Seg[] = [];
  let length = 0;
  let cuts = 0;
  let labelHits = 0;
  const labels = labelsOf(nodes);
  for (const f of flows) {
    const pts = routes.get(f.id);
    if (!pts) continue;
    labelHits += softOf(pts, { obstacles: [], labels, from: f.from, to: f.to });
    for (let i = 0; i + 1 < pts.length; i++) {
      const [a, b] = [pts[i], pts[i + 1]];
      length += Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
      segs.push({ id: f.id, a, b, h: Math.abs(a[1] - b[1]) < 1e-6 });
      for (const n of nodes) {
        if ((n.id === f.from && i === 0) || (n.id === f.to && i === pts.length - 2) || n.type === "pool") continue;
        const r = n.box;
        const [x1, x2, y1, y2] = [Math.min(a[0], b[0]), Math.max(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[1], b[1])];
        if (x2 > r.x + 0.5 && x1 < r.x + r.w - 0.5 && y2 > r.y + 0.5 && y1 < r.y + r.h - 0.5) cuts++;
      }
      // значки данных (они не фигуры диаграммы, но линия через значок так же портит чтение)
      for (const r of extraObstacles) {
        const [x1, x2, y1, y2] = [Math.min(a[0], b[0]), Math.max(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[1], b[1])];
        if (x2 > r.x + 0.5 && x1 < r.x + r.w - 0.5 && y2 > r.y + 0.5 && y1 < r.y + r.h - 0.5) cuts++;
      }
    }
  }
  let crossings = 0;
  const hs = segs.filter((s) => s.h);
  const vs = segs.filter((s) => !s.h);
  for (const h of hs) {
    const [hx1, hx2] = [Math.min(h.a[0], h.b[0]), Math.max(h.a[0], h.b[0])];
    for (const v of vs) {
      if (v.id === h.id) continue;
      const [vy1, vy2] = [Math.min(v.a[1], v.b[1]), Math.max(v.a[1], v.b[1])];
      if (v.a[0] > hx1 + 1 && v.a[0] < hx2 - 1 && h.a[1] > vy1 + 1 && h.a[1] < vy2 - 1) crossings++;
    }
  }
  // подписи двух фигур не должны налезать друг на друга (у событий в одной дорожке подписи шире самих фигур)
  let labelClash = 0;
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) {
      const [a, b] = [labels[i].box, labels[j].box];
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) labelClash++;
    }
  }
  return { crossings, cuts, labels: labelHits, labelClash, length };
}
/**
 * Сколько вариантов раскладки перебирается. Число считается по размеру диаграммы, а не по часам, поэтому результат не зависит
 * от скорости машины. Прокладка одного варианта растёт гораздо быстрее, чем число стрелок (замер: 100 стрелок — около 85 мс,
 * 150 — около 185 мс, то есть примерно в степени 3,5), поэтому на больших диаграммах вариантов меньше: бюджет делится на число
 * стрелок в этой степени (~0,5 с на диаграмму до 100 стрелок), а диаграммы от ~120 стрелок остаются как есть — подбор там не
 * окупается.
 */
export const MAX_EVALUATIONS = 200;
const WORK_BUDGET = 70_000_000;
export const MIN_EVALUATIONS = 4;
export const evaluationsFor = (flows: number) => Math.min(MAX_EVALUATIONS, Math.floor(WORK_BUDGET / Math.pow(Math.max(flows, 1), 3.5)));

/** То же, что routeFlows, но с фактическими сторонами и подвижным участком каждой стрелки (для ручной правки в редакторе). */
export function routeFlowsDetailed(nodes: RouteNode[], flows: RouteFlow[], extraObstacles: Box[] = []): Map<string, RouteInfo> {
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const list = flows.filter((f) => f.from !== f.to && byId.has(f.from) && byId.has(f.to));
  // препятствия: все фигуры и значки документов над задачами и хранилищ под ними (у них нет id: они никогда не бывают концом стрелки)
  const obstacles = [...nodes.map((n) => ({ id: n.id, box: n.box })), ...extraObstacles.map((box, i) => ({ id: `\u0002obstacle${i}`, box }))];
  const labels = labelsOf(nodes);
  const ctxOf = (f: RouteFlow): Ctx => ({ obstacles, labels, from: f.from, to: f.to });

  // ignoreFixed — повторная попытка, когда заданные пользователем стороны не подходят по взаимному положению фигур
  const exits = (f: RouteFlow, ignoreFixed = false): Side[] => {
    const from = byId.get(f.from)!;
    if (f.message) return [from.type === "pool" ? "T" : "B"];
    if (from.boundary) return ["B"];
    if (f.fixed?.e && !ignoreFixed) return [f.fixed.e];
    return ["R", "B", "T", "L"];
  };
  const entries = (f: RouteFlow, ignoreFixed = false): Side[] => {
    const to = byId.get(f.to)!;
    if (f.message) return [to.type === "pool" ? "T" : "B"];
    if (f.fixed?.n && !ignoreFixed) return [f.fixed.n];
    return ["L", "B", "T", "R"];
  };

  // сначала стрелки с жёсткими сторонами, затем остальные в порядке модели
  const hard = (f: RouteFlow) => (f.message || byId.get(f.from)!.boundary ? 1 : 0) + (f.fixed ? 2 : 0);
  const order = [...list].sort((a, b) => hard(b) - hard(a));
  // стрелки, проведённые пользователем по точкам: путь задан целиком, подбираются только их стороны (если не заданы)
  const manualIds = new Set(list.filter((f) => (f.fixed?.points?.length ?? 0) > 0).map((f) => f.id));
  const autoOrder = order.filter((f) => !manualIds.has(f.id));
  const chosen = new Map<string, Choice>();
  /** Положение порта вдоль стороны у выбранных стрелок: `${flowId}:out|in` → доля стороны (0,5 — середина). */
  let portFrac = new Map<string, number>();

  const flowById = new Map(list.map((f) => [f.id, f] as const));
  const used = (id: string, side: Side, except: string) => {
    let k = 0;
    for (const [fid, c] of chosen) {
      if (fid === except) continue;
      const f = flowById.get(fid)!;
      if ((f.from === id && c.e === side) || (f.to === id && c.n === side)) k++;
    }
    return k;
  };

  /** Ключ порядка стрелок вдоль стороны: положение дальнего конца (чтобы стрелки не пересекались у фигуры). */
  const farKey = (side: Side, other: RouteNode, self: RouteNode) => {
    if (side === "L" || side === "R") return other.box.y + other.box.h / 2;
    const cx = other.box.x + other.box.w / 2;
    // Дуга: другой конец в том же ряду, и стрелка идёт над или под фигурами между ними. Вложенные дуги не пересекаются, только если
    // порт дальнего конца лежит дальше от него: слева направо идут «слева — от ближнего к дальнему», затем «справа — от дальнего
    // к ближнему». По порядку x это было бы наоборот, и дуги пересекались бы.
    const sameRow = other.type !== "pool" && self.type !== "pool" && Math.abs(other.box.y + other.box.h / 2 - (self.box.y + self.box.h / 2)) < (self.box.h + other.box.h) / 2;
    if (!sameRow) return cx;
    const selfX = self.box.x + self.box.w / 2;
    return cx < selfX ? selfX - ARC_SPAN + (selfX - cx) : selfX + ARC_SPAN - (cx - selfX);
  };
  type Slot = { key: number; end: "out" | "in"; self?: boolean };
  const bySlot = (a: Slot, b: Slot) => a.key - b.key || (a.end === "out" ? -1 : 1);
  /** Доля стороны, на которой стоит i-й из count портов. */
  const fracAt = (node: RouteNode, count: number, i: number) => {
    const step = node.type === "gateway" || node.type === "event" ? Math.min(0.26, 0.5 / Math.max(count - 1, 1)) : node.type === "pool" ? Math.min(0.25, 0.7 / Math.max(count - 1, 1)) : Math.min(0.26, 0.6 / Math.max(count - 1, 1));
    return count === 1 ? 0.5 : 0.5 + (i - (count - 1) / 2) * step;
  };
  /** Где окажется порт стрелки f на стороне side фигуры node, если выбрать эту сторону: среди уже занявших её стрелок. */
  const fracIfAdded = (node: RouteNode, side: Side, f: RouteFlow, end: "out" | "in", other: RouteNode) => {
    const items: Slot[] = [];
    for (const [fid, c] of chosen) {
      if (fid === f.id) continue;
      const g = flowById.get(fid)!;
      if (g.from === node.id && c.e === side) items.push({ key: farKey(side, byId.get(g.to)!, node), end: "out" });
      if (g.to === node.id && c.n === side) items.push({ key: farKey(side, byId.get(g.from)!, node), end: "in" });
    }
    items.push({ key: farKey(side, other, node), end, self: true });
    items.sort(bySlot);
    return fracAt(node, items.length, items.findIndex((s) => s.self));
  };

  type Scored = { cost: number; choice: Choice };
  /** Цена маршрута стрелки f, если она выйдет из стороны e и войдёт в сторону n, при уже сделанном выборе остальных стрелок. */
  const score = (f: RouteFlow, e: Side, n: Side): Scored | null => {
    const from = byId.get(f.from)!;
    const to = byId.get(f.to)!;
    // маршрут оценивается с той точкой порта, которую стрелка реально получит на этой стороне рядом с соседями
    const p = portPoint(from.box, from.type, e, fracIfAdded(from, e, f, "out", to));
    const q = portPoint(to.box, to.type, n, fracIfAdded(to, n, f, "in", from));
    const built = build(p, e, q, n, ctxOf(f));
    if (!built) return null;
    // проход сквозь фигуру хуже общего порта, поэтому штраф за него больше штрафа за занятый порт
    let cost = 10 * (built.pts.length - 2) + length(built.pts) / 50 + 1500 * built.hits + sidePref(from, e, "out") + sidePref(to, n, "in");
    cost += occupancyCost(from, used(f.from, e, f.id)) + occupancyCost(to, used(f.to, n, f.id)) + LABEL_HIT * built.soft;
    // ветка шлюза на другой уровень по соглашению уходит из верхней или нижней вершины, а не справа
    if (from.type === "gateway" && e === "R" && Math.abs(q[1] - p[1]) > 30) cost += 8;
    const mine = fixedSegs(built.pts, built.channel);
    for (const [fid, c] of chosen) {
      if (fid === f.id) continue;
      // пути стрелок не должны пересекаться: пересечение дороже любого обхода, кроме прохода сквозь фигуру
      cost += 150 * crossingCount(built.pts, c.pts) + (crossedZ(built.pts, c.pts) ? 1200 : 0);
      // наложение на неподвижный участок чужой стрелки: средние каналы разводятся потом, а такие участки сдвинуть нельзя
      const theirs = fixedSegs(c.pts, c.channel);
      for (const s of mine) for (const t of theirs) if (clash(s, t)) cost += 120;
    }
    return { cost, choice: { e, n, pts: built.pts, channel: built.channel } };
  };

  const chooseScored = (f: RouteFlow, ignoreFixed = false): Scored | null => {
    let best: Scored | null = null;
    for (const e of exits(f, ignoreFixed)) {
      for (const n of entries(f, ignoreFixed)) {
        const s = score(f, e, n);
        if (s && (!best || s.cost < best.cost - 1e-9)) best = s;
      }
    }
    // заданные пользователем стороны не подошли — стрелка прокладывается автоматически
    if (!best && !ignoreFixed && (f.fixed?.e || f.fixed?.n)) return chooseScored(f, true);
    return best;
  };
  const choose = (f: RouteFlow, ignoreFixed = false): Choice | null => chooseScored(f, ignoreFixed)?.choice ?? null;

  /** Порты: стрелки одной стороны раскладываются вдоль неё в порядке расположения дальних концов. */
  const spreadPorts = () => {
    const out = new Map<string, number>();
    const sides = new Map<string, { fid: string; end: "out" | "in"; key: number }[]>();
    for (const f of list) {
      const c = chosen.get(f.id);
      if (!c) continue;
      const from = byId.get(f.from)!;
      const to = byId.get(f.to)!;
      for (const [node, side, end, other] of [[from, c.e, "out", to], [to, c.n, "in", from]] as const) {
        if ((end === "out" ? f.fixed?.ep : f.fixed?.np) !== undefined) continue; // положение задано пользователем: остальные разводятся вокруг
        const k = `${node.id}\u0001${side}`; // разделитель, которого нет в id (в id пулов есть двоеточие)
        sides.set(k, [...(sides.get(k) ?? []), { fid: f.id, end, key: farKey(side, other, node) }]);
      }
    }
    for (const [k, items] of sides) {
      const node = byId.get(k.split("\u0001")[0])!;
      items.sort(bySlot);
      items.forEach((it, i) => out.set(`${it.fid}:${it.end}`, fracAt(node, items.length, i)));
    }
    for (const f of list) {
      if (f.fixed?.ep !== undefined) out.set(`${f.id}:out`, f.fixed.ep);
      if (f.fixed?.np !== undefined) out.set(`${f.id}:in`, f.fixed.np);
    }
    portFrac = out;
  };

  // уточнение: каждая стрелка пересматривает выбор, зная выбор остальных и реальные положения портов
  const settle = () => {
    for (let pass = 0; pass < 4; pass++) {
      spreadPorts();
      let changed = false;
      for (const f of autoOrder) {
        const c = choose(f);
        const prev = chosen.get(f.id);
        if (c && (!prev || prev.e !== c.e || prev.n !== c.n)) {
          chosen.set(f.id, c);
          changed = true;
        }
      }
      if (!changed) break;
    }
  };

  /**
   * Парный пересмотр. Одиночный пересмотр не выбирается из тупика «первая стрелка заняла вершину шлюза, вторая вынуждена
   * обходить и пересекает первую»: ни одной из них по отдельности менять невыгодно, выгоден только обмен. Поэтому для
   * пересекающихся стрелок с общим концом (один выход или один вход) стороны подбираются сразу у обеих, в обоих порядках.
   */
  const refinePairs = (): boolean => {
    let improved = false;
    for (let i = 0; i < order.length; i++) {
      for (let j = i + 1; j < order.length; j++) {
        const [f, g] = [order[i], order[j]];
        const [cf, cg] = [chosen.get(f.id), chosen.get(g.id)];
        if (!cf || !cg || f.fixed || g.fixed || f.message || g.message) continue;
        if (f.from !== g.from && f.to !== g.to) continue;
        if (crossingCount(cf.pts, cg.pts) === 0) continue;
        // первая стрелка занимает свою сторону, вторая выбирает лучшее при ней
        const pair = (first: RouteFlow, second: RouteFlow, only?: Choice): { cost: number; a: Choice; b: Choice } | null => {
          let best: { cost: number; a: Choice; b: Choice } | null = null;
          // у первой стрелки перебираются только самые дешёвые по отдельности сочетания сторон: обмен выгоден, когда она уступает
          // вторую по цене сторону, а не худшую из шестнадцати
          const options = (only ? [[only.e, only.n] as const] : exits(first).flatMap((e) => entries(first).map((n) => [e, n] as const)))
            .map(([e, n]) => score(first, e, n))
            .filter((a): a is Scored => !!a)
            .sort((a, b) => a.cost - b.cost)
            .slice(0, only ? 1 : PAIR_OPTIONS);
          for (const a of options) {
            chosen.set(first.id, a.choice);
            const b = chooseScored(second);
            chosen.delete(first.id);
            if (b && (!best || a.cost + b.cost < best.cost - 1e-9)) best = { cost: a.cost + b.cost, a: a.choice, b: b.choice };
          }
          return best;
        };
        chosen.delete(f.id);
        chosen.delete(g.id);
        let winner: { first: RouteFlow; second: RouteFlow; a: Choice; b: Choice } | null = null;
        let gain = 1; // выигрыш меньше этого — шум
        for (const [first, second, now] of [[f, g, cf], [g, f, cg]] as const) {
          const current = pair(first, second, now);
          const better = pair(first, second);
          // current может не получиться (маршрут не строится): тогда оставляем всё как есть
          if (current && better && current.cost - better.cost > gain) {
            gain = current.cost - better.cost;
            winner = { first, second, a: better.a, b: better.b };
          }
        }
        if (winner) {
          chosen.set(winner.first.id, winner.a);
          chosen.set(winner.second.id, winner.b);
          improved = true;
        } else {
          chosen.set(f.id, cf);
          chosen.set(g.id, cg);
        }
      }
    }
    return improved;
  };

  // ручные стрелки идут первыми: их стороны (если не заданы) подбираются как у обычных, а путь затем заменяется заданным
  for (const f of [...order.filter((x) => manualIds.has(x.id)), ...autoOrder]) {
    const c = choose(f);
    if (!c) continue;
    if (manualIds.has(f.id)) {
      const [from, to] = [byId.get(f.from)!, byId.get(f.to)!];
      const p = portPoint(from.box, from.type, c.e, f.fixed?.ep ?? 0.5);
      const q = portPoint(to.box, to.type, c.n, f.fixed?.np ?? 0.5);
      chosen.set(f.id, { e: c.e, n: c.n, pts: orthogonalPath(p, c.e, f.fixed!.points!, q, c.n) });
    } else chosen.set(f.id, c);
  }
  settle();
  // на больших диаграммах пересмотр пар стоит больше трети времени прокладки и почти ничего не даёт: пересечений там и так много
  for (let round = 0; round < 3 && list.length <= PAIR_MAX_FLOWS && refinePairs(); round++) settle();
  spreadPorts();

  const routes = new Map<string, { pts: Pt[]; channel?: Channel; hits: number; soft: number }>();
  for (const f of list) {
    const c = chosen.get(f.id);
    if (!c) continue;
    const from = byId.get(f.from)!;
    const to = byId.get(f.to)!;
    const p = portPoint(from.box, from.type, c.e, portFrac.get(`${f.id}:out`) ?? 0.5);
    const q = portPoint(to.box, to.type, c.n, portFrac.get(`${f.id}:in`) ?? 0.5);
    if (manualIds.has(f.id)) {
      // путь задан точками пользователя; порты берутся с учётом остальных стрелок на стороне (или заданного положения)
      routes.set(f.id, { pts: orthogonalPath(p, c.e, f.fixed!.points!, q, c.n), hits: 0, soft: 0 });
      continue;
    }
    const built = build(p, c.e, q, c.n, ctxOf(f)) ?? build(portPoint(from.box, from.type, c.e, 0.5), c.e, portPoint(to.box, to.type, c.n, 0.5), c.n, ctxOf(f));
    if (built) routes.set(f.id, built);
  }

  // каналы: средний отрезок Z- и П-образных стрелок подбирается так, чтобы вся ломаная (а не только канал: вместе с ним
  // меняются длины соседних отрезков) не ложилась на уже проложенные линии. Ручной канал ставится как задан и первым.
  const allSegs = (pts: Pt[]) => pts.slice(0, -1).map((p, i) => seg(p, pts[i + 1]));
  const placed: Seg[] = [];
  const manualChannel = new Set<string>();
  for (const [, r] of routes) if (!r.channel) placed.push(...allSegs(r.pts));
  const withChannel = list.filter((f) => routes.get(f.id)?.channel).sort((a, b) => Number(b.fixed?.channel !== undefined) - Number(a.fixed?.channel !== undefined));
  for (const f of withChannel) {
    const r = routes.get(f.id)!;
    const ch = r.channel!;
    const base = ch.axis === "x" ? r.pts[1][0] : r.pts[1][1];
    const wanted = f.fixed?.channel;
    const withAt = (c: number): Pt[] => r.pts.map((p, i) => (i === 1 || i === 2 ? (ch.axis === "x" ? [c, p[1]] : [p[0], c]) : p) as Pt);
    let pick = base;
    // заданное пользователем положение подходит, если оно в пределах (у петли — снаружи фигур) и не задевает фигуры
    if (wanted !== undefined && (ch.outward ? (wanted - base) * ch.outward >= 0 : wanted >= ch.lo - MIN && wanted <= ch.hi + MIN) && hitsOf(withAt(wanted), ctxOf(f)) <= r.hits) {
      pick = wanted;
      manualChannel.add(f.id);
    } else {
      const candidates = ch.outward ? Array.from({ length: 14 }, (_, k) => base + k * STEP * ch.outward!) : around(base, ch.lo, ch.hi, 30);
      // из подходящих положений — то, что задевает меньше всего подписей (при равенстве — ближайшее к исходному)
      let fewest = Infinity;
      for (const c of candidates) {
        const pts = withAt(c);
        if (allSegs(pts).some((s) => placed.some((o) => clash(s, o)))) continue;
        if (hitsOf(pts, ctxOf(f)) > r.hits) continue;
        const soft = softOf(pts, ctxOf(f));
        if (soft < fewest) (fewest = soft, (pick = c));
        if (soft === 0) break;
      }
    }
    r.pts = withAt(pick);
    placed.push(...allSegs(r.pts));
  }

  const out = new Map<string, RouteInfo>();
  for (const f of list) {
    const r = routes.get(f.id);
    const c = chosen.get(f.id);
    if (!r || !c) continue;
    const channel: RouteChannel | undefined = r.channel
      ? { axis: r.channel.axis, at: r.channel.axis === "x" ? r.pts[1][0] : r.pts[1][1], lo: r.channel.lo, hi: r.channel.hi, handle: [(r.pts[1][0] + r.pts[2][0]) / 2, (r.pts[1][1] + r.pts[2][1]) / 2] }
      : undefined;
    out.set(f.id, { pts: simplify(r.pts), from: c.e, to: c.n, channel, manual: manualIds.has(f.id) || (!!f.fixed && (f.fixed.e === c.e || f.fixed.n === c.n || manualChannel.has(f.id))) });
  }
  return out;
}
/** Убирает повторяющиеся точки и промежуточные точки на прямых участках. */
function simplify(pts: Pt[]): Pt[] {
  const dedup = pts.filter((p, i) => i === 0 || Math.abs(p[0] - pts[i - 1][0]) > 1e-6 || Math.abs(p[1] - pts[i - 1][1]) > 1e-6);
  return dedup.filter((p, i) => {
    if (i === 0 || i === dedup.length - 1) return true;
    const a = dedup[i - 1];
    const b = dedup[i + 1];
    return !((Math.abs(a[0] - p[0]) < 1e-6 && Math.abs(p[0] - b[0]) < 1e-6) || (Math.abs(a[1] - p[1]) < 1e-6 && Math.abs(p[1] - b[1]) < 1e-6));
  });
}

/**
 * Маршрут одной стрелки между двумя фигурами с учётом чужих фигур на пути (obstacles) — для мест, где остальных стрелок
 * нет: проверки, примеры. Целая диаграмма прокладывается через routeFlows.
 */
export function waypoints(from: Box, to: Box, obstacles: Box[] = [], kinds: EndKinds = {}): Pt[] {
  const nodes: RouteNode[] = [
    { id: "from", box: from, type: kinds.fromType ?? "task", boundary: kinds.fromBoundary },
    { id: "to", box: to, type: kinds.toType ?? "task" },
    ...obstacles.map((box, i) => ({ id: `o${i}`, box, type: "task" })),
  ];
  return routeFlows(nodes, [{ id: "f", from: "from", to: "to" }]).get("f") ?? [];
}




