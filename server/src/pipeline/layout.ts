import * as ElkNS from "elkjs";

// elkjs публикует CJS-модуль с default-совместимой формой; в NodeNext-режиме
// TS не всегда разрешает интероп автоматически, поэтому берём конструктор
// явно (как это делает сам bpmn-generator-подобный тулинг).
import { LANE_H, MIN_X, START_Y, waypoints, type EndKinds } from "../shared/bpmnGeometry.js";
import { routeFlows, routeQuality, type RouteFlow, type RouteNode } from "../shared/bpmnRouting.js";

const ElkCtor: new () => import("elkjs").ELK = (ElkNS as any).default ?? (ElkNS as any);

export interface LayoutNodeIn {
  id: string;
  width: number;
  height: number;
  laneIndex: number;
  /** Вид фигуры (task | subprocess | gateway | event): от него зависит прокладка стрелок при подборе раскладки. */
  type?: string;
  /** Позиция, заданная в редакторе: фигура остаётся на месте, остальные подбираются вокруг неё. */
  fixed?: { x: number; y: number } | null;
}
export interface LayoutEdgeIn {
  id: string;
  from: string;
  to: string;
  /** Стрелка уходит от граничного события задачи (from — сама задача, для раскладки): при оценке прокладки она идёт от него. */
  viaBoundary?: string;
}
/** Что известно о диаграмме сверх фигур: значки документов над задачами (их обходят стрелки) и задачи, у которых верхняя сторона занята. */
export type LayoutExtras = (boxes: Map<string, LayoutBox>) => {
  obstacles: { x: number; y: number; w: number; h: number }[];
  withArtifacts: Set<string>;
  /** Фигуры, которых нет в раскладке, но от которых идут стрелки (граничные события на нижней границе задач). */
  extraNodes: RouteNode[];
};

export interface LayoutBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutResult {
  boxes: Map<string, LayoutBox>;
  laneBounds: { laneIndex: number; y: number; height: number }[];
  totalWidth: number;
  totalHeight: number;
}

// Дорожки начинаются с LANE_X, подпись дорожки занимает LABEL_W — фигуры начинаются правее (MIN_X).
const LANE_HEIGHT = LANE_H;
const START_X = MIN_X;

const elk = new ElkCtor();

/** Вариант раскладки: x слоя от ELK (его можно сдвинуть узлу на слой позже) и порядок узлов одного слоя в одной дорожке. */
interface Placement {
  rawX: Map<string, number>;
  rank: Map<string, number>;
}

/**
 * Ставит фигуры по дорожкам: слой ELK даёт x, дорожка — y. Фигуры одного слоя в одной дорожке идут ступенькой, а те, что
 * всё равно налезают друг на друга, сдвигаются вправо. Заданные в редакторе позиции остаются как есть.
 */
function placeBoxes(nodes: LayoutNodeIn[], rawX: Map<string, number>, rank: Map<string, number>): Map<string, LayoutBox> {
  const boxes = new Map<string, LayoutBox>();
  const occupied = new Map<string, number>(); // key `${roundedX}:${lane}` -> stagger count
  const pinned = new Set(nodes.filter((n) => n.fixed).map((n) => n.id));

  // Стабильный порядок узлов для детерминированного стаггера при коллизиях
  const order = [...nodes].sort((a, b) => (rawX.get(a.id) ?? 0) - (rawX.get(b.id) ?? 0) || (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));

  for (const n of order) {
    const x0 = rawX.get(n.id) ?? 0;
    const key = `${Math.round(x0 / 4)}:${n.laneIndex}`;
    const stagger = occupied.get(key) ?? 0;
    occupied.set(key, stagger + 1);

    const x = START_X + x0 + stagger * 40;
    const laneY = START_Y + n.laneIndex * LANE_HEIGHT;
    const y = laneY + (LANE_HEIGHT - n.height) / 2 + stagger * 26;
    boxes.set(n.id, { x, y, width: n.width, height: n.height });
  }

  // Фигуры одной дорожки не должны налезать друг на друга (две ветки шлюза попадают в один слой ELK):
  // идём слева направо и сдвигаем перекрывающуюся фигуру правее предыдущей.
  const byLane = new Map<number, string[]>();
  for (const n of nodes) if (!pinned.has(n.id)) byLane.set(n.laneIndex, [...(byLane.get(n.laneIndex) ?? []), n.id]);
  for (const ids of byLane.values()) {
    ids.sort((a, b) => boxes.get(a)!.x - boxes.get(b)!.x);
    let right = -Infinity;
    for (const id of ids) {
      const b = boxes.get(id)!;
      if (b.x < right + 30) b.x = right + 30;
      right = b.x + b.width;
    }
  }
  for (const n of nodes) if (n.fixed) boxes.set(n.id, { x: n.fixed.x, y: n.fixed.y, width: n.width, height: n.height });
  return boxes;
}

