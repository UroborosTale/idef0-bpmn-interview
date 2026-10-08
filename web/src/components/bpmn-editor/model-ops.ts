import { allowedTriggers, eventSpec, withTrigger, type EventPosition, type EventTrigger, type TriggerType } from "@shared/events";
import type { ExternalPool, MessageFlow, ProcessFlow, ProcessLogicModel, ProcessNode } from "../../types";
import { LANE_H, clampIntoLane, laneIndexAtY, laneIndexOfRole, laneTop, roleIdOfLane, sizeOf, snap, snapTop, boxOf } from "./geometry";

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
  /** Событие: триггер (таймер, сообщение…). */
  trigger?: EventTrigger;
}

export const PALETTE: { label: string; spec: NewNodeSpec }[] = [
  { label: "Задача", spec: { type: "task", name: "Новая задача" } },
  { label: "Бизнес-правила", spec: { type: "task", subtype: "business_rule", name: "Применить правило" } },
  { label: "Подпроцесс", spec: { type: "subprocess", name: "Подпроцесс" } },
  { label: "Начало", spec: { type: "event", subtype: "start", name: "Начало" } },
  { label: "Конец", spec: { type: "event", subtype: "end", name: "Конец" } },
  { label: "Событие", spec: { type: "event", subtype: "intermediate", name: "Событие" } },
  { label: "Шлюз XOR", spec: { type: "gateway", subtype: "exclusive", name: "Развилка" } },
  { label: "Шлюз AND", spec: { type: "gateway", subtype: "parallel", name: "Параллельно" } },
  { label: "Шлюз OR", spec: { type: "gateway", subtype: "inclusive", name: "Один или несколько" } },
];

/** События с триггерами: заготовки с названием-фактом; вид и параметры потом уточняются в свойствах. */
export const EVENT_PALETTE: { label: string; group: string; spec: NewNodeSpec }[] = [
  { group: "Начало", label: "Начало: сообщение", spec: { type: "event", subtype: "start", name: "Сообщение получено", trigger: { type: "message" } } },
  { group: "Начало", label: "Начало: таймер", spec: { type: "event", subtype: "start", name: "Наступил срок", trigger: { type: "timer" } } },
  { group: "Начало", label: "Начало: условие", spec: { type: "event", subtype: "start", name: "Условие выполнено", trigger: { type: "conditional" } } },
  { group: "Начало", label: "Начало: сигнал", spec: { type: "event", subtype: "start", name: "Сигнал получен", trigger: { type: "signal" } } },
  { group: "Ожидание", label: "Ждать сообщение", spec: { type: "event", subtype: "intermediate", name: "Сообщение получено", trigger: { type: "message", direction: "catch" } } },
  { group: "Ожидание", label: "Ждать таймер", spec: { type: "event", subtype: "intermediate", name: "Срок наступил", trigger: { type: "timer", direction: "catch" } } },
  { group: "Ожидание", label: "Ждать условие", spec: { type: "event", subtype: "intermediate", name: "Условие выполнено", trigger: { type: "conditional", direction: "catch" } } },
  { group: "Ожидание", label: "Ждать сигнал", spec: { type: "event", subtype: "intermediate", name: "Сигнал получен", trigger: { type: "signal", direction: "catch" } } },
  { group: "Ожидание", label: "Ссылка: принять", spec: { type: "event", subtype: "intermediate", name: "Переход принят", trigger: { type: "link", direction: "catch" } } },
  { group: "Отправка", label: "Отправить сообщение", spec: { type: "event", subtype: "intermediate", name: "Сообщение отправлено", trigger: { type: "message", direction: "throw" } } },
  { group: "Отправка", label: "Выбросить сигнал", spec: { type: "event", subtype: "intermediate", name: "Сигнал отправлен", trigger: { type: "signal", direction: "throw" } } },
  { group: "Отправка", label: "Ссылка: перейти", spec: { type: "event", subtype: "intermediate", name: "Переход выполнен", trigger: { type: "link", direction: "throw" } } },
  { group: "Отправка", label: "Эскалация", spec: { type: "event", subtype: "intermediate", name: "Вопрос эскалирован", trigger: { type: "escalation", direction: "throw" } } },
  { group: "Конец", label: "Конец: сообщение", spec: { type: "event", subtype: "end", name: "Уведомление отправлено", trigger: { type: "message" } } },
  { group: "Конец", label: "Конец: ошибка", spec: { type: "event", subtype: "end", name: "Процесс завершён с ошибкой", trigger: { type: "error" } } },
  { group: "Конец", label: "Конец: сигнал", spec: { type: "event", subtype: "end", name: "Сигнал отправлен", trigger: { type: "signal" } } },
  { group: "Конец", label: "Конец: терминатор", spec: { type: "event", subtype: "end", name: "Процесс прекращён", trigger: { type: "terminate" } } },
];

