/**
 * Формат правок модели, которые предлагают агенты (Cline и его субагенты), и их применение.
 *
 * Агент ничего не меняет сам: он отправляет в приложение предложение — список операций над моделью. Человек видит,
 * что изменится и как изменятся проверки, и применяет предложение в студии (правки попадают в черновик, их можно
 * отменить). Применение — чистая функция: сервер проверяет с её помощью, что предложение вообще применимо, а редактор
 * применяет его к своему черновику. Код общий, без зависимостей — его подключает и клиент.
 */

import { functionCodes, stepCodes } from "./codes.js";
import { TRIGGER_TYPES, eventSpec, triggerProblem, triggerSummary, type EventTrigger, type TriggerType } from "./events.js";

export type PatchCollection = "roles" | "systems" | "data" | "controls" | "nodes" | "flows" | "pools" | "messages";

export const PATCH_COLLECTIONS: PatchCollection[] = ["roles", "systems", "data", "controls", "nodes", "flows", "pools", "messages"];

export type AssignmentKindName = "owner" | "executor" | "coexecutor" | "controller" | "observer";

export type PatchOp =
  /** Новая запись справочника, шаг, поток, пул или поток сообщений; id задаёт автор предложения (по нему же ссылаются следующие операции). */
  | { op: "add"; collection: PatchCollection; value: Record<string, unknown> }
  /** Изменение полей записи; id и состав связей других записей не меняются. */
  | { op: "update"; collection: PatchCollection; id: string; patch: Record<string, unknown> }
  /** Удаление вместе со всем, что на запись ссылается (шаги операции, потоки, назначения). */
  | { op: "remove"; collection: PatchCollection; id: string }
  /** Ролевая модель процесса (node_id = null) или функции: полностью заменяет назначения этого узла. */
  | { op: "set_assignments"; node_id: string | null; items: { role_id: string; kind: AssignmentKindName; functions?: string[] }[] }
  /** Атрибуты процесса. */
  | { op: "set_process"; patch: Partial<Record<"name" | "owner" | "department" | "author" | "goal" | "trigger" | "result" | "code" | "group", string>> };

export interface ModelPatch {
  ops: PatchOp[];
}

export interface PatchError {
  /** Номер операции в предложении (с 0); null — ошибка целостности модели после применения. */
  index: number | null;
  message: string;
}

type Rec = Record<string, any> & { id: string };

/** Что нужно от модели: все её коллекции — обычные массивы записей; лишние поля сохраняются как есть. */
export interface PatchModel {
  process: Record<string, any>;
  roles: Rec[];
  systems: Rec[];
  data: Rec[];
  controls: Rec[];
  nodes: Rec[];
  flows: Rec[];
  pools?: Rec[];
  messages?: Rec[];
  assignments?: { node_id: string | null; role_id: string; kind: string; functions?: string[] }[];
  raci: { node_id: string; role_id: string }[];
}

const NODE_TYPES = ["task", "event", "gateway", "subprocess"];
const PROCESS_FIELDS = ["name", "owner", "department", "author", "goal", "trigger", "result", "code", "group"];
const ASSIGNMENT_KINDS = ["owner", "executor", "coexecutor", "controller", "observer"];

const LABEL: Record<PatchCollection, string> = { roles: "должность", systems: "информационная система", data: "документ или данные", controls: "регламент или правило", nodes: "шаг", flows: "стрелка", pools: "внешний пул", messages: "поток сообщений" };

/** Значения по умолчанию новых записей — те же, что у схемы модели (zod default). Новые шаги агента — гипотезы, пока человек их не подтвердит. */
function withDefaults(collection: PatchCollection, value: Record<string, unknown>): Record<string, unknown> {
  switch (collection) {
    case "roles":
      return { kind: "internal", source: [], ...value };
    case "systems":
      return { source: [], ...value };
    case "data":
      return { kind: "document", source: [], ...value };
    case "controls":
      return { kind: "rule", source: [], ...value };
    case "nodes":
      return { system_ids: [], inputs: [], outputs: [], controls: [], status: "hypothesis", confidence: 0.5, source: [], requirement_ids: [], tags: [], confirmed_by: [], ...value };
    case "flows":
      return { condition: null, source: [], confirmed_by: [], ...value };
    default:
      return { ...value };
  }
}

