/**
 * Диаграммы BPMN по операциям. Шаги диаграммы операции хранятся в общем списке узлов с полем bpmn_scope
 * (id операции). Чтобы редактор, генератор BPMN и проверки работали с ними как с обычной диаграммой,
 * модель сужается до «вида» области (scopeView), а правки вида вливаются обратно (mergeScope).
 *
 * Область null — общая схема процесса: все узлы без bpmn_scope (прежнее поведение, без изменений для
 * моделей, где операций с собственными диаграммами нет).
 */

import type { CodeNode } from "./codes.js";

export interface ScopeNode extends CodeNode {
  role_id?: string | null;
}

export interface ScopeRole {
  id: string;
}

export interface ScopeModel<N extends ScopeNode = ScopeNode, R extends ScopeRole = ScopeRole> {
  nodes: N[];
  flows: { id: string; from: string; to: string }[];
  roles: R[];
  raci: { node_id: string }[];
  assignments?: { node_id: string | null; role_id: string; kind: string }[];
}

/** Виды ролей, чьи должности образуют дорожки диаграммы операции. */
const LANE_KINDS = new Set(["executor", "coexecutor"]);

const inScope = (n: CodeNode, scope: string | null) => (scope === null ? !n.bpmn_scope : n.bpmn_scope === scope);

/** Дорожки диаграммы операции — исполнители и соисполнители операции и исполнители её шагов. */
export function laneRoleIds(m: ScopeModel, scope: string): Set<string> {
  const ids = new Set<string>();
  const host = m.nodes.find((n) => n.id === scope);
  if (host?.role_id) ids.add(host.role_id);
  for (const a of m.assignments ?? []) if (a.node_id === scope && LANE_KINDS.has(a.kind)) ids.add(a.role_id);
  for (const n of m.nodes) if (n.bpmn_scope === scope && n.role_id) ids.add(n.role_id);
  return ids;
}

/** Область диаграммы как самостоятельная модель: её узлы, потоки между ними и дорожки. */
export function scopeView<M extends ScopeModel>(m: M, scope: string | null): M {
  const nodes = m.nodes.filter((n) => inScope(n, scope));
  if (scope === null && nodes.length === m.nodes.length) return m; // операций с диаграммами нет — вид совпадает с моделью
  const ids = new Set(nodes.map((n) => n.id));
  const view = scope === null ? nodes : nodes.map((n) => ({ ...n, bpmn_scope: undefined, idef0_parent: null }));
  const lanes = scope === null ? null : laneRoleIds(m, scope);
  return {
    ...m,
    nodes: view,
    flows: m.flows.filter((f) => ids.has(f.from) && ids.has(f.to)),
    roles: lanes ? m.roles.filter((r) => lanes.has(r.id)) : m.roles,
  };
}

/**
 * Вливает правки вида области в полную модель: узлы области заменяются (порядок сохраняется, новые — в конец),
 * потоки области пересобираются, новые дорожки становятся ролями модели и исполнителями операции.
 * Если вид не менялся (next === prevView), возвращается сама модель.
 */
export function mergeScope<M extends ScopeModel>(full: M, next: M, scope: string | null, prevView?: M): M {
  if (prevView && next === prevView) return full;
  if (scope === null && next === full) return full;
  const prevIds = new Set(full.nodes.filter((n) => inScope(n, scope)).map((n) => n.id));
  const nextById = new Map(next.nodes.map((n) => [n.id, n] as const));
  const mark = <N extends ScopeNode>(n: N): N => (scope === null ? n : { ...n, bpmn_scope: scope, idef0_parent: null });

  const nodes: M["nodes"] = [];
  for (const n of full.nodes) {
    if (!inScope(n, scope)) nodes.push(n);
    else if (nextById.has(n.id)) nodes.push(mark(nextById.get(n.id)!));
  }
  for (const n of next.nodes) if (!prevIds.has(n.id)) nodes.push(mark(n));
  const removed = [...prevIds].filter((id) => !nextById.has(id));

  const flows = [...full.flows.filter((f) => !(prevIds.has(f.from) && prevIds.has(f.to))), ...next.flows];

  const known = new Map(full.roles.map((r) => [r.id, r] as const));
  const roles = [...full.roles.map((r) => (next.roles.find((x) => x.id === r.id) as typeof r | undefined) ?? r), ...next.roles.filter((r) => !known.has(r.id))];

  let assignments = full.assignments;
  if (scope !== null && assignments) {
    const fresh = next.roles.filter((r) => !known.has(r.id));
    assignments = [...assignments, ...fresh.map((r) => ({ node_id: scope, role_id: r.id, kind: "executor", functions: [] }))];
  }
  if (removed.length > 0 && assignments) assignments = assignments.filter((a) => !a.node_id || !removed.includes(a.node_id));

  return {
    ...full,
    nodes,
    flows,
    roles,
    raci: removed.length ? full.raci.filter((r) => !removed.includes(r.node_id)) : full.raci,
    ...(assignments ? { assignments } : {}),
  };
}
