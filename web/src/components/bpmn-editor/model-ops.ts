import type { ProcessFlow, ProcessLogicModel, ProcessNode } from "../../types";
import { LANE_H, clampIntoLane, laneIndexAtY, laneIndexOfRole, laneTop, roleIdOfLane, sizeOf, snap, boxOf } from "./geometry";

type M = ProcessLogicModel;
export interface OpResult {
  model: M;
  id?: string;
  error?: string;
}

export interface NewNodeSpec {
  type: ProcessNode["type"];
  subtype?: string;
  name: string;
}

export const PALETTE: { label: string; spec: NewNodeSpec }[] = [
  { label: "Задача", spec: { type: "task", name: "Новая задача" } },
  { label: "Подпроцесс", spec: { type: "subprocess", name: "Подпроцесс" } },
  { label: "Начало", spec: { type: "event", subtype: "start", name: "Начало" } },
  { label: "Конец", spec: { type: "event", subtype: "end", name: "Конец" } },
  { label: "Событие", spec: { type: "event", subtype: "intermediate", name: "Событие" } },
  { label: "Шлюз XOR", spec: { type: "gateway", subtype: "exclusive", name: "Развилка" } },
  { label: "Шлюз AND", spec: { type: "gateway", subtype: "parallel", name: "Параллельно" } },
  { label: "Шлюз OR", spec: { type: "gateway", subtype: "inclusive", name: "Один или несколько" } },
];

export const SUBTYPES: Record<string, [string, string][]> = {
  task: [["", "Обычная"], ["user", "Пользовательская"], ["service", "Сервисная"], ["manual", "Ручная"], ["send", "Отправка"], ["receive", "Получение"], ["script", "Скрипт"]],
  event: [["start", "Начало"], ["intermediate", "Промежуточное"], ["timer", "Таймер"], ["message", "Сообщение"], ["signal", "Сигнал"], ["error", "Ошибка"], ["end", "Конец"]],
  gateway: [["exclusive", "Исключающий (XOR)"], ["parallel", "Параллельный (AND)"], ["inclusive", "Включающий (OR)"], ["event_based", "По событию"]],
  subprocess: [],
};
export const TYPE_LABELS: Record<string, string> = { task: "Задача", subprocess: "Подпроцесс", event: "Событие", gateway: "Шлюз" };

export function nextId(prefix: string, used: Iterable<string>): string {
  const set = new Set(used);
  let i = set.size + 1;
  while (set.has(prefix + i)) i++;
  return prefix + i;
}

const mapNode = (m: M, id: string, fn: (n: ProcessNode) => ProcessNode): M => ({
  ...m,
  nodes: m.nodes.map((n) => (n.id === id ? fn(n) : n)),
});

export function addNodeAt(m: M, spec: NewNodeSpec, cx: number, cy: number): OpResult {
  const size = sizeOf(spec);
  const lane = laneIndexAtY(m, cy);
  const [x, y] = clampIntoLane(m, spec, snap(cx - size.w / 2), snap(cy - size.h / 2), lane);
  const node: ProcessNode = {
    id: nextId("n", m.nodes.map((n) => n.id)),
    type: spec.type,
    subtype: spec.subtype,
    name: spec.name,
    role_id: roleIdOfLane(m, lane),
    system_ids: [],
    inputs: [],
    outputs: [],
    controls: [],
    status: "confirmed",
    confidence: 1,
    source: [],
    requirement_ids: [],
    tags: [],
    confirmed_by: [],
    layout: { x, y },
  };
  return { model: { ...m, nodes: [...m.nodes, node] }, id: node.id };
}

export const moveNode = (m: M, id: string, x: number, y: number): M => mapNode(m, id, (n) => ({ ...n, layout: { x, y } }));

/** После перетаскивания: роль узла = дорожка под его центром, фигура удерживается внутри дорожки. */
export function dropNodeIntoLane(m: M, id: string): M {
  const n = m.nodes.find((x) => x.id === id);
  if (!n) return m;
  const b = boxOf(n);
  const lane = laneIndexAtY(m, b.y + b.h / 2);
  const [x, y] = clampIntoLane(m, n, snap(b.x), snap(b.y), lane);
  return mapNode(m, id, (nn) => ({ ...nn, role_id: roleIdOfLane(m, lane), layout: { x, y } }));
}

export function setNodeRole(m: M, id: string, roleId: string | null): M {
  const n = m.nodes.find((x) => x.id === id);
  if (!n) return m;
  const lane = laneIndexOfRole(m, roleId);
  const b = boxOf(n);
  return mapNode(m, id, (nn) => ({ ...nn, role_id: roleId, layout: { x: b.x, y: laneTop(lane) + (LANE_H - b.h) / 2 } }));
}

export function setNodeType(m: M, id: string, type: ProcessNode["type"]): M {
  const n = m.nodes.find((x) => x.id === id);
  if (!n || n.type === type) return m;
  const old = boxOf(n);
  const size = sizeOf({ type });
  const subtype = SUBTYPES[type]?.[0]?.[0] || undefined;
  return mapNode(m, id, (nn) => ({
    ...nn,
    type,
    subtype,
    layout: { x: snap(old.x + (old.w - size.w) / 2), y: snap(old.y + (old.h - size.h) / 2) },
  }));
}

export const updateNode = (m: M, id: string, patch: Partial<ProcessNode>): M => mapNode(m, id, (n) => ({ ...n, ...patch }));

