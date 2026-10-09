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
}

export interface ArtPool {
  id: string;
  name: string;
  code?: string | null;
}

export interface ArtMessage {
  id: string;
  from: string;
  to: string;
  name?: string | null;
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
/** Отступ значка от границы задачи: отступ, значок и подпись (4 + 20 + 11) укладываются в 35 пикселей над или под задачей в дорожке. */
const ARTIFACT_GAP = 4;
/** Подпись значка (кегль 8): до 14 знаков, около 60 пикселей в ширину и 11 в высоту. */
const ARTIFACT_LABEL_W = 60;
const ARTIFACT_LABEL_H = 11;

/** Хранилище данных (информационная система) стоит под задачей; документы — над ней. */
export const isStoreArtifact = (a: { kind: ArtifactKind }) => a.kind === "store";

/** Рамка значка вместе с подписью — по ней стрелки обходят значок. Подпись документа стоит над ним, подпись хранилища — под ним. */
export const artifactObstacle = (a: { box: Box; kind: ArtifactKind }): Box => {
  const w = Math.max(a.box.w, ARTIFACT_LABEL_W);
  const x = a.box.x + a.box.w / 2 - w / 2;
  return isStoreArtifact(a) ? { x, y: a.box.y, w, h: a.box.h + ARTIFACT_LABEL_H } : { x, y: a.box.y - ARTIFACT_LABEL_H, w, h: a.box.h + ARTIFACT_LABEL_H };
};

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
      const span = host.w + 40;
      const step = Math.max(10, Math.min(ARTIFACT_W + 6, (span - ARTIFACT_W) / Math.max(items.length - 1, 1)));
      const total = ARTIFACT_W + (items.length - 1) * step;
      const left = below ? Math.max(host.x + host.w / 2 - total / 2, afterEvents) : host.x + host.w / 2 - total / 2;
      let prev = -Infinity;
      items.forEach((it, i) => {
        let x = Math.max(left + i * step, prev + step);
        if (below && msg && x < msg[1] && x + ARTIFACT_W > msg[0]) x = msg[1];
        prev = x;
        const box = { x, y: below ? host.y + host.h + ARTIFACT_GAP : host.y - ARTIFACT_GAP - ARTIFACT_H, w: ARTIFACT_W, h: ARTIFACT_H };
        const cx = box.x + box.w / 2;
        const tx = Math.min(Math.max(cx, host.x + 10), host.x + host.w - 10);
        const onTask: Pt = [tx, below ? host.y + host.h : host.y];
        const onIcon: Pt = [cx, below ? box.y : box.y + box.h];
        // у входа и хранилища ассоциация идёт от значка к задаче, у выхода — от задачи к значку
        out.push({ key: `${n.id}:${it.kind}:${it.entityId}`, nodeId: n.id, kind: it.kind, entityId: it.entityId, name: it.name, box, edge: it.kind === "output" ? [onTask, onIcon] : [onIcon, onTask] });
      });
    };
    row(docs, false);
    row(stores, true);
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
  for (const p of used) {
    const x = Math.max(anchor.get(p.id)! - POOL_W / 2, right + 24);
    out.set(p.id, { x, y: topY, w: POOL_W, h: POOL_H });
    right = x + POOL_W;
  }
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
