/**
 * Добавочные элементы диаграммы BPMN, положение которых выводится из положения шагов: граничные события,
 * документы и хранилища данных у задач, свёрнутые внешние пулы и потоки сообщений. Модуль общий для генератора BPMN
 * (server/src/pipeline/bpmn.ts) и редактора в браузере, поэтому экспорт совпадает с нарисованным.
 */

import { SIZE, type Box, type Pt } from "./bpmnGeometry.js";

export interface ArtNode {
  id: string;
  type: string;
  attached_to?: string | null;
  inputs: string[];
  outputs: string[];
  system_ids: string[];
  /** Ручное смещение значков от автоматического места: ключ «вид:сущность». */
  artifact_offsets?: Record<string, { dx: number; dy: number }>;
}

export interface ArtPool {
  id: string;
  name: string;
  code?: string | null;
  dx?: number;
  dy?: number;
}

export interface ArtMessage {
  id: string;
  from: string;
  to: string;
  name?: string | null;
  /** Ручной маршрут стрелки (как у потока управления): точки излома и положение участков. */
  route?: { from_side?: "L" | "R" | "T" | "B"; to_side?: "L" | "R" | "T" | "B"; channel?: number; from_pos?: number; to_pos?: number; points?: Pt[] } | null;
}

const isHostType = (type: string) => type === "task" || type === "subprocess";

/** Граничное событие прикреплено к существующей задаче или подпроцессу той же диаграммы; иначе это обычное событие. */
export function isBoundaryNode(n: ArtNode, nodes: ArtNode[]): boolean {
  if (n.type !== "event" || !n.attached_to) return false;
  const host = nodes.find((x) => x.id === n.attached_to);
  return !!host && isHostType(host.type);
}

/** Граничные события по задачам-хозяевам, в порядке узлов. */
export function boundaryByHost<N extends ArtNode>(nodes: N[]): Map<string, N[]> {
  const out = new Map<string, N[]>();
  for (const n of nodes) {
    if (!isBoundaryNode(n, nodes)) continue;
    out.set(n.attached_to!, [...(out.get(n.attached_to!) ?? []), n]);
  }
  return out;
}

/** Рамки граничных событий: на нижней границе задачи, слева направо. */
export function boundaryBoxes(nodes: ArtNode[], hostBoxes: Map<string, Box>): Map<string, Box> {
  const out = new Map<string, Box>();
  const e = SIZE.event;
  for (const [hostId, list] of boundaryByHost(nodes)) {
    const host = hostBoxes.get(hostId);
    if (!host) continue;
    const step = Math.min(e.w + 8, (host.w - 24) / Math.max(list.length, 1));
    list.forEach((n, i) => {
      const cx = host.x + 22 + i * step;
      out.set(n.id, { x: cx - e.w / 2, y: host.y + host.h - e.h / 2, w: e.w, h: e.h });
    });
  }
  return out;
}

export type ArtifactKind = "input" | "output" | "store";

export interface Artifact {
  key: string;
  nodeId: string;
  kind: ArtifactKind;
  entityId: string;
  name: string;
  box: Box;
  /** Ломаная ассоциации: у входа и хранилища — от значка к задаче, у выхода — от задачи к значку. */
  edge: Pt[];
}

export const ARTIFACT_W = 18;
export const ARTIFACT_H = 20;
/** Отступ значка от границы задачи: значок укладывается в 30 пикселей над или под задачей в дорожке. */
const ARTIFACT_GAP = 4;
/** Подпись значка (кегль 10) стоит справа от него: до 18 знаков, около 96 пикселей в ширину. */
export const ARTIFACT_LABEL_W = 96;
/** Ширина подписи значка по её тексту (кегль 10, до 18 знаков) — по ней считаются промежутки между значками. */
export const artifactLabelWidth = (name: string): number => Math.min(name.length, 18) * 5 + 4;

/** Хранилище данных (информационная система) стоит под задачей; документы — над ней. */
export const isStoreArtifact = (a: { kind: ArtifactKind }) => a.kind === "store";

/** Рамка значка вместе с подписью — по ней стрелки обходят значок. Подпись стоит справа от значка, по его высоте. */
export const artifactObstacle = (a: { box: Box; kind: ArtifactKind }): Box => ({
  x: a.box.x,
  y: a.box.y,
  w: a.box.w + ARTIFACT_LABEL_W,
  h: a.box.h,
});