/** Вложенные функции IDEF0 (на любую глубину) принадлежат родителю и удаляются вместе с ним. */
function subtreeIds(m: M, id: string): Set<string> {
  const ids = new Set([id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const n of m.nodes) {
      if (n.idef0_parent && ids.has(n.idef0_parent) && !ids.has(n.id)) {
        ids.add(n.id);
        grew = true;
      }
    }
  }
  return ids;
}

export function deleteNode(m: M, id: string): M {
  const gone = subtreeIds(m, id);
  return {
    ...m,
    nodes: m.nodes.filter((n) => !gone.has(n.id)),
    flows: m.flows.filter((f) => !gone.has(f.from) && !gone.has(f.to)),
    raci: m.raci.filter((r) => !gone.has(r.node_id)),
    assignments: (m.assignments ?? []).filter((a) => !a.node_id || !gone.has(a.node_id)),
    requirements_links: m.requirements_links.filter((r) => !gone.has(r.element_id)),
    discrepancies: m.discrepancies.filter((d) => !gone.has(d.element_id)),
    interfaces: m.interfaces.map((i) => (i.linked_node_id && gone.has(i.linked_node_id) ? { ...i, linked_node_id: null } : i)),
  };
}

/**
 * Копия шага или функции рядом с оригиналом (со сдвигом на обеих диаграммах). Связи, источник в интервью и
 * подтверждения не копируются: копия — новый элемент, созданный вручную. Вложенные функции не копируются.
 */
export function duplicateNode(m: M, id: string): OpResult {
  const n = m.nodes.find((x) => x.id === id);
  if (!n) return { model: m, error: "Элемент не найден" };
  const copy: ProcessNode = {
    ...structuredClone(n),
    id: nextId("n", m.nodes.map((x) => x.id)),
    name: `${n.name} (копия)`,
    layout: n.layout ? { x: n.layout.x + 40, y: n.layout.y } : n.layout,
    idef0_layout: n.idef0_layout ? { x: n.idef0_layout.x + 40, y: n.idef0_layout.y + 40 } : n.idef0_layout,
    source: [],
    confirmed_by: [],
    requirement_ids: [],
    status: "confirmed",
    confidence: 1,
  };
  const next = { ...m, nodes: [...m.nodes, copy] };
  return { model: n.layout ? dropNodeIntoLane(next, copy.id) : next, id: copy.id };
}

export function addFlow(m: M, from: string, to: string): OpResult {
  const a = m.nodes.find((n) => n.id === from);
  const b = m.nodes.find((n) => n.id === to);
  if (!a || !b) return { model: m, error: "Элемент не найден" };
  if (from === to) return { model: m, error: "Нельзя соединить элемент с самим собой" };
  if (m.flows.some((f) => f.from === from && f.to === to)) return { model: m, error: "Такая связь уже есть" };
  if (a.type === "event" && a.subtype === "end") return { model: m, error: "Из конечного события нельзя вести стрелку" };
  if (b.type === "event" && b.subtype === "start") return { model: m, error: "В начальное событие нельзя вести стрелку" };
  const flow: ProcessFlow = { id: nextId("flow", m.flows.map((f) => f.id)), from, to, condition: null, source: [], confirmed_by: [] };
  return { model: { ...m, flows: [...m.flows, flow] }, id: flow.id };
}

export const updateFlow = (m: M, id: string, patch: Partial<ProcessFlow>): M => ({
  ...m,
  flows: m.flows.map((f) => (f.id === id ? { ...f, ...patch } : f)),
});
export const deleteFlow = (m: M, id: string): M => ({ ...m, flows: m.flows.filter((f) => f.id !== id) });

/** Дорожки — это роли; вставка/удаление роли сдвигает фигуры нижних дорожек. */
function shiftForLanes(oldM: M, newM: M): M {
  return {
    ...newM,
    nodes: newM.nodes.map((n) => {
      const delta = laneIndexOfRole(newM, n.role_id) - laneIndexOfRole(oldM, n.role_id);
      return delta && n.layout ? { ...n, layout: { x: n.layout.x, y: n.layout.y + delta * LANE_H } } : n;
    }),
  };
}

export function addRole(m: M): OpResult {
  const id = nextId("role", m.roles.map((r) => r.id));
  const next: M = { ...m, roles: [...m.roles, { id, name: `Роль ${m.roles.length + 1}`, kind: "internal", source: [] }] };
  return { model: shiftForLanes(m, next), id };
}

/**
 * Новая дорожка на диаграмме BPMN операции: роль создаётся в справочнике и назначается исполнителем операции —
 * дорожки диаграммы операции строятся из назначенных ей исполнителей.
 */
export function addScopeLane(m: M, scope: string): OpResult {
  const id = nextId("role", m.roles.map((r) => r.id));
  const roles = [...m.roles, { id, name: `Роль ${m.roles.length + 1}`, kind: "internal" as const, source: [] }];
  return { model: { ...m, roles, assignments: [...(m.assignments ?? []), { node_id: scope, role_id: id, kind: "executor" as const, functions: [] }] }, id };
}

export function deleteRole(m: M, id: string): OpResult {
  if (m.nodes.some((n) => n.role_id === id)) return { model: m, error: "В дорожке есть элементы — сначала перенесите или удалите их" };
  const next: M = { ...m, roles: m.roles.filter((r) => r.id !== id), raci: m.raci.filter((r) => r.role_id !== id), assignments: (m.assignments ?? []).filter((a) => a.role_id !== id) };
  return { model: shiftForLanes(m, next) };
}

export const renameRole = (m: M, id: string, name: string): M => ({
  ...m,
  roles: m.roles.map((r) => (r.id === id ? { ...r, name } : r)),
});
