import type { ProcessFlow, ProcessLogicModel, ProcessNode } from "../../types";
import { fixedRoute, routeFlowsDetailed } from "@shared/bpmnRouting";
import { collapseTriggers, type TriggerView } from "@shared/bpmnTriggers";
import type { Pt } from "../editor-core/hooks";
import { LANE_H, MIN_X, START_Y, sizeOf, type Box } from "@shared/bpmnGeometry";
import { mergeScope, scopeView } from "@shared/scope";
import { POOL_H, artifactsOf, boundaryBoxes, isBoundaryNode, messageEdges, poolBoxes, type Artifact } from "@shared/bpmnArtifacts";

// Размеры фигур, дорожки и маршрутизация стрелок — общий модуль server/src/shared/bpmnGeometry.ts
// (им же пользуется генератор BPMN), поэтому экспорт совпадает с нарисованным в редакторе.
export { SIZE, LANE_H, START_Y, LANE_X, LABEL_W, MIN_X, sizeOf, waypoints, flowLabelPoint } from "@shared/bpmnGeometry";
export type { Box, EndKinds } from "@shared/bpmnGeometry";
export type { Pt };

export const GRID = 10;
const COL_W = 170;

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
    v = collapseTriggers(base, m.flows.filter((f) => ids.has(f.from) && ids.has(f.to)));
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
export const poolsTop = (m: ProcessLogicModel) => laneTop(laneCount(m)) + 30;

/**
 * Добавочные элементы диаграммы, положение которых выводится из шагов: документы и хранилища данных у задач,
 * свёрнутые внешние пулы под дорожками и потоки сообщений к ним (общая геометрия с генератором BPMN).
 */
export function diagramExtras(m: ProcessLogicModel, shown: ProcessNode[], boxes: Map<string, Box>) {
  const artifacts: Artifact[] = artifactsOf(shown, boxes, { data: new Map(m.data.map((d) => [d.id, d.name])), systems: new Map(m.systems.map((s) => [s.id, s.name])) });
  const messages = (m.messages ?? []).filter((x) => boxes.has(x.from) || boxes.has(x.to));
  const rects = poolBoxes(m.pools ?? [], messages, boxes, poolsTop(m));
  const pools = (m.pools ?? []).flatMap((p) => (rects.has(p.id) ? [{ pool: p, box: rects.get(p.id)! }] : []));
  return { artifacts, pools, messages: messageEdges(messages, boxes, rects) };
}

/** Размер «мира» диаграммы: ширина по самой правой фигуре, высота по числу дорожек (и полосе внешних пулов). */
export function modelExtents(m: ProcessLogicModel): { w: number; h: number } {
  let maxX = 900;
  const shown = visibleNodes(m);
  const boxes = boxMap(shown);
  for (const b of boxes.values()) maxX = Math.max(maxX, b.x + b.w + 120);
  const { pools } = diagramExtras(m, shown, boxes);
  for (const p of pools) maxX = Math.max(maxX, p.box.x + p.box.w + 60);
  return { w: maxX, h: laneTop(laneCount(m)) + 20 + (pools.length > 0 ? 30 + POOL_H + 20 : 0) };
}

/** Дорожек на одну больше числа ролей: последняя — «Без исполнителя». */
export const laneCount = (m: ProcessLogicModel) => m.roles.length + 1;
export const laneTop = (i: number) => START_Y + i * LANE_H;

export function laneIndexOfRole(m: ProcessLogicModel, roleId: string | null | undefined): number {
  const i = roleId ? m.roles.findIndex((r) => r.id === roleId) : -1;
  return i >= 0 ? i : m.roles.length;
}

export function laneIndexAtY(m: ProcessLogicModel, y: number): number {
  const i = Math.floor((y - START_Y) / LANE_H);
  return Math.max(0, Math.min(laneCount(m) - 1, i));
}

export function roleIdOfLane(m: ProcessLogicModel, laneIndex: number): string | null {
  return m.roles[laneIndex]?.id ?? null;
}

/** Удерживает фигуру целиком внутри дорожки и правее подписи дорожки. */
export function clampIntoLane(m: ProcessLogicModel, n: Pick<ProcessNode, "type">, x: number, y: number, laneIndex: number): Pt {
  const s = sizeOf(n);
  const top = laneTop(laneIndex);
  return [Math.max(MIN_X, x), Math.min(Math.max(y, top + 4), top + LANE_H - s.h - 4)];
}

