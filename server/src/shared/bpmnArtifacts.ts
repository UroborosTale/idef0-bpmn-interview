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

export const ARTIFACT_W = 22;
export const ARTIFACT_H = 26;

/**
 * Документы (входы и выходы) и хранилища данных (информационные системы) задачи: ряд значков над задачей.
 * Задача в дорожке стоит по центру, над ней остаётся 35 пикселей — значок с ассоциацией туда помещается.
 */
export function artifactsOf(
  nodes: ArtNode[],
  boxes: Map<string, Box>,
  names: { data: Map<string, string>; systems: Map<string, string> }
): Artifact[] {
  const out: Artifact[] = [];
  for (const n of nodes) {
    if (n.type !== "task" && n.type !== "subprocess") continue;
    const host = boxes.get(n.id);
    if (!host) continue;
    const items: { kind: ArtifactKind; entityId: string; name: string }[] = [
      ...n.inputs.filter((id) => names.data.has(id)).map((id) => ({ kind: "input" as const, entityId: id, name: names.data.get(id)! })),
      ...n.outputs.filter((id) => names.data.has(id)).map((id) => ({ kind: "output" as const, entityId: id, name: names.data.get(id)! })),
      ...n.system_ids.filter((id) => names.systems.has(id)).map((id) => ({ kind: "store" as const, entityId: id, name: names.systems.get(id)! })),
    ];
    if (items.length === 0) continue;
    const span = host.w + 40;
    const step = Math.max(10, Math.min(ARTIFACT_W + 6, (span - ARTIFACT_W) / Math.max(items.length - 1, 1)));
    const total = ARTIFACT_W + (items.length - 1) * step;
    const left = host.x + host.w / 2 - total / 2;
    items.forEach((it, i) => {
      const box = { x: left + i * step, y: host.y - ARTIFACT_H - 8, w: ARTIFACT_W, h: ARTIFACT_H };
      const cx = box.x + box.w / 2;
      const tx = Math.min(Math.max(cx, host.x + 10), host.x + host.w - 10);
      const top: Pt = [tx, host.y];
      const bottom: Pt = [cx, box.y + box.h];
      out.push({ key: `${n.id}:${it.kind}:${it.entityId}`, nodeId: n.id, kind: it.kind, entityId: it.entityId, name: it.name, box, edge: it.kind === "output" ? [top, bottom] : [bottom, top] });
    });
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