const defaultType = (n: LayoutNodeIn) => n.type ?? (n.width <= 40 ? "event" : n.width <= 50 ? "gateway" : "task");

/**
 * Сколько вариантов раскладки перебирается. Число считается по размеру диаграммы, а не по часам, поэтому результат не зависит
 * от скорости машины. Прокладка одного варианта растёт гораздо быстрее, чем число стрелок (замер: 100 стрелок — около 85 мс,
 * 150 — около 185 мс, то есть примерно в степени 3,5), поэтому на больших диаграммах вариантов меньше: бюджет делится на число
 * стрелок в этой степени (~0,5 с на диаграмму до 100 стрелок), а диаграммы от ~120 стрелок остаются как есть — подбор там не
 * окупается.
 */
const MAX_EVALUATIONS = 200;
const WORK_BUDGET = 70_000_000;
export const MIN_EVALUATIONS = 4;
export const evaluationsFor = (flows: number) => Math.min(MAX_EVALUATIONS, Math.floor(WORK_BUDGET / Math.pow(Math.max(flows, 1), 3.5)));

/**
 * Подбор раскладки с меньшим числом пересечений стрелок при тех же дорожках. Дорожка вмещает ровно один ряд фигур, поэтому
 * ветки шлюза в одной дорожке встают друг за другом, и выбор влево-вправо решает, не пойдут ли стрелки к дальней ветке над
 * ближней. Из раскладки ELK пробуются два вида ходов: поменять порядок фигур одного слоя и сдвинуть фигуру, у которой есть
 * запас, на слой позже. Ход принимается, если прокладка стрелок стала лучше (пересечения, проходы сквозь фигуры, длина).
 * Исходный вариант всегда остаётся запасным — хуже прежнего результат не бывает.
 */