export const SUBTYPES: Record<string, [string, string][]> = {
  task: [["", "Обычная"], ["user", "Пользовательская"], ["service", "Сервисная"], ["manual", "Ручная"], ["send", "Отправка"], ["receive", "Получение"], ["script", "Скрипт"], ["business_rule", "Бизнес-правила"]],
  event: [["start", "Начальное"], ["intermediate", "Промежуточное"], ["end", "Конечное"]],
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
  const [x, y] = clampIntoLane(m, spec, snap(cx - size.w / 2), snapTop(cy - size.h / 2, size.h), lane);
  const node: ProcessNode = {
    id: nextId("n", m.nodes.map((n) => n.id)),
    type: spec.type,
    subtype: spec.subtype,
    ...(spec.trigger ? { trigger: structuredClone(spec.trigger) } : {}),
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
  const [x, y] = clampIntoLane(m, n, snap(b.x), snapTop(b.y, b.h), lane);
  return syncBoundaryRole(mapNode(m, id, (nn) => ({ ...nn, role_id: roleIdOfLane(m, lane), layout: { x, y } })), id);
}

/** Граничные события числятся в той же дорожке, что и их задача. */
function syncBoundaryRole(m: M, hostId: string): M {
  const host = m.nodes.find((n) => n.id === hostId);
  if (!host || !m.nodes.some((n) => n.attached_to === hostId)) return m;
  return { ...m, nodes: m.nodes.map((n) => (n.attached_to === hostId ? { ...n, role_id: host.role_id ?? null } : n)) };
}

export function setNodeRole(m: M, id: string, roleId: string | null): M {
  const n = m.nodes.find((x) => x.id === id);
  if (!n) return m;
  const lane = laneIndexOfRole(m, roleId);
  const b = boxOf(n);
  return syncBoundaryRole(mapNode(m, id, (nn) => ({ ...nn, role_id: roleId, layout: { x: b.x, y: laneTop(lane) + (LANE_H - b.h) / 2 } })), id);
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
    trigger: type === "event" ? nn.trigger : null,
    layout: { x: snap(old.x + (old.w - size.w) / 2), y: old.y + (old.h - size.h) / 2 }, // центр остаётся на месте
  }));
}

export const updateNode = (m: M, id: string, patch: Partial<ProcessNode>): M => mapNode(m, id, (n) => ({ ...n, ...patch }));