const isStr = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

/** Обязательные поля новой записи. */
function checkNew(collection: PatchCollection, v: Record<string, unknown>): string | null {
  if (!isStr(v.id)) return "у новой записи нужен id (строка)";
  if (collection === "flows" || collection === "messages") {
    if (!isStr(v.from) || !isStr(v.to)) return "у связи нужны from и to";
    return null;
  }
  if (!isStr(v.name)) return "у новой записи нужно название (name)";
  if (collection === "nodes" && !NODE_TYPES.includes(v.type as string)) return `тип шага (type) — одно из: ${NODE_TYPES.join(", ")}`;
  return null;
}

const list = (m: PatchModel, c: PatchCollection): Rec[] => ((m as any)[c] as Rec[] | undefined) ?? [];
const setList = <M extends PatchModel>(m: M, c: PatchCollection, items: Rec[]): M => ({ ...m, [c]: items });

/** Идентификаторы шага и всего, что к нему относится: вложенные функции, шаги диаграммы операции, граничные события. */
function nodeFamily(m: PatchModel, id: string): Set<string> {
  const ids = new Set([id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const n of m.nodes) {
      if (ids.has(n.id)) continue;
      if ((n.idef0_parent && ids.has(n.idef0_parent)) || (n.bpmn_scope && ids.has(n.bpmn_scope)) || (n.attached_to && ids.has(n.attached_to))) {
        ids.add(n.id);
        grew = true;
      }
    }
  }
  return ids;
}

function removeRecord<M extends PatchModel>(m: M, collection: PatchCollection, id: string): M {
  const drop = <T extends { id: string }>(xs: T[]) => xs.filter((x) => x.id !== id);
  switch (collection) {
    case "nodes": {
      const gone = nodeFamily(m, id);
      return {
        ...m,
        nodes: m.nodes.filter((n) => !gone.has(n.id)),
        flows: m.flows.filter((f) => !gone.has(f.from) && !gone.has(f.to)),
        raci: m.raci.filter((r) => !gone.has(r.node_id)),
        ...(m.assignments ? { assignments: m.assignments.filter((a) => !a.node_id || !gone.has(a.node_id)) } : {}),
        ...(m.messages ? { messages: m.messages.filter((x) => !gone.has(x.from) && !gone.has(x.to)) } : {}),
      };
    }
    case "roles":
      return {
        ...m,
        roles: drop(m.roles),
        nodes: m.nodes.map((n) => (n.role_id === id ? { ...n, role_id: null } : n)),
        raci: m.raci.filter((r) => r.role_id !== id),
        ...(m.assignments ? { assignments: m.assignments.filter((a) => a.role_id !== id) } : {}),
      };
    case "data":
      return {
        ...m,
        data: drop(m.data),
        nodes: m.nodes.map((n) => ({
          ...n,
          inputs: (n.inputs ?? []).filter((x: string) => x !== id),
          outputs: (n.outputs ?? []).filter((x: string) => x !== id),
          ...(n.control_data_ids ? { control_data_ids: n.control_data_ids.filter((x: string) => x !== id) } : {}),
        })),
      };
    case "controls":
      return { ...m, controls: drop(m.controls), nodes: m.nodes.map((n) => ({ ...n, controls: (n.controls ?? []).filter((x: string) => x !== id) })) };
    case "systems":
      return { ...m, systems: drop(m.systems), nodes: m.nodes.map((n) => ({ ...n, system_ids: (n.system_ids ?? []).filter((x: string) => x !== id) })) };
    case "flows":
      return { ...m, flows: drop(m.flows) };
    case "pools":
      return { ...m, pools: drop(m.pools ?? []), messages: (m.messages ?? []).filter((x) => x.from !== id && x.to !== id) };
    case "messages":
      return { ...m, messages: drop(m.messages ?? []) };
  }
}

