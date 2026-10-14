import type { ProcessFlow, ProcessLogicModel, ProcessNode } from "../../types";
import { MIN_EVALUATIONS, evaluationsFor, fixedRoute, routeFlowsDetailed, routeQuality } from "@shared/bpmnRouting";
import { rankColumns } from "@shared/bpmnRank";
import { ROW_PITCH, branchRows, collinearOverlaps } from "@shared/bpmnRows";
import { diagramTriggers, type TriggerView } from "@shared/bpmnTriggers";
import type { Pt } from "../editor-core/hooks";
import { LANE_H, MIN_LANE_H, MIN_X, START_Y, clampLaneHeight, laneHeightOf, laneTops, sizeOf, type Box } from "@shared/bpmnGeometry";
import { mergeScope, scopeView } from "@shared/scope";
import { POOL_H, artifactObstacle, artifactsOf, isStoreArtifact, boundaryBoxes, isBoundaryNode, messageEdges, poolBoxes, type Artifact } from "@shared/bpmnArtifacts";

// Размеры фигур, дорожки и маршрутизация стрелок — общий модуль server/src/shared/bpmnGeometry.ts
// (им же пользуется генератор BPMN), поэтому экспорт совпадает с нарисованным в редакторе.
export { SIZE, LANE_H, MIN_LANE_H, MAX_LANE_H, START_Y, LANE_X, LABEL_W, MIN_X, LABEL_CHARS, LABEL_LINES, sizeOf, waypoints, flowLabelPoint, wrapText } from "@shared/bpmnGeometry";
export type { Box, EndKinds } from "@shared/bpmnGeometry";
export type { Pt };

export const GRID = 10;
const COL_W = 190;

/**
 * Свёртка триггеров диаграммы (shared/bpmnTriggers.ts): ожидающие события, ведущие прямо в блок действия, рисуются значками
 * на блоке, без фигуры и стрелки «событие → блок». Модель неизменна, поэтому результат кэшируется по ней.
 */
const triggerCache = new WeakMap<ProcessLogicModel, TriggerView<ProcessFlow>>();
export function triggerView(m: ProcessLogicModel): TriggerView<ProcessFlow> {
  let v = triggerCache.get(m);
  if (!v) {
    const base = m.nodes.filter((n) => !n.idef0_parent && !n.bpmn_scope);
    const ids = new Set(base.map((n) => n.id));
    v = diagramTriggers(base, m.flows.filter((f) => ids.has(f.from) && ids.has(f.to)));
    triggerCache.set(m, v);
  }
  return v;
}

/** Узлы диаграммы процесса: вложенные функции IDEF0 (idef0_parent) в BPMN не показываются, как и свёрнутые в значки триггеры. */
export const visibleNodes = (m: ProcessLogicModel) => {
  const hidden = triggerView(m).hidden;
  return m.nodes.filter((n) => !n.idef0_parent && !n.bpmn_scope && !hidden.has(n.id));
};

/** Стрелки диаграммы: без «событие → блок»; «X → событие» ведёт в блок (та же стрелка модели). */
export const visibleFlows = (m: ProcessLogicModel) => triggerView(m).flows;

export const snap = (v: number) => Math.round(v / GRID) * GRID;

/**
 * Верх фигуры высотой h так, чтобы её центр лёг на сетку в 5 px. Привязка по центру, а не по верху: задача (80), шлюз (50)
 * и событие (36) в одном ряду получают общую линию центров, и стрелки между ними идут прямо, без «ступенек».
 */
export const snapTop = (y: number, h: number) => Math.round((y + h / 2) / 5) * 5 - h / 2;

export function boxOf(n: ProcessNode): Box {
  const s = sizeOf(n);
  return { x: n.layout?.x ?? MIN_X, y: n.layout?.y ?? START_Y, w: s.w, h: s.h };
}

/** Рамки фигур диаграммы; граничные события стоят на нижней границе своей задачи — их положение не хранится. */
export function boxMap(nodes: ProcessNode[]): Map<string, Box> {
  const out = new Map(nodes.map((n) => [n.id, boxOf(n)] as const));
  for (const [id, b] of boundaryBoxes(nodes, out)) out.set(id, b);
  return out;
}

/** Граничное событие, прикреплённое к существующей задаче этой диаграммы. */
export const isBoundary = (n: ProcessNode, nodes: ProcessNode[]) => isBoundaryNode(n, nodes);

