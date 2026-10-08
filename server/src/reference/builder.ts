/**
 * Компактное описание диаграмм BPMN операций для эталонных и демонстрационных процессов (reference/*.ts): шаги, события,
 * шлюзы, граничные события, документы и системы у задач, дорожки, потоки сообщений с внешними пулами. Сборка в узлы и
 * стрелки модели — buildDiagram.
 */

import type { EventTrigger, TriggerType } from "../shared/events.js";

export type TaskKind = "user" | "manual" | "service" | "send" | "receive" | "business_rule";

export interface StepOpts {
  /** Вид задачи: по умолчанию пользовательская. */
  k?: TaskKind;
  /** Роль-исполнитель шага (ключ из словаря ролей); по умолчанию — роль диаграммы. */
  r?: string;
  in?: string[];
  out?: string[];
  /** Системы (хранилища данных) и регламенты (аннотации). */
  sys?: string[];
  ctl?: string[];
  /** Срок выполнения шага («1 день», «2 рабочих дня»). */
  dur?: string;
}

export type Item =
  | ({ kind: "task"; key: string; name: string } & StepOpts)
  | { kind: "sub"; key: string; name: string; r?: string }
  /** Событие: k — вид (start, end) или ждущее промежуточное с триггером (timer, message); trg — параметры и направление триггера. */
  | { kind: "event"; key: string; k: "start" | "end" | "timer" | "message" | "intermediate"; name: string; r?: string; trg?: EventTrigger }
  | { kind: "gw"; key: string; k: "exclusive" | "parallel"; name: string; r?: string }
  /** Граничное событие на задаче host: прерывающее (interrupting) или нет. */
  | { kind: "boundary"; key: string; host: string; k: TriggerType; name: string; interrupting: boolean; trg?: EventTrigger };

export const T = (key: string, name: string, o: StepOpts = {}): Item => ({ kind: "task", key, name, ...o });
export const SUB = (key: string, name: string, r?: string): Item => ({ kind: "sub", key, name, r });
export const START = (key: string, name: string, r?: string): Item => ({ kind: "event", key, k: "start", name, r });
export const END = (key: string, name: string, r?: string): Item => ({ kind: "event", key, k: "end", name, r });
export const TIMER = (key: string, name: string, r?: string, timer?: { kind: "date" | "duration" | "cycle"; value: string }): Item => ({ kind: "event", key, k: "timer", name, r, ...(timer ? { trg: { type: "timer", direction: "catch", timer } } : {}) });
/** События-сообщения: начало по сообщению, ожидание, отправка (промежуточное выбрасывающее), конец с отправкой. msg — название сообщения. */
export const MSG_START = (key: string, name: string, msg?: string, r?: string): Item => ({ kind: "event", key, k: "start", name, r, trg: { type: "message", ...(msg ? { name: msg } : {}) } });
export const MSG_CATCH = (key: string, name: string, msg?: string, r?: string): Item => ({ kind: "event", key, k: "intermediate", name, r, trg: { type: "message", direction: "catch", ...(msg ? { name: msg } : {}) } });
export const MSG_SEND = (key: string, name: string, msg?: string, r?: string): Item => ({ kind: "event", key, k: "intermediate", name, r, trg: { type: "message", direction: "throw", ...(msg ? { name: msg } : {}) } });
export const MSG_END = (key: string, name: string, msg?: string, r?: string): Item => ({ kind: "event", key, k: "end", name, r, trg: { type: "message", ...(msg ? { name: msg } : {}) } });
export const XOR = (key: string, name = "Слияние потоков", r?: string): Item => ({ kind: "gw", key, k: "exclusive", name, r });
export const AND = (key: string, name = "Слияние потоков", r?: string): Item => ({ kind: "gw", key, k: "parallel", name, r });
export const BOUNDARY = (key: string, host: string, k: TriggerType, name: string, interrupting: boolean, trg?: Omit<EventTrigger, "type">): Item => ({ kind: "boundary", key, host, k, name, interrupting, ...(trg ? { trg: { type: k, ...trg } } : {}) });

