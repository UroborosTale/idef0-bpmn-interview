import type { ProcessLogicModel, ProcessNode } from "../../types";
import { nextId, setNodeRole, updateNode, type OpResult } from "../bpmn-editor/model-ops";
import { BLOCK_H, BLOCK_W, functionsOf, snap, MIN_POS } from "./geometry";

type M = ProcessLogicModel;

/**
 * Какие поля функции образуют стороны блока IDEF0: вход/выход — данные, управление — регламенты
 * или данные (выход другой функции), механизм — системы.
 */
export type Slot = "inputs" | "outputs" | "controls" | "control_data_ids" | "system_ids";
export type EntityKind = "data" | "control" | "system" | "role";

export const SLOT_ENTITY: Record<Slot, EntityKind> = { inputs: "data", outputs: "data", controls: "control", control_data_ids: "data", system_ids: "system" };

const mapNode = (m: M, id: string, fn: (n: ProcessNode) => ProcessNode): M => ({ ...m, nodes: m.nodes.map((n) => (n.id === id ? fn(n) : n)) });
const slotOf = (n: ProcessNode, slot: Slot): string[] => n[slot] ?? [];

export function createEntity(m: M, kind: Exclude<EntityKind, "role">, name: string): OpResult {
  if (kind === "data") {
    const id = nextId("data", m.data.map((d) => d.id));
    return { model: { ...m, data: [...m.data, { id, name, kind: "document", source: [] }] }, id };
  }
  if (kind === "control") {
    const id = nextId("ctl", m.controls.map((c) => c.id));
    return { model: { ...m, controls: [...m.controls, { id, name, kind: "rule", source: [] }] }, id };
  }
  const id = nextId("sys", m.systems.map((s) => s.id));
  return { model: { ...m, systems: [...m.systems, { id, name, source: [] }] }, id };
}

export const attach = (m: M, nodeId: string, slot: Slot, id: string): M =>
  mapNode(m, nodeId, (n) => (slotOf(n, slot).includes(id) ? n : { ...n, [slot]: [...slotOf(n, slot), id] }));

export const detach = (m: M, nodeId: string, slot: Slot, id: string): M =>
  mapNode(m, nodeId, (n) => ({ ...n, [slot]: slotOf(n, slot).filter((x) => x !== id) }));

/** Переименование сущности меняет подпись всех стрелок, которые на неё ссылаются (одна стрелка IDEF0 — одна сущность). */
export function renameEntity(m: M, kind: EntityKind, id: string, name: string): M {
  const ren = <T extends { id: string; name: string }>(xs: T[]) => xs.map((x) => (x.id === id ? { ...x, name } : x));
  switch (kind) {
    case "data":
      return { ...m, data: ren(m.data) };
    case "control":
      return { ...m, controls: ren(m.controls) };
    case "system":
      return { ...m, systems: ren(m.systems) };
    default:
      return { ...m, roles: ren(m.roles) };
  }
}

/** Ближайшее к (x, y) место, где блок не налезает на соседей по диаграмме (сдвиг вниз, затем вправо). */
function freeSpot(m: M, parentId: string | null, x: number, y: number): { x: number; y: number } {
  const others = functionsOf(m, parentId).map((n) => n.idef0_layout).filter((p): p is { x: number; y: number } => !!p);
  const hits = (px: number, py: number) => others.some((o) => Math.abs(o.x - px) < BLOCK_W + 30 && Math.abs(o.y - py) < BLOCK_H + 50);
  for (let col = 0; col < 12; col++) {
    for (let row = 0; row < 12; row++) {
      const px = x + col * (BLOCK_W + 40);
      const py = y + row * (BLOCK_H + 60);
      if (!hits(px, py)) return { x: px, y: py };
    }
  }
  return { x, y };
}