/** Вложенные функции IDEF0 (на любую глубину) принадлежат родителю и удаляются вместе с ним. */
function subtreeIds(m: M, id: string): Set<string> {
  const ids = new Set([id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const n of m.nodes) {
      // граничные события уходят вместе со своей задачей, шаги диаграммы операции — вместе с операцией
      if (((n.idef0_parent && ids.has(n.idef0_parent)) || (n.attached_to && ids.has(n.attached_to)) || (n.bpmn_scope && ids.has(n.bpmn_scope))) && !ids.has(n.id)) {
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
    messages: (m.messages ?? []).filter((x) => !gone.has(x.from) && !gone.has(x.to)),
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
  if (b.type === "event" && b.attached_to && m.nodes.some((n) => n.id === b.attached_to)) return { model: m, error: "В граничное событие нельзя вести стрелку — оно начинает ветку" };
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

// --- граничные события, внешние пулы и потоки сообщений ---

const BOUNDARY_NAMES: Partial<Record<TriggerType, string>> = {
  timer: "Срок истёк",
  message: "Сообщение получено",
  error: "Ошибка выполнения",
  signal: "Сигнал получен",
  conditional: "Условие выполнено",
  escalation: "Вопрос эскалирован",
  compensation: "Требуется компенсация",
  cancel: "Операция отменена",
};
/** Триггеры граничного события, которые предлагаются кнопками; остальные — в списке «Другой триггер». */
export const BOUNDARY_MAIN: TriggerType[] = ["timer", "message", "error", "signal"];
export const BOUNDARY_TRIGGERS: TriggerType[] = allowedTriggers("boundary").filter((t) => t !== "multiple" && t !== "parallel_multiple");

/** Граничное событие на границе задачи или подпроцесса: стоит на нижней границе, ветку из него ведут обычной стрелкой. */
export function addBoundaryEvent(m: M, hostId: string, trigger: TriggerType = "timer"): OpResult {
  const host = m.nodes.find((n) => n.id === hostId);
  if (!host || (host.type !== "task" && host.type !== "subprocess")) return { model: m, error: "Граничное событие прикрепляется к задаче или подпроцессу" };
  const node: ProcessNode = {
    id: nextId("n", m.nodes.map((n) => n.id)),
    type: "event",
    subtype: "intermediate",
    trigger: { type: trigger },
    name: BOUNDARY_NAMES[trigger] ?? "Событие",
    role_id: host.role_id ?? null,
    attached_to: hostId,
    interrupting: true,
    bpmn_scope: host.bpmn_scope ?? null,
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
  };
  return { model: { ...m, nodes: [...m.nodes, node] }, id: node.id };
}

// --- вид и триггер события ---

const isBoundaryOf = (m: M, n: ProcessNode) => !!n.attached_to && m.nodes.some((x) => x.id === n.attached_to);

/** Вид события: начальное, промежуточное, конечное. Триггер, который новому виду не подходит, сбрасывается. */
export function setEventPosition(m: M, id: string, position: Exclude<EventPosition, "boundary">): M {
  const n = m.nodes.find((x) => x.id === id);
  if (!n || n.type !== "event") return m;
  const cur = eventSpec(n, isBoundaryOf(m, n));
  const moved = { ...n, subtype: position, trigger: cur.trigger === "none" ? null : { ...cur.details, direction: position === "intermediate" ? cur.details.direction : undefined } };
  const spec = eventSpec(moved, false);
  const ok = allowedTriggers(spec.position, spec.throwing).includes(spec.trigger);
  return { ...m, nodes: m.nodes.map((x) => (x.id === id ? (ok ? moved : { ...moved, trigger: null }) : x)) };
}

/** Триггер события целиком (тип и параметры). Направление промежуточного события, которого тип не допускает, исправляется. */
export function setEventTrigger(m: M, id: string, trigger: EventTrigger | null): M {
  const n = m.nodes.find((x) => x.id === id);
  if (!n || n.type !== "event") return m;
  const boundary = isBoundaryOf(m, n);
  let next = trigger;
  if (next && !boundary && (n.subtype === "intermediate" || !n.subtype || ["timer", "message", "error", "signal"].includes(n.subtype))) {
    // промежуточное событие: если выбранный тип не допускает текущее направление, берём допустимое
    let throwing = next.direction ? next.direction === "throw" : eventSpec({ ...n, trigger: { type: next.type } }, false).throwing;
    if (!allowedTriggers("intermediate", throwing).includes(next.type)) throwing = !throwing;
    next = { ...next, direction: throwing ? "throw" : "catch" };
  }
  return { ...m, nodes: m.nodes.map((x) => (x.id === id ? withTrigger(x, next) : x)) };
}

/** Направление промежуточного события: ждёт (catch) или выбрасывает (throw); если триггер так не бывает, он сбрасывается. */
export function setEventDirection(m: M, id: string, direction: "catch" | "throw"): M {
  const n = m.nodes.find((x) => x.id === id);
  if (!n || n.type !== "event") return m;
  const spec = eventSpec(n, isBoundaryOf(m, n));
  const t = { ...spec.details, direction };
  return setEventTrigger(m, id, allowedTriggers("intermediate", direction === "throw").includes(spec.trigger) ? t : { type: "none", direction });
}
export function addPool(m: M, name: string, code?: string | null): OpResult {
  const pool: ExternalPool = { id: nextId("pool", (m.pools ?? []).map((p) => p.id)), name: name.trim() || "Внешний процесс", code: code?.trim() || null };
  return { model: { ...m, pools: [...(m.pools ?? []), pool] }, id: pool.id };
}

export const updatePool = (m: M, id: string, patch: Partial<ExternalPool>): M => ({ ...m, pools: (m.pools ?? []).map((p) => (p.id === id ? { ...p, ...patch } : p)) });

export const deletePool = (m: M, id: string): M => ({
  ...m,
  pools: (m.pools ?? []).filter((p) => p.id !== id),
  messages: (m.messages ?? []).filter((x) => x.from !== id && x.to !== id),
});

/** Поток сообщений между шагом (узлом) и внешним пулом: один конец — узел, другой — пул. */
export function addMessage(m: M, from: string, to: string, name?: string): OpResult {
  const isPool = (id: string) => (m.pools ?? []).some((p) => p.id === id);
  const isNode = (id: string) => m.nodes.some((n) => n.id === id);
  if (!((isPool(from) && isNode(to)) || (isNode(from) && isPool(to)))) return { model: m, error: "Поток сообщений соединяет шаг диаграммы и внешний пул" };
  if ((m.messages ?? []).some((x) => x.from === from && x.to === to)) return { model: m, error: "Такой поток сообщений уже есть" };
  const msg: MessageFlow = { id: nextId("msg", (m.messages ?? []).map((x) => x.id)), from, to, name: name?.trim() || null };
  return { model: { ...m, messages: [...(m.messages ?? []), msg] }, id: msg.id };
}

export const updateMessage = (m: M, id: string, patch: Partial<MessageFlow>): M => ({ ...m, messages: (m.messages ?? []).map((x) => (x.id === id ? { ...x, ...patch } : x)) });
export const deleteMessage = (m: M, id: string): M => ({ ...m, messages: (m.messages ?? []).filter((x) => x.id !== id) });