/** Стрелка с условием; без условия стрелки строятся цепочкой ключей. */
export interface CondFlow {
  from: string;
  to: string;
  cond: string;
}
export const IF = (from: string, to: string, cond: string): CondFlow => ({ from, to, cond });

export interface Diagram {
  /** id операции — область диаграммы (bpmn_scope). */
  op: string;
  /** Роль по умолчанию (ключ из словаря ролей). */
  role: string;
  items: Item[];
  flows: (string[] | CondFlow)[];
  /** Потоки сообщений: ключ шага ↔ id внешнего пула, направление задаёт порядок. */
  messages?: { from: string; to: string; name?: string }[];
}

export interface Dict {
  /** Ключи словарей → id записей модели. */
  role: (key: string) => string;
  data: (key: string) => string;
  system: (key: string) => string;
  control: (key: string) => string;
  /** Подтверждение содержимого: confirmed — из интервью, hypothesis — предположение. */
  status: "confirmed" | "hypothesis";
}

export const stepId = (op: string, key: string) => `${op}_${key}`;

export function buildDiagram(d: Diagram, dict: Dict): { nodes: Record<string, unknown>[]; flows: Record<string, unknown>[]; messages: Record<string, unknown>[] } {
  const nodes: Record<string, unknown>[] = [];
  const flows: Record<string, unknown>[] = [];
  const confidence = dict.status === "confirmed" ? 1 : 0.5;
  const base = (role: string | undefined) => ({ bpmn_scope: d.op, role_id: dict.role(role ?? d.role), status: dict.status, confidence });
  const roleOfKey = new Map<string, string>();
  for (const it of d.items) roleOfKey.set(it.key, ("r" in it && it.r) || d.role);

  for (const it of d.items) {
    const id = stepId(d.op, it.key);
    if (it.kind === "task") {
      nodes.push({ ...base(it.r), id, type: "task", subtype: it.k ?? "user", name: it.name, inputs: (it.in ?? []).map(dict.data), outputs: (it.out ?? []).map(dict.data), system_ids: (it.sys ?? []).map(dict.system), controls: (it.ctl ?? []).map(dict.control), duration: it.dur ?? null });
    } else if (it.kind === "sub") {
      nodes.push({ ...base(it.r), id, type: "subprocess", name: it.name });
    } else if (it.kind === "event") {
      // ждущее промежуточное событие с триггером: вид — intermediate, сам триггер — в trigger
      const waits = it.k === "timer" || it.k === "message";
      const trigger = it.trg ?? (waits ? { type: it.k, direction: "catch" as const } : undefined);
      nodes.push({ ...base(it.r), id, type: "event", subtype: waits ? "intermediate" : it.k, ...(trigger ? { trigger } : {}), name: it.name });
    } else if (it.kind === "gw") {
      nodes.push({ ...base(it.r), id, type: "gateway", subtype: it.k, name: it.name });
    } else {
      // граничное событие числится в дорожке своей задачи
      nodes.push({ ...base(roleOfKey.get(it.host)), id, type: "event", subtype: "intermediate", trigger: it.trg ?? { type: it.k }, name: it.name, attached_to: stepId(d.op, it.host), interrupting: it.interrupting });
    }
  }

  let n = 0;
  const link = (from: string, to: string, condition?: string) => flows.push({ id: `${d.op}_f${++n}`, from: stepId(d.op, from), to: stepId(d.op, to), condition: condition ?? null });
  for (const f of d.flows) {
    if (Array.isArray(f)) for (let i = 0; i + 1 < f.length; i++) link(f[i], f[i + 1]);
    else link(f.from, f.to, f.cond);
  }

  const messages = (d.messages ?? []).map((m, i) => {
    const isStep = (k: string) => d.items.some((it) => it.key === k);
    return { id: `${d.op}_m${i + 1}`, from: isStep(m.from) ? stepId(d.op, m.from) : m.from, to: isStep(m.to) ? stepId(d.op, m.to) : m.to, name: m.name ?? null };
  });
  return { nodes, flows, messages };
}