/** Новая функция на диаграмме parentId (null — A0). Вложенная функция в BPMN не показывается. */
export function addFunction(m: M, parentId: string | null, cx: number, cy: number): OpResult {
  const spot = freeSpot(m, parentId, Math.max(MIN_POS, snap(cx - BLOCK_W / 2)), Math.max(MIN_POS, snap(cy - BLOCK_H / 2)));
  const node: ProcessNode = {
    id: nextId("n", m.nodes.map((n) => n.id)),
    type: "task",
    name: "Новая функция",
    role_id: null,
    system_ids: [],
    inputs: [],
    outputs: [],
    controls: [],
    idef0_parent: parentId,
    status: "confirmed",
    confidence: 1,
    source: [],
    requirement_ids: [],
    tags: [],
    confirmed_by: [],
    idef0_layout: spot,
  };
  return { model: { ...m, nodes: [...m.nodes, node] }, id: node.id };
}

/**
 * Убрать стрелку: отсоединить сущность от функции. Сам объект данных/регламент остаётся
 * в справочнике модели.
 */
export function removeArrow(m: M, a: { kind: string; nodeId: string; entityId: string }): M {
  switch (a.kind) {
    case "input":
    case "link":
      return detach(m, a.nodeId, "inputs", a.entityId);
    case "output":
      return detach(m, a.nodeId, "outputs", a.entityId);
    case "control":
      return detach(m, a.nodeId, "controls", a.entityId);
    case "controlData":
    case "controlLink":
      return detach(m, a.nodeId, "control_data_ids", a.entityId);
    case "system":
      return detach(m, a.nodeId, "system_ids", a.entityId);
    case "role": {
      // стрелка-механизм убирает должность и как исполнителя по умолчанию, и как назначенную роль функции
      const n = m.nodes.find((x) => x.id === a.nodeId);
      const cleared = n?.role_id === a.entityId ? setFunctionRole(m, a.nodeId, null) : m;
      return { ...cleared, assignments: (cleared.assignments ?? []).filter((x) => !(x.node_id === a.nodeId && x.role_id === a.entityId && x.kind !== "observer")) };
    }
    default:
      return m;
  }
}

export const moveFunction = (m: M, id: string, x: number, y: number): M => mapNode(m, id, (n) => ({ ...n, idef0_layout: { x, y } }));

/**
 * Роль — механизм IDEF0, но она же определяет дорожку в BPMN. Если у узла есть позиция в BPMN,
 * переносим его в новую дорожку, иначе меняем только роль (позицию в BPMN расставит авто-раскладка).
 */
export function setFunctionRole(m: M, id: string, roleId: string | null): M {
  const n = m.nodes.find((x) => x.id === id);
  if (!n) return m;
  return n.layout ? setNodeRole(m, id, roleId) : updateNode(m, id, { role_id: roleId });
}

/**
 * Связывает функции стрелкой «выход from → вход (или управление) to»: берёт ещё не потреблённый
 * выход источника, а если такого нет — создаёт новый объект данных. Возвращает ключ новой стрелки.
 */
export function linkFunctions(m: M, from: string, to: string, as: "input" | "control" = "input"): OpResult & { key?: string } {
  const a = m.nodes.find((n) => n.id === from);
  const b = m.nodes.find((n) => n.id === to);
  if (!a || !b || from === to) return { model: m, error: "Выберите другую функцию" };
  const takenBy = (n: ProcessNode, did: string) => n.inputs.includes(did) || (n.control_data_ids ?? []).includes(did);
  // одна пара функций может быть связана и как «выход → вход», и как «выход → управление» — но разными данными
  const sameKind = (n: ProcessNode, did: string) => (as === "control" ? (n.control_data_ids ?? []).includes(did) : n.inputs.includes(did));
  if (a.outputs.some((o) => sameKind(b, o))) return { model: m, error: as === "control" ? "Эта функция уже управляет целевой" : "Эти функции уже связаны" };
  const siblings = functionsOf(m, a.idef0_parent ?? null);
  const free = a.outputs.find((o) => m.data.some((d) => d.id === o) && !siblings.some((f) => f.id !== from && takenBy(f, o)));
  let next = m;
  let dataId = free;
  if (!dataId) {
    const created = createEntity(m, "data", "Новый документ");
    next = attach(created.model, from, "outputs", created.id!);
    dataId = created.id!;
  }
  next = attach(next, to, as === "control" ? "control_data_ids" : "inputs", dataId);
  return { model: next, id: dataId, key: `${as === "control" ? "controlLink" : "link"}:${to}:${dataId}` };
}