/**
 * Значки данных задачи. Документы (входы и выходы) — ряд над задачей, хранилища данных (информационные системы: 1С, ELMA…) —
 * ряд под ней. Подпись значка стоит с внешней стороны от задачи. Задача в дорожке стоит по центру, над ней и под ней остаётся
 * по 35 пикселей — значок с ассоциацией и подписью туда помещается.
 *
 * Снизу у задачи уже стоят граничные события (их стрелки уходят вниз) и уходят потоки сообщений к внешним пулам, поэтому ряд
 * хранилищ начинается правее последнего граничного события, а у задачи с потоком сообщений хранилища обходят его вертикаль
 * (messageNodes — шаги, у которых есть такой поток).
 */
export function artifactsOf(
  nodes: ArtNode[],
  boxes: Map<string, Box>,
  names: { data: Map<string, string>; systems: Map<string, string> },
  messageNodes: Set<string> = new Set()
): Artifact[] {
  const out: Artifact[] = [];
  const boundary = boundaryByHost(nodes);
  const labelRect = (box: Box, name: string): Box => ({ x: box.x + box.w + 3, y: box.y, w: artifactLabelWidth(name), h: ARTIFACT_H });
  const labelsHit = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  for (const n of nodes) {
    if (n.type !== "task" && n.type !== "subprocess") continue;
    const host = boxes.get(n.id);
    if (!host) continue;
    const docs: { kind: ArtifactKind; entityId: string; name: string }[] = [
      ...n.inputs.filter((id) => names.data.has(id)).map((id) => ({ kind: "input" as const, entityId: id, name: names.data.get(id)! })),
      ...n.outputs.filter((id) => names.data.has(id)).map((id) => ({ kind: "output" as const, entityId: id, name: names.data.get(id)! })),
    ];
    const stores: { kind: ArtifactKind; entityId: string; name: string }[] = n.system_ids.filter((id) => names.systems.has(id)).map((id) => ({ kind: "store" as const, entityId: id, name: names.systems.get(id)! }));

    // граничные события стоят слева на нижней границе (boundaryBoxes): ряд хранилищ начинается правее последнего из них
    const events = boundary.get(n.id) ?? [];
    const afterEvents = events.length > 0 ? host.x + 22 + (events.length - 1) * Math.min(SIZE.event.w + 8, (host.w - 24) / events.length) + SIZE.event.w / 2 + 6 : -Infinity;
    // вертикаль потока сообщений идёт вниз из середины нижней стороны
    const msg: [number, number] | null = messageNodes.has(n.id) ? [host.x + host.w / 2 - 12, host.x + host.w / 2 + 12] : null;

    const row = (items: typeof docs, below: boolean) => {
      if (items.length === 0) return;
      // расстояние между соседними значками — по ширине подписи левого значка (подпись идёт справа от него)
      const wanted = items.slice(1).map((_it, i) => Math.max(ARTIFACT_W + 6, ARTIFACT_W + artifactLabelWidth(items[i].name) + 4));
      // ряд может быть шире задачи: подписи важнее, чем уложиться в её ширину — иначе длинные названия налезают
      const gaps = wanted;
      const offsets = [0];
      for (const g of gaps) offsets.push(offsets[offsets.length - 1] + g);
      const total = ARTIFACT_W + offsets[offsets.length - 1];
      const left = below ? Math.max(host.x + host.w / 2 - total / 2, afterEvents) : host.x + host.w / 2 - total / 2;
      let prev = -Infinity;
      items.forEach((it, i) => {
        let x = Math.max(left + offsets[i], i === 0 ? -Infinity : prev + gaps[i - 1]);
        if (below && msg && x < msg[1] && x + ARTIFACT_W > msg[0]) x = msg[1];
        prev = x;
        const auto = { x, y: below ? host.y + host.h + ARTIFACT_GAP : host.y - ARTIFACT_GAP - ARTIFACT_H, w: ARTIFACT_W, h: ARTIFACT_H };
        const off = n.artifact_offsets?.[`${it.kind}:${it.entityId}`];
        const box = off ? { ...auto, x: auto.x + off.dx, y: auto.y + off.dy } : auto;
        const cx = box.x + box.w / 2;
        const cy = box.y + box.h / 2;
        let onTask: Pt;
        let onIcon: Pt;
        if (!off || cy < host.y || cy > host.y + host.h) {
          // значок над задачей или под ней: ассоциация идёт к верхней или нижней стороне
          const underTask = off ? cy > host.y + host.h : below;
          const tx = Math.min(Math.max(cx, host.x + 10), host.x + host.w - 10);
          onTask = [tx, underTask ? host.y + host.h : host.y];
          onIcon = [cx, underTask ? box.y : box.y + box.h];
        } else {
          // значок сбоку от задачи: ассоциация идёт к левой или правой стороне
          const left = cx < host.x + host.w / 2;
          onTask = [left ? host.x : host.x + host.w, Math.min(Math.max(cy, host.y + 10), host.y + host.h - 10)];
          onIcon = [left ? box.x + box.w : box.x, cy];
        }
        // у входа и хранилища ассоциация идёт от значка к задаче, у выхода — от задачи к значку
        out.push({ key: `${n.id}:${it.kind}:${it.entityId}`, nodeId: n.id, kind: it.kind, entityId: it.entityId, name: it.name, box, edge: it.kind === "output" ? [onTask, onIcon] : [onIcon, onTask] });
      });
    };
    row(docs, false);
    row(stores, true);
  }
  // подписи значков соседних задач не должны налезать: сдвигаем весь ряд задачи, сохраняя промежутки внутри него
  const groups = new Map<string, Artifact[]>();
  for (const a of out) groups.set(a.nodeId, [...(groups.get(a.nodeId) ?? []), a]);
  const orderedGroups = [...groups.values()].sort(
    (a, b) => Math.min(...a.map((x) => labelRect(x.box, x.name).x)) - Math.min(...b.map((x) => labelRect(x.box, x.name).x))
  );
  const occupied: Box[] = [];
  for (const group of orderedGroups) {
    let delta = 0;
    for (let guard = 0; guard < 24; guard++) {
      const labels = group.map((a) => {
        const r = labelRect(a.box, a.name);
        return { ...r, x: r.x + delta };
      });
      const clash = labels.find((r) => occupied.some((o) => labelsHit(r, o)));
      if (!clash) break;
      const right = Math.max(...occupied.filter((o) => labelsHit(clash, o)).map((o) => o.x + o.w));
      delta += right + 6 - clash.x;
    }
    if (delta !== 0) {
      for (const a of group) {
        a.box = { ...a.box, x: a.box.x + delta };
        a.edge = a.edge.map(([x, y]) => [x + delta, y] as Pt);
      }
    }
    occupied.push(...group.map((a) => labelRect(a.box, a.name)));
  }
  return out;
}
export const POOL_W = 170;
export const POOL_H = 40;