/** Верх полосы свёрнутых внешних пулов — под дорожками. */
export const poolsTop = (m: ProcessLogicModel) => lanesBottom(m) + 30;

/**
 * Добавочные элементы диаграммы, положение которых выводится из шагов: документы и хранилища данных у задач,
 * свёрнутые внешние пулы под дорожками и потоки сообщений к ним (общая геометрия с генератором BPMN).
 */
export function diagramExtras(m: ProcessLogicModel, shown: ProcessNode[], boxes: Map<string, Box>) {
  const messages = (m.messages ?? []).filter((x) => boxes.has(x.from) || boxes.has(x.to));
  const artifacts: Artifact[] = artifactsOf(shown, boxes, { data: new Map(m.data.map((d) => [d.id, d.name])), systems: new Map(m.systems.map((s) => [s.id, s.name])) }, new Set(messages.flatMap((x) => [x.from, x.to])));
  const rects = poolBoxes(m.pools ?? [], messages, boxes, poolsTop(m));
  const pools = (m.pools ?? []).flatMap((p) => (rects.has(p.id) ? [{ pool: p, box: rects.get(p.id)! }] : []));
  return { artifacts, pools, messages: messageEdges(messages, boxes, rects) };
}

/** Ширина, которой хватает фигурам и внешним пулам: самая правая из них с отступом (но не меньше 900). */
export function contentWidth(m: ProcessLogicModel): number {
  let maxX = 900;
  const shown = visibleNodes(m);
  const boxes = boxMap(shown);
  for (const b of boxes.values()) maxX = Math.max(maxX, b.x + b.w + 120);
  const { pools } = diagramExtras(m, shown, boxes);
  for (const p of pools) maxX = Math.max(maxX, p.box.x + p.box.w + 60);
  return maxX;
}

/** Ширина дорожек, заданная пользователем для показанной диаграммы (в виде области она под ключом ""); без настройки — undefined. */
export const configuredWidth = (m: ProcessLogicModel): number | undefined => m.diagram_widths?.[""];

/**
 * Ширина дорожек (правый край): заданная пользователем, но не меньше нужной фигурам; без настройки — по содержимому, но не
 * меньше 1400 (чтобы на пустой диаграмме было место для новых фигур).
 */
export function diagramWidth(m: ProcessLogicModel): number {
  const content = contentWidth(m);
  const set = configuredWidth(m);
  return set === undefined ? Math.max(content, 1400) : Math.max(content, set);
}

/** Размер «мира» диаграммы: ширина по самой правой фигуре или заданная, высота по высотам дорожек (и полосе внешних пулов). */
export function modelExtents(m: ProcessLogicModel): { w: number; h: number } {
  const { pools } = diagramExtras(m, visibleNodes(m), boxMap(visibleNodes(m)));
  const set = configuredWidth(m);
  // пул, оттянутый вниз, увеличивает высоту «мира»
  const poolsBottom = pools.reduce((mx, p) => Math.max(mx, p.box.y + p.box.h + 20), 0);
  return { w: set === undefined ? contentWidth(m) : diagramWidth(m), h: Math.max(lanesBottom(m) + 20 + (pools.length > 0 ? 30 + POOL_H + 20 : 0), poolsBottom) };
}

/** Дорожек на одну больше числа ролей: последняя — «Без исполнителя». */
export const laneCount = (m: ProcessLogicModel) => m.roles.length + 1;
/** Высоты дорожек сверху вниз: у роли — lane_height, у «Без исполнителя» — настройка процесса; без настройки — стандартная. */
export const laneHeights = (m: ProcessLogicModel): number[] => [...m.roles.map((r) => laneHeightOf(r.lane_height)), laneHeightOf(m.process.unassigned_lane_height)];
export const laneTop = (m: ProcessLogicModel, i: number): number => laneTops(laneHeights(m))[i] ?? START_Y;
export const laneHeight = (m: ProcessLogicModel, i: number): number => laneHeights(m)[i] ?? LANE_H;
/** Нижняя граница последней дорожки. */
export const lanesBottom = (m: ProcessLogicModel): number => START_Y + laneHeights(m).reduce((s, h) => s + h, 0);

export function laneIndexOfRole(m: ProcessLogicModel, roleId: string | null | undefined): number {
  const i = roleId ? m.roles.findIndex((r) => r.id === roleId) : -1;
  return i >= 0 ? i : m.roles.length;
}