function improvePlacement(nodes: LayoutNodeIn[], edges: LayoutEdgeIn[], start: Placement, extras?: LayoutExtras): Placement {
  const free = nodes.filter((n) => !n.fixed);
  const maxEvals = evaluationsFor(edges.length);
  // LAYOUT_SEARCH=0 выключает подбор (для сравнения и на случай жалоб на скорость)
  if (process.env.LAYOUT_SEARCH === "0" || nodes.length < 4 || edges.length < 3 || free.length < 2 || maxEvals < MIN_EVALUATIONS) return start;

  const flows: RouteFlow[] = edges.map((e) => ({ id: e.id, from: e.viaBoundary ?? e.from, to: e.to }));
  const score = (p: Placement): number => {
    const boxes = placeBoxes(nodes, p.rawX, p.rank);
    const ex = extras?.(boxes);
    const routeNodes: RouteNode[] = nodes.map((n) => {
      const b = boxes.get(n.id)!;
      return { id: n.id, type: defaultType(n), box: { x: b.x, y: b.y, w: b.width, h: b.height }, artifacts: ex?.withArtifacts.has(n.id) };
    });
    const all = [...routeNodes, ...(ex?.extraNodes ?? [])];
    const q = routeQuality(all, flows, routeFlows(all, flows, ex?.obstacles ?? []));
    return q.crossings * 10 + q.cuts * 40 + q.length / 400;
  };

  const succ = new Map<string, string[]>();
  for (const e of edges) succ.set(e.from, [...(succ.get(e.from) ?? []), e.to]);
  const layers = [...new Set(start.rawX.values())].sort((a, b) => a - b);

  let cur = start;
  let curScore = score(cur);
  let evals = 1;
  const tryMove = (next: Placement): boolean => {
    if (evals >= maxEvals) return false;
    evals++;
    const s = score(next);
    if (s < curScore - 1e-9) {
      cur = next;
      curScore = s;
      return true;
    }
    return false;
  };

  for (let pass = 0; pass < 3 && evals < maxEvals && curScore > 0.5; pass++) {
    let improved = false;
    // 1. порядок фигур одного слоя в одной дорожке
    const groups = new Map<string, string[]>();
    for (const n of free) {
      const key = `${Math.round((cur.rawX.get(n.id) ?? 0) / 4)}:${n.laneIndex}`;
      groups.set(key, [...(groups.get(key) ?? []), n.id]);
    }
    for (const ids of groups.values()) {
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const rank = new Map(cur.rank);
          rank.set(ids[i], cur.rank.get(ids[j])!);
          rank.set(ids[j], cur.rank.get(ids[i])!);
          if (tryMove({ rawX: cur.rawX, rank })) improved = true;
        }
      }
    }
    // 2. фигура с запасом по времени сдвигается на слой позже (не дальше слоя своих преемников)
    for (const n of free) {
      const x = cur.rawX.get(n.id) ?? 0;
      const next = layers.find((l) => l > x + 1);
      const after = (succ.get(n.id) ?? []).map((s) => cur.rawX.get(s) ?? 0).filter((sx) => sx > x + 1);
      if (next === undefined || after.length === 0 || !after.every((sx) => sx > next + 1)) continue;
      const rawX = new Map(cur.rawX);
      rawX.set(n.id, next);
      if (tryMove({ rawX, rank: cur.rank })) improved = true;
    }
    if (!improved) break;
  }
  return cur;
}
/**
 * Раскладка слева-направо на основе ElkJS (Sugiyama layered algorithm,
 * ФТ-6.2): ELK определяет ранжирование узлов по столбцам (топологическая
 * упорядоченность с минимизацией пересечений), а вертикальная позиция
 * внутри столбца переопределяется по дорожке-роли (swimlane), т.к.
 * дорожки — это семантика BPMN, которую сам ELK не знает.
 */
export async function layoutLayered(nodes: LayoutNodeIn[], edges: LayoutEdgeIn[], laneCount: number, extras?: LayoutExtras): Promise<LayoutResult> {
  const elkGraph = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.layered.spacing.nodeNodeBetweenLayers": "90",
      "elk.spacing.nodeNode": "36",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
    },
    children: nodes.map((n) => ({ id: n.id, width: n.width, height: n.height })),
    edges: edges
      .filter((e) => nodes.some((n) => n.id === e.from) && nodes.some((n) => n.id === e.to))
      .map((e) => ({ id: e.id, sources: [e.from], targets: [e.to] })),
  };

  const result = await elk.layout(elkGraph as any);
  const elkX = new Map<string, number>();
  for (const child of result.children ?? []) {
    elkX.set(child.id!, child.x ?? 0);
  }

  const edgeList = edges.filter((e) => nodes.some((n) => n.id === e.from) && nodes.some((n) => n.id === e.to));
  const start: Placement = { rawX: elkX, rank: new Map(nodes.map((n, i) => [n.id, i] as const)) };
  const best = improvePlacement(nodes, edgeList, start, extras);
  const boxes = placeBoxes(nodes, best.rawX, best.rank);

  let maxRight = 0;
  for (const b of boxes.values()) maxRight = Math.max(maxRight, b.x + b.width);
  const totalWidth = maxRight + 80;
  const totalHeight = START_Y + laneCount * LANE_HEIGHT + 40;

  const laneBounds = Array.from({ length: laneCount }, (_, i) => ({
    laneIndex: i,
    y: START_Y + i * LANE_HEIGHT,
    height: LANE_HEIGHT,
  }));
  return { boxes, laneBounds, totalWidth, totalHeight };
}

/**
 * Ортогональные точки перегиба стрелки между двумя прямоугольниками — общая функция
 * shared/bpmnGeometry.ts (её же использует редактор в браузере).
 */
export function orthogonalWaypoints(from: LayoutBox, to: LayoutBox, obstacles: LayoutBox[] = [], kinds: EndKinds = {}): [number, number][] {
  const box = (b: LayoutBox) => ({ x: b.x, y: b.y, w: b.width, h: b.height });
  return waypoints(box(from), box(to), obstacles.map(box), kinds);
}