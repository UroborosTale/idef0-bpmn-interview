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

export type Side = "L" | "R" | "T" | "B";

export interface RouteNode {
  id: string;
  box: Box;
  /** task | subprocess | gateway | event | pool; от вида зависят предпочтения сторон и форма границы (ромб, круг). */
  type: string;
  /** Граничное событие: стрелка уходит вниз от нижней границы задачи. */
  boundary?: boolean;
  /** Над задачей стоят значки документов и хранилищ: верхняя сторона занята ассоциациями. */
  artifacts?: boolean;
}

export interface RouteFlow {
  id: string;
  from: string;
  to: string;
  /** Поток сообщений между шагом и свёрнутым пулом: идёт строго вертикально (низ шага — верх пула). */
  message?: boolean;
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
function crossingCount(a: Pt[], b: Pt[]): number {
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
}

interface Ctx {
  obstacles: { id: string; box: Box }[];
  from: string;
  to: string;
}

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
    const pts: Pt[] = [p, corner, q];
    return { pts, hits: hitsOf(pts, ctx) };
  }

  const horizontal = h0[0] !== 0;
  if (dot === 1) {
    // Z-образная (или прямая): выход и вход смотрят в одну сторону
    const d = horizontal ? (q[0] - p[0]) * h0[0] : (q[1] - p[1]) * h0[1];
    const across = horizontal ? Math.abs(q[1] - p[1]) : Math.abs(q[0] - p[0]);
    if (d < MIN) return null;
    if (across < EPS) {
      const pts: Pt[] = [p, q];
      return { pts, hits: hitsOf(pts, ctx) };
    }
    if (d < 2 * MIN) return null;
    const lo = (horizontal ? Math.min(p[0], q[0]) : Math.min(p[1], q[1])) + MIN;
    const hi = (horizontal ? Math.max(p[0], q[0]) : Math.max(p[1], q[1])) - MIN;
    let best: Built | null = null;
    for (const c of around((lo + hi + 2 * MIN) / 2, lo, hi, 30)) {
      const pts: Pt[] = horizontal ? [p, [c, p[1]], [c, q[1]], q] : [p, [p[0], c], [q[0], c], q];
      const hits = hitsOf(pts, ctx);
      if (!best || hits < best.hits) best = { pts, hits, channel: { i: 1, axis: horizontal ? "x" : "y", lo, hi } };
      if (hits === 0) break;
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
  return { pts, hits: hitsOf(pts, ctx), channel: { i: 1, axis: horizontal ? "x" : "y", lo: -Infinity, hi: Infinity, outward: out } };
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
  return base + (n.artifacts && side === "T" ? 60 : 0);
}

/** Сколько стрелок уже занимает сторону фигуры и какова цена ещё одной: у ромба и круга порт одноразовый. */
function occupancyCost(n: RouteNode, count: number): number {
  if (count === 0 || n.type === "pool") return 0;
  return (n.type === "gateway" || n.type === "event" ? 600 : 35) * count;
}

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
 * Две Z-образные стрелки «крест-накрест» между теми же двумя уровнями (одна идёт с верхнего на нижний, другая — с нижнего
 * на верхний): как ни разводи каналы, их горизонтальные отрезки лягут друг на друга, поэтому одной нужна другая форма.
 */
function crossedZ(a: Pt[], b: Pt[]): boolean {
  if (a.length !== 4 || b.length !== 4) return false;
  const horizontal = isH(a[0], a[1]);
  if (isH(b[0], b[1]) !== horizontal) return false;
  const i = horizontal ? 1 : 0; // координата «уровня»
  const j = horizontal ? 0 : 1; // координата вдоль движения
  const near = (u: number, v: number) => Math.abs(u - v) < 3;
  const overlap = Math.min(Math.max(a[0][j], a[3][j]), Math.max(b[0][j], b[3][j])) - Math.max(Math.min(a[0][j], a[3][j]), Math.min(b[0][j], b[3][j]));
  return near(a[0][i], b[3][i]) && near(a[3][i], b[0][i]) && !near(a[0][i], a[3][i]) && overlap > 40;
}

/** Неподвижные отрезки ломаной (без среднего канала, положение которого потом подбирается). */
const fixedSegs = (pts: Pt[], channel?: Channel): Seg[] => pts.slice(0, -1).flatMap((p, i) => (channel && i === channel.i ? [] : [seg(p, pts[i + 1])]));

/**
 * Маршруты всех стрелок: id стрелки → ломаная (extraObstacles — прочие рамки, которые стрелки обходят: значки документов).
 * Концы лежат на границе фигур (у ромба и круга — на их контуре), линии ортогональны; стрелки не выходят из одного
 * порта, не входят в один и не накладываются друг на друга.
 */
export function routeFlows(nodes: RouteNode[], flows: RouteFlow[], extraObstacles: Box[] = []): Map<string, Pt[]> {
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const list = flows.filter((f) => f.from !== f.to && byId.has(f.from) && byId.has(f.to));
  // препятствия: все фигуры и значки документов над задачами (у них нет id: они никогда не бывают концом стрелки)
  const obstacles = [...nodes.map((n) => ({ id: n.id, box: n.box })), ...extraObstacles.map((box, i) => ({ id: `\u0002obstacle${i}`, box }))];
  const ctxOf = (f: RouteFlow): Ctx => ({ obstacles, from: f.from, to: f.to });

  const exits = (f: RouteFlow): Side[] => {
    const from = byId.get(f.from)!;
    if (f.message) return [from.type === "pool" ? "T" : "B"];
    if (from.boundary) return ["B"];
    return ["R", "B", "T", "L"];
  };
  const entries = (f: RouteFlow): Side[] => {
    const to = byId.get(f.to)!;
    if (f.message) return [to.type === "pool" ? "T" : "B"];
    return ["L", "B", "T", "R"];
  };

  // сначала стрелки с жёсткими сторонами, затем остальные в порядке модели
  const order = [...list].sort((a, b) => Number(!!b.message || !!byId.get(b.from)!.boundary) - Number(!!a.message || !!byId.get(a.from)!.boundary));
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
  const farKey = (side: Side, other: RouteNode) => (side === "L" || side === "R" ? other.box.y + other.box.h / 2 : other.box.x + other.box.w / 2);
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
      if (g.from === node.id && c.e === side) items.push({ key: farKey(side, byId.get(g.to)!), end: "out" });
      if (g.to === node.id && c.n === side) items.push({ key: farKey(side, byId.get(g.from)!), end: "in" });
    }
    items.push({ key: farKey(side, other), end, self: true });
    items.sort(bySlot);
    return fracAt(node, items.length, items.findIndex((s) => s.self));
  };

  const choose = (f: RouteFlow): Choice | null => {
    const from = byId.get(f.from)!;
    const to = byId.get(f.to)!;
    let best: { cost: number; choice: Choice } | null = null;
    for (const e of exits(f)) {
      for (const n of entries(f)) {
        // маршрут оценивается с той точкой порта, которую стрелка реально получит на этой стороне рядом с соседями
        const p = portPoint(from.box, from.type, e, fracIfAdded(from, e, f, "out", to));
        const q = portPoint(to.box, to.type, n, fracIfAdded(to, n, f, "in", from));
        const built = build(p, e, q, n, ctxOf(f));
        if (!built) continue;
        // проход сквозь фигуру хуже общего порта, поэтому штраф за него больше штрафа за занятый порт
        let cost = 10 * (built.pts.length - 2) + length(built.pts) / 50 + 1500 * built.hits + sidePref(from, e, "out") + sidePref(to, n, "in");
        cost += occupancyCost(from, used(f.from, e, f.id)) + occupancyCost(to, used(f.to, n, f.id));
        // ветка шлюза на другой уровень по соглашению уходит из верхней или нижней вершины, а не справа
        if (from.type === "gateway" && e === "R" && Math.abs(q[1] - p[1]) > 30) cost += 8;
        const mine = fixedSegs(built.pts, built.channel);
        for (const [fid, c] of chosen) {
          if (fid === f.id) continue;
          cost += 6 * crossingCount(built.pts, c.pts) + (crossedZ(built.pts, c.pts) ? 300 : 0);
          // наложение на неподвижный участок чужой стрелки: средние каналы разводятся потом, а такие участки сдвинуть нельзя
          const theirs = fixedSegs(c.pts, c.channel);
          for (const s of mine) for (const t of theirs) if (clash(s, t)) cost += 120;
        }
        if (!best || cost < best.cost - 1e-9) best = { cost, choice: { e, n, pts: built.pts, channel: built.channel } };
      }
    }
    return best?.choice ?? null;
  };

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
        const k = `${node.id}\u0001${side}`; // разделитель, которого нет в id (в id пулов есть двоеточие)
        sides.set(k, [...(sides.get(k) ?? []), { fid: f.id, end, key: farKey(side, other) }]);
      }
    }
    for (const [k, items] of sides) {
      const node = byId.get(k.split("\u0001")[0])!;
      items.sort(bySlot);
      items.forEach((it, i) => out.set(`${it.fid}:${it.end}`, fracAt(node, items.length, i)));
    }
    portFrac = out;
  };

  for (const f of order) {
    const c = choose(f);
    if (c) chosen.set(f.id, c);
  }
  // уточнение: каждая стрелка пересматривает выбор, зная выбор остальных и реальные положения портов
  for (let pass = 0; pass < 4; pass++) {
    spreadPorts();
    let changed = false;
    for (const f of order) {
      const c = choose(f);
      const prev = chosen.get(f.id);
      if (c && (!prev || prev.e !== c.e || prev.n !== c.n)) {
        chosen.set(f.id, c);
        changed = true;
      }
    }
    if (!changed) break;
  }
  spreadPorts();

  const routes = new Map<string, { pts: Pt[]; channel?: Channel; hits: number }>();
  for (const f of list) {
    const c = chosen.get(f.id);
    if (!c) continue;
    const from = byId.get(f.from)!;
    const to = byId.get(f.to)!;
    const p = portPoint(from.box, from.type, c.e, portFrac.get(`${f.id}:out`) ?? 0.5);
    const q = portPoint(to.box, to.type, c.n, portFrac.get(`${f.id}:in`) ?? 0.5);
    const built = build(p, c.e, q, c.n, ctxOf(f)) ?? build(portPoint(from.box, from.type, c.e, 0.5), c.e, portPoint(to.box, to.type, c.n, 0.5), c.n, ctxOf(f));
    if (built) routes.set(f.id, built);
  }

  // каналы: средний отрезок Z- и П-образных стрелок подбирается так, чтобы вся ломаная (а не только канал: вместе с ним
  // меняются длины соседних отрезков) не ложилась на уже проложенные линии
  const allSegs = (pts: Pt[]) => pts.slice(0, -1).map((p, i) => seg(p, pts[i + 1]));
  const placed: Seg[] = [];
  for (const [, r] of routes) if (!r.channel) placed.push(...allSegs(r.pts));
  for (const f of list) {
    const r = routes.get(f.id);
    if (!r?.channel) continue;
    const ch = r.channel;
    const base = ch.axis === "x" ? r.pts[1][0] : r.pts[1][1];
    const candidates = ch.outward ? Array.from({ length: 14 }, (_, k) => base + k * STEP * ch.outward!) : around(base, ch.lo, ch.hi, 30);
    const withAt = (c: number): Pt[] => r.pts.map((p, i) => (i === 1 || i === 2 ? (ch.axis === "x" ? [c, p[1]] : [p[0], c]) : p) as Pt);
    let pick = base;
    for (const c of candidates) {
      const pts = withAt(c);
      if (allSegs(pts).some((s) => placed.some((o) => clash(s, o)))) continue;
      if (hitsOf(pts, ctxOf(f)) > r.hits) continue;
      pick = c;
      break;
    }
    r.pts = withAt(pick);
    placed.push(...allSegs(r.pts));
  }
  const out = new Map<string, Pt[]>();
  for (const f of list) {
    const r = routes.get(f.id);
    if (r) out.set(f.id, simplify(r.pts));
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