export function laneIndexAtY(m: ProcessLogicModel, y: number): number {
  const tops = laneTops(laneHeights(m));
  let i = 0;
  while (i + 1 < tops.length && y >= tops[i + 1]) i++;
  return i;
}

export function roleIdOfLane(m: ProcessLogicModel, laneIndex: number): string | null {
  return m.roles[laneIndex]?.id ?? null;
}

/** Удерживает фигуру целиком внутри дорожки и правее подписи дорожки. */
export function clampIntoLane(m: ProcessLogicModel, n: Pick<ProcessNode, "type">, x: number, y: number, laneIndex: number): Pt {
  const s = sizeOf(n);
  const top = laneTop(m, laneIndex);
  return [Math.max(MIN_X, x), Math.min(Math.max(y, top + 4), top + laneHeight(m, laneIndex) - s.h - 4)];
}

export function labelPoint(pts: Pt[]): Pt {
  const i = Math.floor((pts.length - 1) / 2);
  return [(pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2];
}

/** Разложение диаграммы по столбцам (rank) и дорожкам: основа и авто-раскладки, и её подбора. */
interface Ranked {
  shown: ProcessNode[];
  /** Столбец фигуры: длиннейший путь от начала (петли игнорируются), две фигуры в одной ячейке «столбец × дорожка» не допускаются. */
  rank: Map<string, number>;
  laneOf: Map<string, number>;
  /** Верх и высота каждой дорожки: по ним фигуры встают в центр своей дорожки. */
  lanes: { tops: number[]; heights: number[] };
  /** Прямые (без петель) связи между показанными фигурами. */
  fwd: Map<string, string[]>;
  preds: Map<string, string[]>;
}

function rankLayout(m: ProcessLogicModel): Ranked {
  const all = visibleNodes(m);
  // граничное событие в раскладке — продолжение своей задачи: его стрелки идут «от задачи», а места оно не занимает
  const hostOf = new Map(all.filter((n) => isBoundary(n, all)).map((n) => [n.id, n.attached_to!] as const));
  const shown = all.filter((n) => !hostOf.has(n.id));
  const laneOf = new Map(shown.map((n) => [n.id, laneIndexOfRole(m, n.role_id)] as const));
  const edges = visibleFlows(m).map((f) => ({ from: hostOf.get(f.from) ?? f.from, to: f.to }));
  const { rank, fwd, preds } = rankColumns({ ids: shown.map((n) => n.id), lane: laneOf, edges });
  const heights = laneHeights(m);
  return { shown, rank, laneOf, lanes: { tops: laneTops(heights), heights }, fwd, preds };
}
function placeRanks({ shown, laneOf, lanes }: Ranked, rank: Map<string, number>): Map<string, { x: number; y: number }> {
  const result = new Map<string, { x: number; y: number }>();
  for (const n of shown) {
    const s = sizeOf(n);
    const cx = MIN_X + 60 + (rank.get(n.id) ?? 0) * COL_W;
    result.set(n.id, { x: snap(cx - s.w / 2), y: lanes.tops[laneOf.get(n.id)!] + (lanes.heights[laneOf.get(n.id)!] - s.h) / 2 }); // центры — на одной линии
  }
  return result;
}

/**
 * Авто-раскладка слева направо: столбец = длиннейший путь от начала (петли
 * игнорируются), строка = дорожка роли. Две фигуры в одной ячейке не допускаются.
 */
export function autoLayout(m: ProcessLogicModel): Map<string, { x: number; y: number }> {
  const ranked = rankLayout(m);
  return placeRanks(ranked, ranked.rank);
}

/**
 * Та же раскладка, но с подбором: фигуре с запасом по времени разрешается встать столбцом позже, две фигуры одной дорожки
 * могут поменяться местами. Вариант принимается, если стрелки пересекаются меньше (и реже идут сквозь фигуры) — оценка по
 * настоящей прокладке редактора (diagramLayout), так что учитываются документы над задачами, граничные события и значки.
 * Число проверяемых вариантов зависит только от размера диаграммы (shared/bpmnRouting.ts: evaluationsFor), поэтому результат
 * воспроизводим, а кнопка не подвисает на больших схемах. Исходная раскладка — запасной вариант: хуже неё результат не бывает.
 */
export function optimizedLayout(m: ProcessLogicModel): Map<string, { x: number; y: number }> {
  return optimizedLayoutWithRows(m).positions;
}

/** Модель с заданными высотами дорожек (роли — lane_height, «Без исполнителя» — настройка процесса). */
const withLaneHeights = (m: ProcessLogicModel, heights: number[]): ProcessLogicModel => ({
  ...m,
  roles: m.roles.map((r, i) => ({ ...r, lane_height: heights[i] ?? r.lane_height })),
  process: { ...m.process, unassigned_lane_height: heights[m.roles.length] ?? m.process.unassigned_lane_height },
});

/**
 * Авто-раскладка с подбором (optimizedLayout) и рядами веток внутри дорожки (shared/bpmnRows.ts), как у серверной раскладки:
 * из трёх вариантов — без рядов, первая ветка вниз, первая вверх, а также со сжатием столбцов — берётся тот, у которого
 * стрелки лучше. Дорожки при этом могут стать выше: тогда возвращаются и их новые высоты (laneHeights), иначе null.
 */
export function optimizedLayoutWithRows(m: ProcessLogicModel): { positions: Map<string, { x: number; y: number }>; laneHeights: number[] | null } {
  const ranked = rankLayout(m);
  const start = placeRanks(ranked, ranked.rank);
  const flowCount = visibleFlows(m).length;
  const maxEvals = evaluationsFor(flowCount);
  if (ranked.shown.length < 4 || flowCount < 3 || maxEvals < MIN_EVALUATIONS) return { positions: start, laneHeights: null };

  const score = (rank: Map<string, number>): number => {
    const pos = placeRanks(ranked, rank);
    const candidate: ProcessLogicModel = { ...m, nodes: m.nodes.map((n) => (pos.has(n.id) ? { ...n, layout: pos.get(n.id)! } : n)) };
    const d = diagramLayout(candidate);
    const nodes = d.shown.map((n) => ({ id: n.id, type: n.type, box: d.boxes.get(n.id)!, label: n.name }));
    const q = routeQuality(nodes, d.flows.map((f) => ({ id: f.id, from: f.from, to: f.to })), d.routes, d.extras.artifacts.map(artifactObstacle));
    return q.crossings * 10 + q.cuts * 40 + q.labels * 6 + q.labelClash * 8 + q.length / 400;
  };

  let rank = ranked.rank;
  let best = score(rank);
  let evals = 1;
  const cell = (r: Map<string, number>, id: string) => `${r.get(id)}:${ranked.laneOf.get(id)}`;
  const tryRank = (next: Map<string, number>): boolean => {
    if (evals >= maxEvals) return false;
    evals++;
    const s = score(next);
    if (s < best - 1e-9) {
      rank = next;
      best = s;
      return true;
    }
    return false;
  };

  for (let pass = 0; pass < 3 && evals < maxEvals && best > 0.5; pass++) {
    let improved = false;
    // 1. фигура с запасом сдвигается на столбец позже (не дальше столбца своих преемников), если ячейка свободна
    const occupied = new Set(ranked.shown.map((n) => cell(rank, n.id)));
    for (const n of ranked.shown) {
      const r = rank.get(n.id) ?? 0;
      const succ = ranked.fwd.get(n.id) ?? [];
      if (succ.length === 0 || !succ.every((s) => (rank.get(s) ?? 0) > r + 1)) continue;
      const key = `${r + 1}:${ranked.laneOf.get(n.id)}`;
      if (occupied.has(key)) continue;
      const next = new Map(rank).set(n.id, r + 1);
      if (tryRank(next)) {
        improved = true;
        occupied.delete(cell(rank, n.id));
        occupied.add(key);
      }
    }
    // 2. две фигуры одной дорожки меняются столбцами, если порядок «до/после» относительно связей не нарушается
    const byLane = new Map<number, string[]>();
    for (const n of ranked.shown) byLane.set(ranked.laneOf.get(n.id)!, [...(byLane.get(ranked.laneOf.get(n.id)!) ?? []), n.id]);
    for (const ids of byLane.values()) {
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const [a, b] = [ids[i], ids[j]];
          const [ra, rb] = [rank.get(a) ?? 0, rank.get(b) ?? 0];
          const swapped = new Map(rank).set(a, rb).set(b, ra);
          const fits = (id: string) => (ranked.preds.get(id) ?? []).every((p) => (swapped.get(p) ?? 0) < (swapped.get(id) ?? 0)) && (ranked.fwd.get(id) ?? []).every((s) => (swapped.get(s) ?? 0) > (swapped.get(id) ?? 0));
          if (ra !== rb && fits(a) && fits(b) && tryRank(swapped)) improved = true;
        }
      }
    }
    if (!improved) break;
  }
  const plain = placeRanks(ranked, rank);

  // ряды веток шлюза: варианты оцениваются той же прокладкой стрелок, что и подбор столбцов
  const scoreModel = (candidate: ProcessLogicModel): number => {
    const d = diagramLayout(candidate);
    const nodes = d.shown.map((n) => ({ id: n.id, type: n.type, box: d.boxes.get(n.id)!, label: n.name }));
    const q = routeQuality(nodes, d.flows.map((f) => ({ id: f.id, from: f.from, to: f.to })), d.routes, d.extras.artifacts.map(artifactObstacle));
    return q.crossings * 10 + q.cuts * 40 + q.labels * 6 + q.labelClash * 8 + q.length / 400 + collinearOverlaps(d.routes) * 60;
  };
  const withPositions = (base: ProcessLogicModel, pos: Map<string, { x: number; y: number }>): ProcessLogicModel => ({ ...base, nodes: base.nodes.map((n) => (pos.has(n.id) ? { ...n, layout: pos.get(n.id)! } : n)) });
  const rowNodes = ranked.shown.map((n) => ({ id: n.id, laneIndex: ranked.laneOf.get(n.id)!, type: n.type }));
  const rowEdges = [...ranked.fwd].flatMap(([u, vs]) => vs.map((v) => ({ from: u, to: v })));
  const baseHeights = ranked.lanes.heights;
  let bestPos = plain;
  let bestHeights: number[] | null = null;
  let bestScore = scoreModel(withPositions(m, plain));
  const xOf = new Map([...plain].map(([id, p]) => [id, { x: p.x }] as const));
  for (const compress of [false, true]) {
    for (const firstDown of [true, false]) {
      const rows = branchRows(rowNodes, rowEdges, xOf, firstDown);
      if (rows.size === 0) continue;
      const span = new Map<number, [number, number]>();
      for (const n of rowNodes) {
        const r = rows.get(n.id) ?? 0;
        const [lo, hi] = span.get(n.laneIndex) ?? [0, 0];
        span.set(n.laneIndex, [Math.min(lo, r), Math.max(hi, r)]);
      }
      const heights = baseHeights.map((h, i) => {
        const [lo, hi] = span.get(i) ?? [0, 0];
        return clampLaneHeight(Math.max(h, LANE_H + (hi - lo) * ROW_PITCH));
      });
      const rank2 = compress
        ? rankColumns({ ids: ranked.shown.map((n) => n.id), lane: new Map(rowNodes.map((n) => [n.id, n.laneIndex * 100 + (rows.get(n.id) ?? 0) + 50] as const)), edges: rowEdges }).rank
        : rank;
      const tops = laneTops(heights);
      const pos = new Map<string, { x: number; y: number }>();
      for (const n of ranked.shown) {
        const s = sizeOf(n);
        const lane = ranked.laneOf.get(n.id)!;
        const [lo, hi] = span.get(lane) ?? [0, 0];
        const cx = MIN_X + 60 + (rank2.get(n.id) ?? 0) * COL_W;
        pos.set(n.id, { x: snap(cx - s.w / 2), y: snap(tops[lane] + (heights[lane] - s.h) / 2 + ((rows.get(n.id) ?? 0) - (lo + hi) / 2) * ROW_PITCH) });
      }
      const candidate = withPositions(withLaneHeights(m, heights), pos);
      const widthGain = compress ? (Math.max(...[...plain].map(([, p]) => p.x)) - Math.max(...[...pos].map(([, p]) => p.x))) / 100 : 0;
      const sc = scoreModel(candidate) - Math.max(0, widthGain) * 10;
      if (sc < bestScore - 1e-9) (bestScore = sc, bestPos = pos, bestHeights = heights);
    }
  }
  return { positions: bestPos, laneHeights: bestHeights };
}
/**
 * Позиции фигур из BPMN, сгенерированного сервером (раскладка ELK): id узла → левый верхний угол.
 * Редактор начинает с них, поэтому без ручных правок показывает ту же диаграмму, что и экспорт.
 */
