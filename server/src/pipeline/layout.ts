import * as ElkNS from "elkjs";

// elkjs публикует CJS-модуль с default-совместимой формой; в NodeNext-режиме
// TS не всегда разрешает интероп автоматически, поэтому берём конструктор
// явно (как это делает сам bpmn-generator-подобный тулинг).
import { LANE_H, MAX_LANE_H, MIN_X, START_Y, laneTops, waypoints, type EndKinds } from "../shared/bpmnGeometry.js";
import { rankColumns } from "../shared/bpmnRank.js";
import { ROW_PITCH, branchRows, collinearOverlaps } from "../shared/bpmnRows.js";
import { MIN_EVALUATIONS, crossingCount, evaluationsFor, routeFlows, routeQuality, type RouteFlow, type RouteNode } from "../shared/bpmnRouting.js";

// бюджет перебора общий с редактором в браузере (shared/bpmnRouting.ts); здесь он нужен и тестам
export { MIN_EVALUATIONS, evaluationsFor };

const ElkCtor: new () => import("elkjs").ELK = (ElkNS as any).default ?? (ElkNS as any);

export interface LayoutNodeIn {
  id: string;
  width: number;
  height: number;
  laneIndex: number;
  /** Вид фигуры (task | subprocess | gateway | event): от него зависит прокладка стрелок при подборе раскладки. */
  type?: string;
  /** Название: у событий и шлюзов оно подписано под фигурой, и при подборе стрелки обходят подпись. */
  label?: string;
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
/** Что известно о диаграмме сверх фигур: значки данных (их обходят стрелки) и задачи, у которых верхняя (документы) или нижняя (хранилища) сторона занята. */
export type LayoutExtras = (boxes: Map<string, LayoutBox>) => {
  obstacles: { x: number; y: number; w: number; h: number }[];
  withArtifacts: Set<string>;
  /** Задачи, под которыми стоят хранилища данных: нижняя сторона занята. */
  withStores: Set<string>;
  /** Фигуры, которых нет в раскладке, но от которых идут стрелки (граничные события на нижней границе задач, свёрнутые внешние пулы). */
  extraNodes: RouteNode[];
  /** Стрелки, которых нет среди связей раскладки, но которые прокладываются вместе с ними (потоки сообщений к внешним пулам). */
  extraFlows?: RouteFlow[];
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
const START_X = MIN_X;

/** Дорожки диаграммы: верх и высота каждой (высоты настраиваются, дорожки идут сверху вниз без промежутков). */
export interface Lanes {
  tops: number[];
  heights: number[];
}
const lanesOf = (heights: number[]): Lanes => ({ tops: laneTops(heights), heights });

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
function placeBoxes(nodes: LayoutNodeIn[], rawX: Map<string, number>, rank: Map<string, number>, lanes: Lanes): Map<string, LayoutBox> {
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
    const laneY = lanes.tops[n.laneIndex] ?? START_Y;
    const y = laneY + ((lanes.heights[n.laneIndex] ?? LANE_H) - n.height) / 2 + stagger * 26;
    boxes.set(n.id, { x, y, width: n.width, height: n.height });
  }

  // Фигуры, заданные в редакторе, стоят на своих местах — остальные обходят их.
  for (const n of nodes) if (n.fixed) boxes.set(n.id, { x: n.fixed.x, y: n.fixed.y, width: n.width, height: n.height });

  // Фигуры одной дорожки не должны налезать друг на друга (две ветки шлюза попадают в один слой ELK):
  // идём слева направо и сдвигаем перекрывающуюся фигуру правее предыдущей; закреплённую фигуру не двигаем.
  const byLane = new Map<number, string[]>();
  for (const n of nodes) byLane.set(n.laneIndex, [...(byLane.get(n.laneIndex) ?? []), n.id]);
  for (const ids of byLane.values()) {
    ids.sort((a, b) => boxes.get(a)!.x - boxes.get(b)!.x);
    let right = -Infinity;
    for (const id of ids) {
      const b = boxes.get(id)!;
      if (!pinned.has(id) && b.x < right + 30) b.x = right + 30;
      right = Math.max(right, b.x + b.width);
    }
  }
  return boxes;
}

const defaultType = (n: LayoutNodeIn) => n.type ?? (n.width <= 40 ? "event" : n.width <= 50 ? "gateway" : "task");


/**
 * Подбор раскладки с меньшим числом пересечений стрелок при тех же дорожках. Дорожка вмещает ровно один ряд фигур, поэтому
 * ветки шлюза в одной дорожке встают друг за другом, и выбор влево-вправо решает, не пойдут ли стрелки к дальней ветке над
 * ближней. Из раскладки ELK пробуются два вида ходов: поменять порядок фигур одного слоя и сдвинуть фигуру, у которой есть
 * запас, на слой позже. Ход принимается, если прокладка стрелок стала лучше (пересечения, проходы сквозь фигуры, длина).
 * Исходный вариант всегда остаётся запасным — хуже прежнего результат не бывает.
 */
/** Ширина столбца раскладки по столбцам (как у кнопки «Расставить» в редакторе) и отступ первого столбца от левого края. */
const COLUMN_W = 190;
const COLUMN_X0 = 60 - 25;
/** До скольких стрелок подбор пробует перестановки, вставки и переносы фигур по столбцам (дальше — только сдвиги и порядок слоя). */
const EXTRA_MOVES_MAX_FLOWS = 40;
/** Больше узлов — без ELK, раскладкой по столбцам (на 500 узлах ELK занимал секунды и блокировал сервер). */
const ELK_MAX_NODES = 150;
/** Упаковка длинной цепочки: сколько столбцов пробуем в ряду. Меньше столбцов — уже диаграмма, но больше рядов. */
const PACK_COL_OPTIONS = [6, 8, 10, 12, 14];
/** Шаг рядов при упаковке: больше обычного ROW_PITCH, чтобы между рядами прошла стрелка возврата. */
const PACK_ROW_PITCH = 140;
/** Заворачивать начинаем, только если диаграмма уже этого (px): короткие схемы остаются как есть. */
const PACK_TRIGGER_W = 2400;
/** Упаковка принимается, только если диаграмма стала уже хотя бы на столько. */
const PACK_MIN_GAIN = 0.15;
/** Сколько лишних пересечений стрелок прощаем упаковке (стрелка возврата идёт через ряды). */
const PACK_EXTRA_CROSSINGS = 4;

/**
 * Раскладка по столбцам (shared/bpmnRank.ts): столбец — длиннейший путь от начала, строка — дорожка, в ячейке одна фигура. Ветки
 * шлюза в одной дорожке получают разные столбцы, а ELK ставит их в один слой и фигуры потом растаскиваются вправо — стрелки к
 * дальней ветке идут над ближней. Это второй исходный вариант подбора наряду с раскладкой ELK.
 */
function columnPlacement(nodes: LayoutNodeIn[], edges: LayoutEdgeIn[]): Placement {
  const lane = new Map(nodes.map((n) => [n.id, n.laneIndex] as const));
  const { rank } = rankColumns({ ids: nodes.map((n) => n.id), lane, edges: edges.map((e) => ({ from: e.from, to: e.to })) });
  return { rawX: new Map(nodes.map((n) => [n.id, COLUMN_X0 + (rank.get(n.id) ?? 0) * COLUMN_W] as const)), rank: new Map(nodes.map((n, i) => [n.id, i] as const)) };
}

async function improvePlacement(nodes: LayoutNodeIn[], edges: LayoutEdgeIn[], elkStart: Placement, lanes: Lanes, extras?: LayoutExtras): Promise<Placement> {
  const free = nodes.filter((n) => !n.fixed);
  const maxEvals = evaluationsFor(edges.length);
  // LAYOUT_SEARCH=0 выключает подбор (для сравнения и на случай жалоб на скорость)
  if (process.env.LAYOUT_SEARCH === "0" || nodes.length < 4 || edges.length < 3 || free.length < 2 || maxEvals < MIN_EVALUATIONS) return elkStart;

  const flows: RouteFlow[] = edges.map((e) => ({ id: e.id, from: e.viaBoundary ?? e.from, to: e.to }));
  // оценка варианта запоминается: «запутанные» фигуры текущего варианта берутся из уже сделанной прокладки, а не считаются заново
  const evaluated = new WeakMap<Placement, ReturnType<typeof evaluateOnce>>();
  const evaluate = (p: Placement) => {
    let e = evaluated.get(p);
    if (!e) evaluated.set(p, (e = evaluateOnce(p)));
    return e;
  };
  function evaluateOnce(p: Placement) {
    const boxes = placeBoxes(nodes, p.rawX, p.rank, lanes);
    const ex = extras?.(boxes);
    const routeNodes: RouteNode[] = nodes.map((n) => {
      const b = boxes.get(n.id)!;
      return { id: n.id, type: defaultType(n), box: { x: b.x, y: b.y, w: b.width, h: b.height }, artifacts: ex?.withArtifacts.has(n.id), stores: ex?.withStores.has(n.id), label: n.label };
    });
    const all = [...routeNodes, ...(ex?.extraNodes ?? [])];
    const allFlows = [...flows, ...(ex?.extraFlows ?? [])];
    const routes = routeFlows(all, allFlows, ex?.obstacles ?? []);
    const q = routeQuality(all, allFlows, routes, ex?.obstacles ?? []);
    // наложения стрелок (две линии идут по одной прямой) — такой же дефект, как и в выборе рядов ниже:
    // без этого слагаемого подбор мог «не видеть» дефект, который потом отбраковывал итоговый выбор
    return { value: q.crossings * 10 + q.cuts * 40 + q.labels * 6 + q.labelClash * 8 + q.length / 400 + collinearOverlaps(routes) * 400, routes, flows: allFlows };
  }
  const score = (p: Placement): number => evaluate(p).value;
  /** Фигуры, у которых есть пересекающиеся стрелки: именно их перестановки могут что-то дать. */
  const tangledNodes = (p: Placement): Set<string> => {
    const { routes, flows: all } = evaluate(p);
    const out = new Set<string>();
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const [a, b] = [routes.get(all[i].id), routes.get(all[j].id)];
        if (!a || !b || crossingCount(a, b) === 0) continue;
        for (const f of [all[i], all[j]]) (out.add(f.from), out.add(f.to));
      }
    }
    return out;
  };

  // два исходных варианта — раскладка ELK и раскладка по столбцам; дальше улучшается лучший из них
  const columns = columnPlacement(nodes, edges);
  const elkScore = score(elkStart);
  const columnScore = score(columns);
  // Ширина — часть замысла «как в Business Studio»: узкий вариант предпочитается, если он не хуже лучшего
  // по качеству больше чем на NARROW_TOLERANCE баллов (примерно 4 пересечения). Иначе остаётся лучший по качеству.
  const widthOf = (p: Placement): number => Math.max(0, ...[...placeBoxes(nodes, p.rawX, p.rank, lanes).values()].map((b) => b.x + b.width));
  const NARROW = 1800;
  const NARROW_TOLERANCE = 40;
  const options = [
    { p: elkStart, s: elkScore, w: widthOf(elkStart) },
    { p: columns, s: columnScore, w: widthOf(columns) },
  ].sort((a, b) => a.s - b.s);
  const fitting = options.filter((o) => o.w <= NARROW);
  const start = fitting.length && fitting[0].s <= options[0].s + NARROW_TOLERANCE ? fitting[0].p : options[0].p;

  const succ = new Map<string, string[]>();
  for (const e of edges) succ.set(e.from, [...(succ.get(e.from) ?? []), e.to]);
  const layers = [...new Set(start.rawX.values())].sort((a, b) => a - b);

  let cur = start;
  let curScore = Math.min(elkScore, columnScore);
  let evals = 2;
  // подбор синхронный и считает десятки прокладок: между вариантами отдаём управление, чтобы сервер отвечал другим запросам
  const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));
  const tryMove = async (next: Placement): Promise<boolean> => {
    if (evals >= maxEvals) return false;
    evals++;
    if (evals % 3 === 0) await yieldToLoop();
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
          if (await tryMove({ rawX: cur.rawX, rank })) improved = true;
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
      if (await tryMove({ rawX, rank: cur.rank })) improved = true;
    }
    // 3. две фигуры одной дорожки меняются столбцами; стрелки вперёд остаются стрелками вперёд
    // Новые ходы (3–5) перебирают пары и перестановки фигур — вариантов много, и на большой диаграмме они выбирают весь бюджет,
    // хотя прежние ходы заканчивались за долю секунды. Выигрыш они дали на небольших диаграммах, где и остаются.
    if (curScore > 0.5 && evals < maxEvals && edges.length <= EXTRA_MOVES_MAX_FLOWS) {
      const tangled = tangledNodes(cur);
      const laneOf = new Map(nodes.map((n) => [n.id, n.laneIndex] as const));
      // стрелка вперёд остаётся стрелкой вперёд; в одном столбце ей можно стоять только между разными дорожками (это вертикаль)
      const keepsForward = (rawX: Map<string, number>) =>
        edges.every((e) => {
          if ((cur.rawX.get(e.from) ?? 0) >= (cur.rawX.get(e.to) ?? 0)) return true;
          const [fx, tx] = [rawX.get(e.from) ?? 0, rawX.get(e.to) ?? 0];
          return fx < tx - 1 || (Math.abs(fx - tx) <= 1 && laneOf.get(e.from) !== laneOf.get(e.to));
        });
      const lanes = new Map<number, string[]>();
      for (const n of free) lanes.set(n.laneIndex, [...(lanes.get(n.laneIndex) ?? []), n.id]);
      for (const ids of lanes.values()) {
        for (let i = 0; i < ids.length; i++) {
          for (let j = i + 1; j < ids.length; j++) {
            const [a, b] = [ids[i], ids[j]];
            const [xa, xb] = [cur.rawX.get(a) ?? 0, cur.rawX.get(b) ?? 0];
            if (Math.abs(xa - xb) < 1 || (!tangled.has(a) && !tangled.has(b))) continue;
            const rawX = new Map(cur.rawX);
            rawX.set(a, xb);
            rawX.set(b, xa);
            if (keepsForward(rawX) && (await tryMove({ rawX, rank: cur.rank }))) improved = true;
          }
        }
      }
      // 5. вставка: запутанная фигура встаёт на другое место в порядке своей дорожки, остальные сдвигаются на освободившиеся
      // столбцы (набор столбцов дорожки не меняется). Так «Нет»-ветка шлюза оказывается рядом со шлюзом, а не дугой над соседями.
      insertion: for (const ids of lanes.values()) {
        const ordered = [...ids].sort((a, b) => (cur.rawX.get(a) ?? 0) - (cur.rawX.get(b) ?? 0));
        const slots = ordered.map((id) => cur.rawX.get(id) ?? 0);
        for (let i = 0; i < ordered.length; i++) {
          if (!tangled.has(ordered[i])) continue;
          for (let j = 0; j < ordered.length; j++) {
            if (j === i) continue;
            const order = ordered.slice();
            order.splice(j, 0, order.splice(i, 1)[0]);
            const rawX = new Map(cur.rawX);
            order.forEach((id, k) => rawX.set(id, slots[k]));
            if (keepsForward(rawX) && (await tryMove({ rawX, rank: cur.rank }))) {
              improved = true;
              break insertion; // порядок дорожки изменился: следующий проход начнёт с новых данных
            }
          }
        }
      }
      // 4. запутанная фигура переходит в любой другой столбец (а не только на следующий)
      for (const n of free) {
        if (!tangled.has(n.id)) continue;
        for (const layer of layers) {
          if (Math.abs(layer - (cur.rawX.get(n.id) ?? 0)) < 1) continue;
          const rawX = new Map(cur.rawX);
          rawX.set(n.id, layer);
          if (keepsForward(rawX) && (await tryMove({ rawX, rank: cur.rank }))) improved = true;
        }
      }
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
/** lanes — высоты дорожек сверху вниз (их число — число дорожек) или просто число дорожек стандартной высоты. */
export async function layoutLayered(nodes: LayoutNodeIn[], edges: LayoutEdgeIn[], laneSpec: number[] | number, extras?: LayoutExtras): Promise<LayoutResult> {
  const laneHeights = typeof laneSpec === "number" ? Array.from({ length: laneSpec }, () => LANE_H) : laneSpec;
  const lanes = lanesOf(laneHeights);
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
      .filter((e) => nodes.some((n) => n.id === e.from) && nodes.some((n) => n.id === e.to)) // до ELK_MAX_NODES узлов — дёшево
      .map((e) => ({ id: e.id, sources: [e.from], targets: [e.to] })),
  };

  const ids = new Set(nodes.map((n) => n.id));
  const edgeList = edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  let start: Placement;
  if (nodes.length > ELK_MAX_NODES) {
    // На больших схемах ELK (вертикаль которого всё равно заменяется дорожками) работает секунды и блокирует сервер,
    // а подбор вариантов там уже выключен: берём раскладку по столбцам — тот же второй исходный вариант, только сразу.
    start = columnPlacement(nodes, edgeList);
  } else {
    const result = await elk.layout(elkGraph as any);
    const elkX = new Map<string, number>();
    for (const child of result.children ?? []) elkX.set(child.id!, child.x ?? 0);
    start = { rawX: elkX, rank: new Map(nodes.map((n, i) => [n.id, i] as const)) };
  }
  const best = await improvePlacement(nodes, edgeList, start, lanes, extras);
  let boxes = placeBoxes(nodes, best.rawX, best.rank, lanes);

  // ветки шлюза — рядами внутри дорожки; дорожка растёт, чтобы вместить ряды. Из трёх вариантов (без рядов, первая ветвь вниз,
  // первая ветвь вверх) берётся тот, у которого стрелки лучше по той же оценке, что и при подборе столбцов.
  const flowsForScore: RouteFlow[] = edgeList.map((e) => ({ id: e.id, from: e.viaBoundary ?? e.from, to: e.to }));
  const scoreBoxes = (bx: Map<string, LayoutBox>): number => measure(bx).score;
  /** Та же оценка с раскладкой по частям: упаковке важно не добавить стрелок сквозь фигуры. */
  const measure = (bx: Map<string, LayoutBox>): { score: number; cuts: number; crossings: number; labelHits: number; collinear: number; length: number } => {
    const ex = extras?.(bx);
    const routeNodes: RouteNode[] = nodes.map((n) => {
      const b = bx.get(n.id)!;
      return { id: n.id, type: defaultType(n), box: { x: b.x, y: b.y, w: b.width, h: b.height }, artifacts: ex?.withArtifacts.has(n.id), stores: ex?.withStores.has(n.id), label: n.label };
    });
    const all = [...routeNodes, ...(ex?.extraNodes ?? [])];
    const allFlows = [...flowsForScore, ...(ex?.extraFlows ?? [])];
    const routes = routeFlows(all, allFlows, ex?.obstacles ?? []);
    const q = routeQuality(all, allFlows, routes, ex?.obstacles ?? []);
    const collinear = collinearOverlaps(routes);
    return { score: q.crossings * 10 + q.cuts * 40 + q.labels * 6 + q.labelClash * 8 + q.length / 400 + collinear * 400, cuts: q.cuts, crossings: q.crossings, labelHits: q.labels, collinear, length: q.length };
  };
  const withRows = (firstDown: boolean, compress: boolean): { boxes: Map<string, LayoutBox>; heights: number[] } | null => {
    const rows = branchRows(nodes, edgeList, boxes, firstDown);
    if (rows.size === 0 && !compress) return null;
    const heights = [...laneHeights];
    const span = new Map<number, [number, number]>();
    for (const n of nodes) {
      const r = rows.get(n.id) ?? 0;
      const [lo, hi] = span.get(n.laneIndex) ?? [0, 0];
      span.set(n.laneIndex, [Math.min(lo, r), Math.max(hi, r)]);
    }
    for (const [lane, [lo, hi]] of span) heights[lane] = Math.max(heights[lane], LANE_H + (hi - lo) * ROW_PITCH);
    // сжатие: ряд — отдельная «строка», поэтому ветка делит столбцы с основной линией (ячейка «столбец × дорожка × ряд»)
    let rawX = best.rawX;
    if (compress) {
      const lane = new Map(nodes.map((n) => [n.id, n.laneIndex * 100 + (rows.get(n.id) ?? 0) + 50] as const));
      const { rank } = rankColumns({ ids: nodes.map((n) => n.id), lane, edges: edgeList.map((e) => ({ from: e.from, to: e.to })), verticalFrom: new Set(nodes.filter((n) => n.type === "gateway").map((n) => n.id)) });
      rawX = new Map(nodes.map((n) => [n.id, COLUMN_X0 + (rank.get(n.id) ?? 0) * COLUMN_W] as const));
      for (const n of nodes) if (n.fixed) rawX.set(n.id, best.rawX.get(n.id) ?? 0);
    }
    const placed = placeBoxes(nodes, rawX, best.rank, lanesOf(heights));
    for (const n of nodes) {
      const b = placed.get(n.id)!;
      const [lo, hi] = span.get(n.laneIndex) ?? [0, 0];
      if (!n.fixed) b.y += ((rows.get(n.id) ?? 0) - (lo + hi) / 2) * ROW_PITCH;
    }
    return { boxes: placed, heights };
  };
  let heightsFinal = [...laneHeights];
  /**
   * Упаковка длинной цепочки: ряд шире PACK_TRIGGER_W заворачивается в несколько рядов внутри дорожки
   * (столбец = номер шага по модулю PACK_COLS, ряд = сколько раз по PACK_COLS уложилось). Дорожка растёт на ROW_PITCH
   * за каждый лишний ряд, чтобы фигуры не выходили за её границы. Пробуем только на длинных схемах и берём вариант,
   * если прокладка стрелок не стала заметно хуже: возврат с конца ряда в начало следующего — самый дорогой участок.
   */
  const packLongChain = (cols: number): { boxes: Map<string, LayoutBox>; heights: number[] } | null => {
    // ручные позиции не трогаем: если аналитик расставил фигуры сам, упаковка их сломает
    if (nodes.some((n) => n.fixed)) return null;
    const lane = new Map(nodes.map((n) => [n.id, n.laneIndex] as const));
    const { rank } = rankColumns({
      ids: nodes.map((n) => n.id),
      lane,
      edges: edgeList.map((e) => ({ from: e.from, to: e.to })),
      verticalFrom: new Set(nodes.filter((n) => n.type === "gateway").map((n) => n.id)),
    });
    const maxRank = Math.max(0, ...[...rank.values()]);
    if (maxRank < cols) return null; // заворачивать нечего: все шаги и так в один ряд
    const rowOf = new Map(nodes.map((n) => [n.id, Math.floor((rank.get(n.id) ?? 0) / cols)] as const));
    const maxRow = Math.max(0, ...[...rowOf.values()]);
    // все дорожки одной высоты, ряды идут сквозь диаграмму: стрелка возврата проходит в промежутке между рядами
    // и не задевает фигуры соседних дорожек
    const bandH = 90;
    const laneH = Math.max(...laneHeights, bandH + maxRow * PACK_ROW_PITCH + 60);
    if (laneH > MAX_LANE_H) return null;
    const heights = laneHeights.map(() => laneH);
    const tops = laneTops(heights);
    const top = (laneH - (bandH + maxRow * PACK_ROW_PITCH)) / 2;
    const boxes = new Map<string, LayoutBox>();
    for (const n of nodes) {
      const r = rank.get(n.id) ?? 0;
      const row = rowOf.get(n.id) ?? 0;
      const y0 = tops[n.laneIndex] ?? START_Y;
      boxes.set(n.id, {
        x: START_X + (r % cols) * COLUMN_W,
        y: y0 + top + row * PACK_ROW_PITCH + (bandH - n.height) / 2,
        width: n.width,
        height: n.height,
      });
    }
    return { boxes, heights };
  };

  if (process.env.LAYOUT_SEARCH !== "0" && nodes.length >= 4 && edgeList.length >= 3) {
    let bestScore = scoreBoxes(boxes);
    for (const compress of [false, true]) {
      for (const firstDown of [true, false]) {
        const cand = withRows(firstDown, compress);
        if (!cand) continue;
        // сжатая раскладка короче и ближе к Business Studio: ей прощаются несколько пересечений (за каждые 100 px ширины — одно)
        const widthGain = compress ? (Math.max(...[...boxes.values()].map((b) => b.x + b.width)) - Math.max(...[...cand.boxes.values()].map((b) => b.x + b.width))) / 100 : 0;
        const sc = scoreBoxes(cand.boxes) - Math.max(0, widthGain) * 10;
        if (sc < bestScore - 1e-9) (bestScore = sc, boxes = cand.boxes, heightsFinal = cand.heights);
      }
    }
  }
  // упаковка длинной цепочки — последней: ряды веток её не перебивают, она сама решает, лучше ли стала прокладка
  // (BPMN_PACK=0 отключает упаковку: так тест сравнивает раскладку с ней и без неё)
  if (process.env.LAYOUT_SEARCH !== "0" && process.env.BPMN_PACK !== "0") {
    const widthOfBoxes = (bx: Map<string, LayoutBox>) => Math.max(0, ...[...bx.values()].map((b) => b.x + b.width));
    const base = { w: widthOfBoxes(boxes), q: measure(boxes) };
    let best: { boxes: Map<string, LayoutBox>; heights: number[]; w: number; area: number } | null = null;
    // длинные схемы: короткие не трогаем, иначе упаковка переставляет то, что и так помещается
    for (const cols of base.w >= PACK_TRIGGER_W ? PACK_COL_OPTIONS : []) {
      const cand = packLongChain(cols);
      if (!cand) continue;
      const w = widthOfBoxes(cand.boxes);
      // сужение должно быть заметным, а прокладка — не хуже: ни одной новой стрелки сквозь фигуру и не больше PACK_EXTRA_CROSSINGS пересечений
      if (w > base.w * (1 - PACK_MIN_GAIN)) continue;
      const q = measure(cand.boxes);
      // прокладка не хуже: ни одной новой стрелки сквозь фигуру, ни новых задетых подписей и не больше PACK_EXTRA_CROSSINGS пересечений
      if (q.cuts > base.q.cuts || q.labelHits > base.q.labelHits || q.crossings > base.q.crossings + PACK_EXTRA_CROSSINGS) continue;
      const area = w * cand.heights.reduce((s, h) => s + h, 0);
      if (!best || area < best.area - 1e-6 || (Math.abs(area - best.area) < 1e-6 && w < best.w)) best = { ...cand, w, area };
    }
    if (best) {
      boxes = best.boxes;
      heightsFinal = best.heights;
    }
  }

  let maxRight = 0;
  for (const b of boxes.values()) maxRight = Math.max(maxRight, b.x + b.width);
  const totalWidth = maxRight + 80;
  const lanesOut = lanesOf(heightsFinal);
  const totalHeight = START_Y + heightsFinal.reduce((s, h) => s + h, 0) + 40;

  const laneBounds = heightsFinal.map((height, i) => ({ laneIndex: i, y: lanesOut.tops[i], height }));
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