/** Нарушения целостности модели: ссылки на несуществующее, повторные id, потоки между диаграммами. */
export function integrityProblems(m: PatchModel): string[] {
  const out: string[] = [];
  const dup = (name: string, xs: { id: string }[]) => {
    const seen = new Set<string>();
    for (const x of xs) {
      if (seen.has(x.id)) out.push(`повторяется id «${x.id}» (${name})`);
      seen.add(x.id);
    }
  };
  dup("шаги", m.nodes);
  dup("должности", m.roles);
  dup("документы и данные", m.data);
  dup("регламенты", m.controls);
  dup("системы", m.systems);
  dup("стрелки", m.flows);
  dup("пулы", m.pools ?? []);
  dup("потоки сообщений", m.messages ?? []);

  const nodes = new Map(m.nodes.map((n) => [n.id, n] as const));
  const has = (xs: { id: string }[]) => new Set(xs.map((x) => x.id));
  const roles = has(m.roles);
  const data = has(m.data);
  const controls = has(m.controls);
  const systems = has(m.systems);
  const pools = has(m.pools ?? []);
  const label = (n: Rec) => `«${n.name}» (${n.id})`;
  const missing = (n: Rec, what: string, ids: string[] | undefined, known: Set<string>) => {
    for (const id of ids ?? []) if (!known.has(id)) out.push(`у шага ${label(n)} ${what} «${id}» не существует`);
  };
  for (const n of m.nodes) {
    if (n.role_id && !roles.has(n.role_id)) out.push(`у шага ${label(n)} исполнитель «${n.role_id}» не существует`);
    missing(n, "вход или выход", [...(n.inputs ?? []), ...(n.outputs ?? []), ...(n.control_data_ids ?? [])], data);
    missing(n, "регламент", n.controls, controls);
    missing(n, "система", n.system_ids, systems);
    if (n.idef0_parent && !nodes.has(n.idef0_parent)) out.push(`у шага ${label(n)} родитель IDEF0 «${n.idef0_parent}» не существует`);
    if (n.bpmn_scope) {
      const host = nodes.get(n.bpmn_scope);
      if (!host) out.push(`шаг ${label(n)} относится к операции «${n.bpmn_scope}», которой нет`);
      else if (host.bpmn_scope || (host.type !== "task" && host.type !== "subprocess")) out.push(`шаг ${label(n)}: «${n.bpmn_scope}» — не функция IDEF0, диаграмма BPMN бывает только у функции`);
    }
    if (n.type === "event" && n.trigger) {
      // триггер: известный тип и подходящий виду события (иначе предложение нарисует событие, не существующее в BPMN)
      if (!(TRIGGER_TYPES as readonly string[]).includes(n.trigger.type)) out.push(`событие ${label(n)}: неизвестный триггер «${n.trigger.type}»`);
      else {
        const problem = triggerProblem(eventSpec({ type: "event", subtype: n.subtype, trigger: n.trigger }, !!n.attached_to && nodes.has(n.attached_to)));
        if (problem) out.push(`событие ${label(n)}: ${problem}`);
      }
    }
    if (n.attached_to) {
      const host = nodes.get(n.attached_to);
      if (!host || (host.type !== "task" && host.type !== "subprocess")) out.push(`граничное событие ${label(n)} прикреплено не к задаче («${n.attached_to}»)`);
      else if ((host.bpmn_scope ?? null) !== (n.bpmn_scope ?? null)) out.push(`граничное событие ${label(n)} и его задача лежат на разных диаграммах`);
    }
  }
  for (const f of m.flows) {
    const a = nodes.get(f.from);
    const b = nodes.get(f.to);
    if (!a || !b) out.push(`стрелка «${f.id}» ведёт к несуществующему шагу (${f.from} → ${f.to})`);
    else if ((a.bpmn_scope ?? null) !== (b.bpmn_scope ?? null)) out.push(`стрелка «${f.id}» соединяет шаги разных диаграмм BPMN (${f.from} → ${f.to})`);
  }
  for (const x of m.messages ?? []) {
    const ok = (nodes.has(x.from) && pools.has(x.to)) || (pools.has(x.from) && nodes.has(x.to));
    if (!ok) out.push(`поток сообщений «${x.id}» должен связывать шаг и внешний пул (${x.from} → ${x.to})`);
  }
  for (const a of m.assignments ?? []) {
    if (a.node_id && !nodes.has(a.node_id)) out.push(`назначение роли ведёт к несуществующему шагу «${a.node_id}»`);
    if (!roles.has(a.role_id)) out.push(`назначение: должность «${a.role_id}» не существует`);
  }
  return out;
}

