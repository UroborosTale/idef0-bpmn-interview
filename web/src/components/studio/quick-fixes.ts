import { parseProcessCode } from "@shared/codes";
import type { ProcessFlow, ProcessLogicModel, ProcessNode, ValidationIssue } from "../../types";
import { boxOf, sizeOf, withScopeLayouts } from "../bpmn-editor/geometry";
import { TRIGGER_LABELS, allowedTriggers, eventSpec, type TriggerType } from "@shared/events";
import { nextId, setEventTrigger } from "../bpmn-editor/model-ops";

type M = ProcessLogicModel;

/** Быстрое исправление замечания проверки: однозначное действие над моделью (его можно отменить Ctrl+Z). */
export interface QuickFix {
  label: string;
  /** Выбор значения (должность и т. п.): исправление применяется с выбранным id. */
  options?: { id: string; label: string }[];
  apply: (model: M, optionId?: string) => M;
}

type IssueRef = Pick<ValidationIssue, "rule" | "element_id" | "message">;

const roleOptions = (m: M) => m.roles.map((r) => ({ id: r.id, label: r.name }));

function blankNode(m: M, extra: Partial<ProcessNode> & Pick<ProcessNode, "type" | "name">, taken: string[] = []): ProcessNode {
  return {
    id: nextId("n", [...m.nodes.map((n) => n.id), ...taken]),
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
    ...extra,
  } as ProcessNode;
}

const newFlow = (m: M, from: string, to: string, condition: string | null = null, taken: string[] = []): ProcessFlow => ({
  id: nextId("flow", [...m.flows.map((f) => f.id), ...taken]),
  from,
  to,
  condition,
  source: [],
  confirmed_by: [],
});

/** Нормализованный код процесса: «b2», «В-002» → «B002.00.00»; null, если разобрать нечем. */
export function normalizedProcessCode(raw: string | null | undefined): string | null {
  const m = /^\s*([A-Za-zА-Яа-я])\s*[-_ .]?\s*(\d{1,3})(?:\.\d{2}\.\d{2})?\s*$/u.exec(raw ?? "");
  if (!m) return null;
  const letter = { А: "A", В: "B", С: "C", а: "A", в: "B", с: "C", Б: "B", б: "B" }[m[1]] ?? m[1].toUpperCase();
  if (!["A", "B", "C"].includes(letter)) return null;
  return `${letter}${m[2].padStart(3, "0")}.00.00`;
}

const scopeOf = (n: ProcessNode) => n.bpmn_scope ?? null;
const sameDiagram = (a: ProcessNode, b: ProcessNode) => scopeOf(a) === scopeOf(b) && (scopeOf(a) !== null || (!a.idef0_parent && !b.idef0_parent));

