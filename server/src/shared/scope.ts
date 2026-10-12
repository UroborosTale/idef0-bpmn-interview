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
  /** Внешние пулы и потоки сообщений: вид области содержит потоки её шагов и пулы, с которыми они связаны. */
  pools?: { id: string; scope?: string }[];
  messages?: { id: string; from: string; to: string }[];
  /**
   * Ширина дорожек диаграмм: в полной модели ключ — id операции ("" — общая схема); в виде области — только ключ "" (ширина показанной
   * диаграммы), чтобы редактор и генератор не знали, какая это область.
   */
  diagram_widths?: Record<string, number>;
  /** Настройка процесса, которую меняют на диаграмме: высота дорожки «Без исполнителя» (у неё нет роли, чтобы хранить её там). */
  process?: { unassigned_lane_height?: number | null };
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
  const messages = (m.messages ?? []).filter((x) => ids.has(x.from) || ids.has(x.to));
  const usedPools = new Set(messages.flatMap((x) => [x.from, x.to]));
  // самостоятельный пул (без потоков сообщений) виден на диаграмме, где его создали
  const linked = new Set((m.messages ?? []).flatMap((x) => [x.from, x.to]));
  const here = (p: { id: string; scope?: string }) => usedPools.has(p.id) || (!linked.has(p.id) && (p.scope ?? "") === (scope ?? ""));
  return {
    ...m,
    nodes: view,
    flows: m.flows.filter((f) => ids.has(f.from) && ids.has(f.to)),
    roles: lanes ? m.roles.filter((r) => lanes.has(r.id)) : m.roles,
    ...(scope !== null ? { diagram_widths: m.diagram_widths?.[scope] === undefined ? undefined : { "": m.diagram_widths[scope] } } : {}),
    ...(m.messages ? { messages, pools: (m.pools ?? []).filter(here) } : {}),
  };
}

/**
 * Редактор выдаёт id новым узлам и стрелкам по виду области, не зная о шагах других диаграмм: «n4» мог уже быть узлом
 * другой диаграммы. Такие совпадения получают свободные id; ссылки в новых узлах, стрелках и потоках сообщений
 * переписываются.
 */
function freshenIds<M extends ScopeModel>(full: M, next: M, prevIds: Set<string>, scope: string | null): M {
  const taken = new Set([...full.nodes.map((n) => n.id), ...next.nodes.map((n) => n.id)]);
  const nodeMap = new Map<string, string>();
  for (const n of next.nodes) {
    if (prevIds.has(n.id) || !full.nodes.some((x) => x.id === n.id)) continue;
    let i = taken.size + 1;
    while (taken.has(`n${i}`)) i++;
    nodeMap.set(n.id, `n${i}`);
    taken.add(`n${i}`);
  }
  const keptFlows = new Set(full.flows.filter((f) => !(prevIds.has(f.from) && prevIds.has(f.to))).map((f) => f.id));
  const flowTaken = new Set([...full.flows.map((f) => f.id), ...next.flows.map((f) => f.id)]);
  const flowMap = new Map<string, string>();
  for (const f of next.flows) {
    if (!keptFlows.has(f.id)) continue;
    let i = flowTaken.size + 1;
    while (flowTaken.has(`flow${i}`)) i++;
    flowMap.set(f.id, `flow${i}`);
    flowTaken.add(`flow${i}`);
  }
  if (nodeMap.size === 0 && flowMap.size === 0) return next;
  const node = (id: string) => nodeMap.get(id) ?? id;
  return {
    ...next,
    nodes: next.nodes.map((n) => {
      const attached = (n as { attached_to?: string | null }).attached_to;
      return nodeMap.has(n.id) || (attached && nodeMap.has(attached)) ? { ...n, id: node(n.id), ...(attached ? { attached_to: node(attached) } : {}) } : n;
    }),
    flows: next.flows.map((f) => (nodeMap.has(f.from) || nodeMap.has(f.to) || flowMap.has(f.id) ? { ...f, id: flowMap.get(f.id) ?? f.id, from: node(f.from), to: node(f.to) } : f)),
    ...(next.messages ? { messages: next.messages.map((x) => (nodeMap.has(x.from) || nodeMap.has(x.to) ? { ...x, from: node(x.from), to: node(x.to) } : x)) } : {}),
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
  next = freshenIds(full, next, prevIds, scope);
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

  // потоки сообщений области пересобираются; пулы — общие, новые из вида добавляются
  let messages = full.messages;
  let pools = full.pools;
  if (messages) {
    messages = [...messages.filter((x) => !prevIds.has(x.from) && !prevIds.has(x.to)), ...(next.messages ?? []).filter((x) => !removed.includes(x.from) && !removed.includes(x.to))];
    const poolIds = new Set((pools ?? []).map((p) => p.id));
    pools = [...(pools ?? []).map((p) => (next.pools?.find((x) => x.id === p.id) as typeof p | undefined) ?? p), ...(next.pools ?? []).filter((p) => !poolIds.has(p.id))];
  }

  let assignments = full.assignments;
  if (scope !== null && assignments) {
    const fresh = next.roles.filter((r) => !known.has(r.id));
    assignments = [...assignments, ...fresh.map((r) => ({ node_id: scope, role_id: r.id, kind: "executor", functions: [] }))];
  }
  if (removed.length > 0 && assignments) assignments = assignments.filter((a) => !a.node_id || !removed.includes(a.node_id));

  // высота дорожки «Без исполнителя» меняется на диаграмме, а хранится в настройках процесса
  const laneH = next.process?.unassigned_lane_height;
  const process = full.process && next.process && laneH !== full.process.unassigned_lane_height ? { ...full.process, unassigned_lane_height: laneH } : full.process;

  // ширина дорожек показанной диаграммы: в виде она под ключом "", в модели — под id области
  const key = scope ?? "";
  const width = next.diagram_widths?.[""];
  let diagram_widths = full.diagram_widths;
  if (width !== full.diagram_widths?.[key]) {
    const copy = { ...(full.diagram_widths ?? {}) };
    if (width === undefined) delete copy[key];
    else copy[key] = width;
    diagram_widths = Object.keys(copy).length > 0 ? copy : undefined;
  }

  return {
    ...full,
    ...(process ? { process } : {}),
    ...(diagram_widths !== full.diagram_widths ? { diagram_widths } : {}),
    nodes,
    flows,
    roles,
    raci: removed.length ? full.raci.filter((r) => !removed.includes(r.node_id)) : full.raci,
    ...(assignments ? { assignments } : {}),
    ...(messages ? { messages, pools } : {}),
  };
}