/**
 * Применяет предложение к модели. Всё или ничего: при любой ошибке модель возвращается неизменной вместе со списком
 * ошибок. Нарушения целостности, которые были в модели ещё до предложения, ошибками предложения не считаются.
 */
export function applyPatch<M extends PatchModel>(model: M, patch: ModelPatch): { model: M; errors: PatchError[] } {
  const errors: PatchError[] = [];
  let m = model;
  const fail = (index: number, message: string) => errors.push({ index, message });

  patch.ops.forEach((op, index) => {
    if (op.op === "set_process") {
      const bad = Object.keys(op.patch ?? {}).filter((k) => !PROCESS_FIELDS.includes(k));
      if (bad.length) return fail(index, `у процесса нельзя менять: ${bad.join(", ")}`);
      m = { ...m, process: { ...m.process, ...op.patch } };
      return;
    }
    if (op.op === "set_assignments") {
      if (op.node_id !== null && !m.nodes.some((n) => n.id === op.node_id)) return fail(index, `шага «${op.node_id}» нет`);
      for (const it of op.items) {
        if (!m.roles.some((r) => r.id === it.role_id)) return fail(index, `должности «${it.role_id}» нет`);
        if (!ASSIGNMENT_KINDS.includes(it.kind)) return fail(index, `вид роли «${it.kind}» неизвестен (${ASSIGNMENT_KINDS.join(", ")})`);
      }
      const rest = (m.assignments ?? []).filter((a) => a.node_id !== op.node_id);
      m = { ...m, assignments: [...rest, ...op.items.map((it) => ({ node_id: op.node_id, role_id: it.role_id, kind: it.kind, functions: it.functions ?? [] }))] };
      return;
    }
    if (!PATCH_COLLECTIONS.includes(op.collection)) return fail(index, `неизвестная коллекция «${(op as any).collection}»`);
    const items = list(m, op.collection);
    if (op.op === "add") {
      const value = withDefaults(op.collection, op.value ?? {});
      const problem = checkNew(op.collection, value);
      if (problem) return fail(index, problem);
      if (items.some((x) => x.id === value.id)) return fail(index, `${LABEL[op.collection]} с id «${value.id}» уже есть`);
      m = setList(m, op.collection, [...items, value as Rec]);
    } else if (op.op === "update") {
      if (!items.some((x) => x.id === op.id)) return fail(index, `${LABEL[op.collection]} «${op.id}» не найден(а)`);
      if ("id" in (op.patch ?? {}) && op.patch.id !== op.id) return fail(index, "id записи менять нельзя");
      const next = items.map((x) => (x.id === op.id ? { ...x, ...op.patch } : x));
      const updated = next.find((x) => x.id === op.id)!;
      const problem = checkNew(op.collection, updated);
      if (problem) return fail(index, problem);
      m = setList(m, op.collection, next);
    } else if (op.op === "remove") {
      if (!items.some((x) => x.id === op.id)) return fail(index, `${LABEL[op.collection]} «${op.id}» не найден(а)`);
      m = removeRecord(m, op.collection, op.id);
    } else {
      fail(index, `неизвестная операция «${(op as any).op}»`);
    }
  });

  if (errors.length === 0) {
    const before = new Set(integrityProblems(model));
    for (const message of integrityProblems(m)) if (!before.has(message)) errors.push({ index: null, message });
  }
  return errors.length > 0 ? { model, errors } : { model: m, errors };
}

// --- описание предложения для человека ---

const COLLECTION_NOUN: Record<PatchCollection, [string, string, string]> = {
  roles: ["должность", "должности", "должность"],
  systems: ["информационную систему", "информационной системы", "информационную систему"],
  data: ["документ или данные", "документа или данных", "документ или данные"],
  controls: ["регламент или правило", "регламента или правила", "регламент или правило"],
  nodes: ["шаг", "шага", "шаг"],
  flows: ["стрелку", "стрелки", "стрелку"],
  pools: ["внешний пул", "внешнего пула", "внешний пул"],
  messages: ["поток сообщений", "потока сообщений", "поток сообщений"],
};