export function positionsFromBpmnXml(xml: string | null | undefined): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  if (!xml) return out;
  for (const m of xml.matchAll(/<bpmndi:BPMNShape id="Node_(.+?)_di"[^>]*>\s*<dc:Bounds x="(-?[\d.]+)" y="(-?[\d.]+)"/g)) {
    out.set(m[1], { x: Number(m[2]), y: Number(m[3]) });
  }
  return out;
}

/**
 * Достраивает layout узлам, у которых его нет: из раскладки сервера (seed), иначе — своей авто-раскладкой.
 * force — расставить все фигуры заново авто-раскладкой; optimize — с подбором по числу пересечений стрелок (optimizedLayout).
 */
export function withLayout(m: ProcessLogicModel, force = false, seed?: Map<string, { x: number; y: number }>, optimize = false): ProcessLogicModel {
  const all = visibleNodes(m);
  if (!force && all.every((n) => n.layout || isBoundary(n, all))) return m;
  const res = optimize && force ? optimizedLayoutWithRows(m) : { positions: autoLayout(m), laneHeights: null };
  const auto = res.positions;
  const pick = (id: string) => (!force && seed?.get(id)) || auto.get(id);
  const laid: ProcessLogicModel = { ...m, nodes: m.nodes.map((n) => (auto.has(n.id) && (force || !n.layout) ? { ...n, layout: pick(n.id)! } : n)) };
  // ряды веток сделали дорожки выше — высоты сохраняются в модели вместе с позициями
  return res.laneHeights ? withLaneHeights(laid, res.laneHeights) : laid;
}