/** Роль, чьи шаги чаще всего стоят на диаграмме операции: по ней назначается исполнитель операции. */
function dominantRole(m: M, opId: string): string | null {
  const counts = new Map<string, number>();
  for (const n of m.nodes) if (n.bpmn_scope === opId && n.role_id && n.type !== "event" && n.type !== "gateway") counts.set(n.role_id, (counts.get(n.role_id) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

const withAssignment = (m: M, nodeId: string | null, roleId: string, kind: "owner" | "executor"): M => ({
  ...m,
  assignments: [...(m.assignments ?? []), { node_id: nodeId, role_id: roleId, kind, functions: [] }],
  nodes: kind === "executor" ? m.nodes.map((n) => (n.id === nodeId && !n.role_id ? { ...n, role_id: roleId } : n)) : m.nodes,
});

/** Заготовка диаграммы операции: начало → шаг → конец, дорожка — исполнитель операции. */
export function addOperationSkeleton(m: M, opId: string): M {
  const op = m.nodes.find((n) => n.id === opId);
  if (!op) return m;
  const role = op.role_id ?? (m.assignments ?? []).find((a) => a.node_id === opId && (a.kind === "executor" || a.kind === "coexecutor"))?.role_id ?? null;
  const common = { bpmn_scope: opId, role_id: role, idef0_parent: null };
  const start = blankNode(m, { ...common, type: "event", subtype: "start", name: "Операция запущена" });
  const task = blankNode(m, { ...common, type: "task", subtype: "user", name: op.name }, [start.id]);
  const end = blankNode(m, { ...common, type: "event", subtype: "end", name: "Операция завершена" }, [start.id, task.id]);
  const f1 = newFlow(m, start.id, task.id);
  const f2 = newFlow(m, task.id, end.id, null, [f1.id]);
  return withScopeLayouts({ ...m, nodes: [...m.nodes, start, task, end], flows: [...m.flows, f1, f2] });
}

/** Вставляет шлюз до или после шага: стрелки шага переключаются на шлюз. */
function insertGateway(m: M, node: ProcessNode, side: "after" | "before"): M {
  const box = boxOf(node);
  const g = sizeOf({ type: "gateway" });
  const gateway = blankNode(m, {
    type: "gateway",
    subtype: "exclusive",
    name: side === "after" ? "Развилка" : "Слияние потоков",
    role_id: node.role_id ?? null,
    bpmn_scope: node.bpmn_scope ?? null,
    layout: { x: side === "after" ? box.x + box.w + 40 : box.x - g.w - 40, y: box.y + (box.h - g.h) / 2 },
  });
  const link = side === "after" ? newFlow(m, node.id, gateway.id) : newFlow(m, gateway.id, node.id);
  const flows = m.flows.map((f) => (side === "after" && f.from === node.id ? { ...f, from: gateway.id } : side === "before" && f.to === node.id ? { ...f, to: gateway.id } : f));
  return { ...m, nodes: [...m.nodes, gateway], flows: [...flows, link] };
}

/**
 * Быстрое исправление для замечания, если у него есть однозначное решение; иначе null (замечание решает аналитик).
 * Исправления работают с полной моделью, поэтому их можно применять с любой диаграммы.
 */
export function quickFixFor(m: M, issue: IssueRef): QuickFix | null {
  const id = issue.element_id;
  const node = id ? m.nodes.find((n) => n.id === id) : undefined;

  switch (issue.rule) {
    case "process_code_format": {
      const code = normalizedProcessCode(m.process.code);
      if (!code || code === m.process.code || !parseProcessCode(code)) return null;
      return { label: `Привести код к виду ${code}`, apply: (x) => ({ ...x, process: { ...x.process, code } }) };
    }

    case "bpmn_gateway_unbalanced": {
      if (!node || node.type !== "gateway") return null;
      const ins = m.flows.filter((f) => f.to === node.id);
      const outs = m.flows.filter((f) => f.from === node.id);
      if (ins.length === 1 && outs.length === 1) {
        return {
          label: "Убрать лишний шлюз, соединив соседние шаги",
          apply: (x) => {
            const [a] = x.flows.filter((f) => f.to === node.id);
            const [b] = x.flows.filter((f) => f.from === node.id);
            if (!a || !b) return x;
            const through = { ...newFlow(x, a.from, b.to, b.condition ?? a.condition ?? null) };
            return { ...x, nodes: x.nodes.filter((n) => n.id !== node.id), flows: [...x.flows.filter((f) => f !== a && f !== b), through] };
          },
        };
      }
      return { label: "Удалить шлюз без ветвления", apply: (x) => ({ ...x, nodes: x.nodes.filter((n) => n.id !== node.id), flows: x.flows.filter((f) => f.from !== node.id && f.to !== node.id) }) };
    }

    case "idef0_self_loop": {
      if (!node) return null;
      return {
        label: "Убрать петлю: вход, совпадающий с выходом",
        apply: (x) => ({
          ...x,
          nodes: x.nodes.map((n) =>
            n.id === node.id
              ? { ...n, inputs: n.inputs.filter((d) => !n.outputs.includes(d)), ...(n.control_data_ids ? { control_data_ids: n.control_data_ids.filter((d) => !n.outputs.includes(d)) } : {}) }
              : n
          ),
        }),
      };
    }

    case "bpmn_boundary_no_host":
      if (!node) return null;
      return { label: "Открепить событие от задачи", apply: (x) => ({ ...x, nodes: x.nodes.map((n) => (n.id === node.id ? { ...n, attached_to: null } : n)) }) };

    case "bpmn_boundary_incoming":
      if (!node) return null;
      return { label: "Убрать входящие стрелки события", apply: (x) => ({ ...x, flows: x.flows.filter((f) => f.to !== node.id) }) };

    case "bpmn_event_trigger_invalid":
    case "bpmn_boundary_no_trigger": {
      if (!node || node.type !== "event") return null;
      const spec = eventSpec(node, !!node.attached_to && m.nodes.some((n) => n.id === node.attached_to));
      const choices = allowedTriggers(spec.position, spec.throwing) as TriggerType[];
      return {
        label: "Выбрать подходящий триггер…",
        options: choices.map((t) => ({ id: t, label: TRIGGER_LABELS[t] })),
        apply: (x, t) => (t ? setEventTrigger(x, node.id, t === "none" ? null : { type: t as TriggerType, ...(spec.position === "intermediate" ? { direction: spec.throwing ? "throw" : "catch" } : {}) }) : x),
      };
    }

    case "bpmn_message_endpoint":
      if (!node) return null;
      return { label: "Убрать потоки сообщений у этого элемента", apply: (x) => ({ ...x, messages: (x.messages ?? []).filter((msg) => msg.from !== node.id && msg.to !== node.id) }) };

    case "role_no_executor": {
      if (!node) return null;
      const role = dominantRole(m, node.id);
      if (role) {
        const name = m.roles.find((r) => r.id === role)?.name ?? role;
        return { label: `Назначить исполнителем «${name}» (чаще всего стоит в шагах диаграммы)`, apply: (x) => withAssignment(x, node.id, role, "executor") };
      }
      if (m.roles.length === 0) return null;
      return { label: "Назначить исполнителя…", options: roleOptions(m), apply: (x, roleId) => (roleId ? withAssignment(x, node.id, roleId, "executor") : x) };
    }

    case "role_no_owner":
      if (m.roles.length === 0) return null;
      return { label: "Назначить владельца…", options: roleOptions(m), apply: (x, roleId) => (roleId ? withAssignment(x, id ?? null, roleId, "owner") : x) };

    case "operation_no_bpmn":
      if (!node) return null;
      return { label: "Создать заготовку диаграммы BPMN", apply: (x) => addOperationSkeleton(x, node.id) };

    case "bpmn_dead_end": {
      if (!node) return null;
      const ends = m.nodes.filter((n) => n.type === "event" && n.subtype === "end" && sameDiagram(n, node) && n.id !== node.id);
      if (ends.length === 1) {
        const end = ends[0];
        return { label: `Соединить с конечным событием «${end.name}»`, apply: (x) => ({ ...x, flows: [...x.flows, newFlow(x, node.id, end.id)] }) };
      }
      return {
        label: "Добавить конечное событие и соединить",
        apply: (x) => {
          const box = boxOf(node);
          const e = sizeOf({ type: "event" });
          const end = blankNode(x, {
            type: "event",
            subtype: "end",
            name: node.bpmn_scope ? "Операция завершена" : "Процесс завершён",
            role_id: node.role_id ?? null,
            bpmn_scope: node.bpmn_scope ?? null,
            layout: { x: box.x + box.w + 60, y: box.y + (box.h - e.h) / 2 },
          });
          return { ...x, nodes: [...x.nodes, end], flows: [...x.flows, newFlow(x, node.id, end.id)] };
        },
      };
    }

    case "bpmn_split_without_gateway":
      if (!node) return null;
      return { label: "Добавить шлюз после шага", apply: (x) => insertGateway(x, x.nodes.find((n) => n.id === node.id) ?? node, "after") };

    case "bpmn_merge_without_gateway":
      if (!node) return null;
      return { label: "Добавить шлюз слияния перед шагом", apply: (x) => insertGateway(x, x.nodes.find((n) => n.id === node.id) ?? node, "before") };

    case "data_ref_unknown_code":
    case "data_ref_mismatch": {
      const d = id ? m.data.find((x) => x.id === id) : undefined;
      if (!d) return null;
      const field = issue.message.includes("потребитель") ? "consumer" : "supplier";
      return { label: field === "consumer" ? "Очистить поле «Потребитель»" : "Очистить поле «Поставщик»", apply: (x) => ({ ...x, data: x.data.map((y) => (y.id === d.id ? { ...y, [field]: null } : y)) }) };
    }

    default:
      return null;
  }
}

/** Принять замечание: отклонение признано осознанным, причина записывается в модель (отменяется Ctrl+Z, возвращается кнопкой «Вернуть»). */
export function acceptIssue(m: M, issue: IssueRef, reason: string): M {
  const entry = { rule: issue.rule, element_id: issue.element_id ?? null, message: issue.element_id ? null : issue.message, reason: reason.trim(), at: new Date().toISOString() };
  const rest = (m.accepted_issues ?? []).filter((a) => !(a.rule === entry.rule && a.element_id === entry.element_id && (a.element_id ? true : a.message === entry.message)));
  return { ...m, accepted_issues: [...rest, entry] };
}

/** Вернуть принятое замечание в число действующих. */
export function revokeAcceptance(m: M, issue: IssueRef): M {
  return { ...m, accepted_issues: (m.accepted_issues ?? []).filter((a) => !(a.rule === issue.rule && a.element_id === (issue.element_id ?? null) && (a.element_id ? true : a.message === issue.message))) };
}