/** Свёрнутые внешние пулы под диаграммой: каждый под первым связанным с ним шагом, без наложений. */
export function poolBoxes(pools: ArtPool[], messages: ArtMessage[], boxes: Map<string, Box>, topY: number): Map<string, Box> {
  const anchor = new Map<string, number>();
  for (const m of messages) {
    for (const [a, b] of [[m.from, m.to], [m.to, m.from]]) {
      const pool = pools.find((p) => p.id === a);
      const node = boxes.get(b);
      if (pool && node && !anchor.has(pool.id)) anchor.set(pool.id, node.x + node.w / 2);
    }
  }
  const used = pools.filter((p) => anchor.has(p.id)).sort((p, q) => anchor.get(p.id)! - anchor.get(q.id)!);
  const out = new Map<string, Box>();
  let right = -Infinity;
  const place = (p: ArtPool, x: number) => {
    // ручное смещение сдвигает пул, не меняя места остальных (ряд считается без него)
    out.set(p.id, { x: Math.max(0, x + (p.dx ?? 0)), y: Math.max(0, topY + (p.dy ?? 0)), w: POOL_W, h: POOL_H });
    right = x + POOL_W;
  };
  for (const p of used) place(p, Math.max(anchor.get(p.id)! - POOL_W / 2, right + 24));
  // пулы без потоков сообщений на этой диаграмме (созданные самостоятельно) стоят в ряду после связанных
  for (const p of pools) if (!anchor.has(p.id)) place(p, right === -Infinity ? 60 : right + 24);
  return out;
}

/** Потоки сообщений между шагами и пулами с рамками: ломаные «вниз к пулу» или «вверх от пула». */
export function messageEdges(messages: ArtMessage[], boxes: Map<string, Box>, pools: Map<string, Box>): { message: ArtMessage; points: Pt[] }[] {
  const out: { message: ArtMessage; points: Pt[] }[] = [];
  for (const m of messages) {
    const fromPool = pools.get(m.from);
    const toPool = pools.get(m.to);
    const node = boxes.get(fromPool ? m.to : m.from);
    const pool = fromPool ?? toPool;
    if (!node || !pool || (fromPool && toPool)) continue;
    const nx = node.x + node.w / 2;
    const px = pool.x + pool.w / 2;
    const nodeY = node.y + node.h;
    const midY = (nodeY + pool.y) / 2;
    // линия идёт от шага вертикально, а у пула поворачивает к его середине (если они не друг под другом)
    const pts: Pt[] = Math.abs(nx - px) < 2 ? [[nx, nodeY], [nx, pool.y]] : [[nx, nodeY], [nx, midY], [px, midY], [px, pool.y]];
    out.push({ message: m, points: fromPool ? [...pts].reverse() : pts });
  }
  return out;
}