/** Расставляет шаги диаграмм операций, у которых нет позиций (например, модель пришла с сервера или из импорта). */
export function withScopeLayouts(m: ProcessLogicModel): ProcessLogicModel {
  let out = m;
  for (const scope of new Set(m.nodes.map((n) => n.bpmn_scope).filter((s): s is string => !!s))) {
    const view = scopeView(out, scope);
    const laid = withLayout(view, false);
    if (laid !== view) out = mergeScope(out, laid, scope, view);
  }
  return out;
}

/**
 * Всё, что нужно нарисовать: фигуры, добавочные элементы (документы, пулы, сообщения), значки триггеров и маршруты ВСЕХ стрелок,
 * рассчитанные вместе (shared/bpmnRouting.ts): без общих портов и наложений. Общая функция редактора и просмотра.
 */
export function diagramLayout(m: ProcessLogicModel) {
  const shown = visibleNodes(m);
  const boxes = boxMap(shown);
  const extras = diagramExtras(m, shown, boxes);
  const tv = triggerView(m);
  const flows = tv.flows.filter((f) => boxes.has(f.from) && boxes.has(f.to));
  const withArtifacts = new Set(extras.artifacts.filter((a) => !isStoreArtifact(a)).map((a) => a.nodeId));
  const withStores = new Set(extras.artifacts.filter(isStoreArtifact).map((a) => a.nodeId));
  const poolIds = new Set(extras.pools.map((p) => p.pool.id));
  const end = (id: string) => (poolIds.has(id) ? `pool:${id}` : id);
  const info = routeFlowsDetailed(
    [...shown.map((n) => ({ id: n.id, box: boxes.get(n.id)!, type: n.type, boundary: isBoundary(n, shown), artifacts: withArtifacts.has(n.id), stores: withStores.has(n.id), label: n.name })), ...extras.pools.map((p) => ({ id: `pool:${p.pool.id}`, box: p.box, type: "pool" }))],
    [...flows.map((f) => ({ id: f.id, from: f.from, to: f.to, fixed: fixedRoute(f.route) })), ...extras.messages.map(({ message }) => ({ id: `msg:${message.id}`, from: end(message.from), to: end(message.to), message: true, fixed: fixedRoute(message.route) }))],
    extras.artifacts.map(artifactObstacle)
  );
  const routes = new Map([...info].map(([id, r]) => [id, r.pts] as const));
  // фигуры, у нижней вершины которых проходит стрелка: подпись таких фигур сдвигается левее линии
  const bottomUsed = new Set<string>();
  for (const f of flows) {
    const pts = routes.get(f.id);
    const a = boxes.get(f.from)!;
    const b = boxes.get(f.to)!;
    if (!pts) continue;
    if (Math.abs(pts[0][1] - (a.y + a.h)) < 0.5) bottomUsed.add(f.from);
    if (Math.abs(pts[pts.length - 1][1] - (b.y + b.h)) < 0.5) bottomUsed.add(f.to);
  }
  return { shown, boxes, extras, flows, markers: tv.markers, routes, info, bottomUsed };
}