export function labelPoint(pts: Pt[]): Pt {
  const i = Math.floor((pts.length - 1) / 2);
  return [(pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2];
}

/**
 * Авто-раскладка слева направо: столбец = длиннейший путь от начала (петли
 * игнорируются), строка = дорожка роли. Две фигуры в одной ячейке не допускаются.
 */
export function autoLayout(m: ProcessLogicModel): Map<string, { x: number; y: number }> {
  const all = visibleNodes(m);
  // граничное событие в раскладке — продолжение своей задачи: его стрелки идут «от задачи», а места оно не занимает
  const hostOf = new Map(all.filter((n) => isBoundary(n, all)).map((n) => [n.id, n.attached_to!] as const));
  const shown = all.filter((n) => !hostOf.has(n.id));
  const ids = shown.map((n) => n.id);
  const order = new Map(ids.map((id, i) => [id, i] as const));
  const out = new Map<string, string[]>();
  const hasIn = new Set<string>();
  for (const f of visibleFlows(m)) {
    const from = hostOf.get(f.from) ?? f.from;
    if (from === f.to || !order.has(from) || !order.has(f.to)) continue;
    out.set(from, [...(out.get(from) ?? []), f.to]);
    hasIn.add(f.to);
  }

  // убираем обратные рёбра (петли), чтобы получить DAG
  const fwd = new Map<string, string[]>();
  const state = new Map<string, 1 | 2>();
  const dfs = (u: string) => {
    state.set(u, 1);
    for (const v of out.get(u) ?? []) {
      if (state.get(v) === 1) continue;
      fwd.set(u, [...(fwd.get(u) ?? []), v]);
      if (!state.has(v)) dfs(v);
    }
    state.set(u, 2);
  };
  for (const id of [...ids.filter((i) => !hasIn.has(i)), ...ids]) if (!state.has(id)) dfs(id);

  const preds = new Map<string, string[]>();
  const indeg = new Map<string, number>(ids.map((id) => [id, 0]));
  for (const [u, vs] of fwd) {
    for (const v of vs) {
      preds.set(v, [...(preds.get(v) ?? []), u]);
      indeg.set(v, (indeg.get(v) ?? 0) + 1);
    }
  }

  const laneOf = new Map(shown.map((n) => [n.id, laneIndexOfRole(m, n.role_id)] as const));
  const rank = new Map<string, number>();
  const taken = new Set<string>();
  const queue = ids.filter((id) => indeg.get(id) === 0);
  while (queue.length > 0) {
    queue.sort((a, b) => order.get(a)! - order.get(b)!);
    const u = queue.shift()!;
    let r = Math.max(-1, ...(preds.get(u) ?? []).map((p) => rank.get(p) ?? -1)) + 1;
    while (taken.has(`${r}:${laneOf.get(u)}`)) r++;
    taken.add(`${r}:${laneOf.get(u)}`);
    rank.set(u, r);
    for (const v of fwd.get(u) ?? []) {
      indeg.set(v, indeg.get(v)! - 1);
      if (indeg.get(v) === 0) queue.push(v);
    }
  }

  const result = new Map<string, { x: number; y: number }>();
  for (const n of shown) {
    const s = sizeOf(n);
    const cx = MIN_X + 60 + (rank.get(n.id) ?? 0) * COL_W;
    result.set(n.id, { x: snap(cx - s.w / 2), y: laneTop(laneOf.get(n.id)!) + (LANE_H - s.h) / 2 }); // центры — на одной линии
  }
  return result;
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
 * force — расставить все фигуры заново авто-раскладкой.
 */
export function withLayout(m: ProcessLogicModel, force = false, seed?: Map<string, { x: number; y: number }>): ProcessLogicModel {
  const all = visibleNodes(m);
  if (!force && all.every((n) => n.layout || isBoundary(n, all))) return m;
  const auto = autoLayout(m);
  const pick = (id: string) => (!force && seed?.get(id)) || auto.get(id);
  return { ...m, nodes: m.nodes.map((n) => (auto.has(n.id) && (force || !n.layout) ? { ...n, layout: pick(n.id)! } : n)) };
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

export function wrapText(text: string, maxChars: number, maxLines: number): string[] {
  const lines: string[] = [];
  let cur = "";
  for (let word of text.split(/\s+/).filter(Boolean)) {
    while (word.length > maxChars) {
      if (cur) {
        lines.push(cur);
        cur = "";
      }
      lines.push(word.slice(0, maxChars));
      word = word.slice(maxChars);
    }
    if (!cur) cur = word;
    else if ((cur + " " + word).length <= maxChars) cur += " " + word;
    else {
      lines.push(cur);
      cur = word;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const cut = lines.slice(0, maxLines);
    cut[maxLines - 1] = cut[maxLines - 1].replace(/.{0,1}$/, "…");
    return cut;
  }
  return lines;
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
  const withArtifacts = new Set(extras.artifacts.map((a) => a.nodeId));
  const poolIds = new Set(extras.pools.map((p) => p.pool.id));
  const end = (id: string) => (poolIds.has(id) ? `pool:${id}` : id);
  const info = routeFlowsDetailed(
    [...shown.map((n) => ({ id: n.id, box: boxes.get(n.id)!, type: n.type, boundary: isBoundary(n, shown), artifacts: withArtifacts.has(n.id) })), ...extras.pools.map((p) => ({ id: `pool:${p.pool.id}`, box: p.box, type: "pool" }))],
    [...flows.map((f) => ({ id: f.id, from: f.from, to: f.to, fixed: fixedRoute(f.route) })), ...extras.messages.map(({ message }) => ({ id: `msg:${message.id}`, from: end(message.from), to: end(message.to), message: true }))],
    extras.artifacts.map((a) => a.box)
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