const FIELD_NAMES: Record<string, string> = {
  name: "название",
  type: "тип",
  subtype: "вид",
  role_id: "исполнитель",
  inputs: "входы",
  outputs: "выходы",
  controls: "регламенты",
  control_data_ids: "управление-данные",
  system_ids: "системы",
  duration: "длительность",
  frequency: "частота",
  note: "заметка",
  description: "описание",
  owner: "ответственный",
  condition: "условие",
  from: "откуда",
  to: "куда",
  code: "код",
  supplier: "поставщик",
  consumer: "потребитель",
  value: "ценность",
  quality_standard: "стандарт качества",
  goal: "цель",
  trigger: "начало процесса",
  result: "результат",
  department: "подразделение",
  author: "автор",
  group: "группа процессов",
  qualification: "квалификация",
  attached_to: "прикреплено к",
  interrupting: "прерывает задачу",
  status: "статус",
};

/** Триггер события в описании правки: «Таймер: P3D», а не «[object Object]». */
const showTrigger = (v: { type: string }): string => triggerSummary({ position: "intermediate", trigger: v.type as TriggerType, throwing: false, details: v as EventTrigger });
const show = (v: unknown): string =>
  Array.isArray(v) ? v.join(", ") || "—" : v === null || v === undefined || v === "" ? "—" : typeof v === "object" && typeof (v as { type?: unknown }).type === "string" ? showTrigger(v as { type: string }) : String(v);
const fieldName = (collection: string, k: string) => (collection === "nodes" && k === "trigger" ? "триггер события" : FIELD_NAMES[k] ?? k);

/** Предложение по-русски: по строке на операцию, функции и шаги — с кодами по Соглашению. */
export function describePatch(model: PatchModel, patch: ModelPatch): string[] {
  const codes = new Map([...functionCodes(model as any), ...stepCodes(model as any)]);
  const nameOf = (c: PatchCollection, id: string): string => {
    const rec = list(model, c).find((x) => x.id === id);
    const added = patch.ops.find((o) => o.op === "add" && o.collection === c && (o.value as any)?.id === id) as { value: Record<string, any> } | undefined;
    const name = rec?.name ?? added?.value?.name ?? id;
    const code = c === "nodes" ? codes.get(id) : undefined;
    return `${code ? `${code} ` : ""}«${name}»`;
  };
  return patch.ops.map((op) => {
    switch (op.op) {
      case "set_process":
        return `Процесс: ${Object.entries(op.patch).map(([k, v]) => `${FIELD_NAMES[k] ?? k} → ${show(v)}`).join("; ")}`;
      case "set_assignments":
        return `Роли ${op.node_id === null ? "процесса" : nameOf("nodes", op.node_id)}: ${op.items.length === 0 ? "снять все" : op.items.map((i) => `${nameOf("roles", i.role_id)} — ${i.kind}`).join("; ")}`;
      case "add": {
        const v = op.value as Record<string, any>;
        const where = op.collection === "nodes" && v.bpmn_scope ? ` в BPMN операции ${nameOf("nodes", v.bpmn_scope)}` : op.collection === "nodes" && v.idef0_parent ? ` в декомпозиции ${nameOf("nodes", v.idef0_parent)}` : "";
        const detail = op.collection === "flows" || op.collection === "messages" ? `${show(v.from)} → ${show(v.to)}` : `«${v.name}»`;
        return `Добавить ${COLLECTION_NOUN[op.collection][0]} ${detail}${where}`;
      }
      case "update":
        return `Изменить ${COLLECTION_NOUN[op.collection][0]} ${nameOf(op.collection, op.id)}: ${Object.entries(op.patch).map(([k, v]) => `${fieldName(op.collection, k)} → ${show(v)}`).join("; ")}`;
      case "remove":
        return `Удалить ${COLLECTION_NOUN[op.collection][0]} ${nameOf(op.collection, op.id)}`;
    }
  });
}

// --- как предложение меняет проверки ---

export interface IssueLike {
  rule: string;
  message: string;
  element_id: string | null;
}

const issueKey = (i: IssueLike) => `${i.rule}|${i.element_id ?? ""}|${i.message}`;

/** Замечания проверки, которые предложение вносит и которые снимает. */
export function issueDelta<I extends IssueLike>(before: I[], after: I[]): { introduced: I[]; resolved: I[] } {
  const was = new Set(before.map(issueKey));
  const now = new Set(after.map(issueKey));
  return { introduced: after.filter((i) => !was.has(issueKey(i))), resolved: before.filter((i) => !now.has(issueKey(i))) };
}
