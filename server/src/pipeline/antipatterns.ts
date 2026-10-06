import type { ProcessLogicModel, ProcessNode, SourceRef } from "../types/model.js";
import { APPROVE_STEMS, CONSULT_STEMS } from "./raci.js";

export type AntipatternRule = "double_entry" | "manual_handoff" | "excessive_approval" | "step_without_output" | "loop_without_exit" | "ping_pong";

export interface AntipatternFinding {
  id: string;
  rule: AntipatternRule;
  label: string;
  elementIds: string[];
  explanation: string;
  quotes: SourceRef[];
}

const RULE_LABEL: Record<AntipatternRule, string> = {
  double_entry: "Двойной ввод",
  manual_handoff: "Ручная передача между системами",
  excessive_approval: "Избыточное согласование",
  step_without_output: "Шаг без выхода",
  loop_without_exit: "Петля без выхода по сроку",
  ping_pong: "Пинг-понг",
};

const TIMER_OR_COUNT_MARKERS = ["раз", "попытк", "более", "после", "лимит", "не более"];

/** ФТ-М2.3: каталог антипаттернов — детерминированные правила по PLM, расширяемый. */
export function detectAntipatterns(model: ProcessLogicModel): AntipatternFinding[] {
  const findings: AntipatternFinding[] = [];
  const nodeById = new Map(model.nodes.map((n) => [n.id, n] as const));
  const outAdj = new Map<string, typeof model.flows>();
  for (const f of model.flows) outAdj.set(f.from, [...(outAdj.get(f.from) ?? []), f]);

  // --- Двойной ввод: один объект данных — вход у шагов в ДВУХ РАЗНЫХ системах ---
  const dataConsumerSystems = new Map<string, Set<string>>(); // data_id -> systems
  const dataConsumerNodes = new Map<string, ProcessNode[]>();
  for (const n of model.nodes) {
    for (const dataId of n.inputs) {
      const systems = dataConsumerSystems.get(dataId) ?? new Set<string>();
      for (const sysId of n.system_ids) systems.add(sysId);
      dataConsumerSystems.set(dataId, systems);
      dataConsumerNodes.set(dataId, [...(dataConsumerNodes.get(dataId) ?? []), n]);
    }
  }
  for (const [dataId, systems] of dataConsumerSystems) {
    if (systems.size < 2) continue;
    const dataName = model.data.find((d) => d.id === dataId)?.name ?? dataId;
    const nodes = dataConsumerNodes.get(dataId) ?? [];
    findings.push({
      id: `ap_double_${dataId}`,
      rule: "double_entry",
      label: RULE_LABEL.double_entry,
      elementIds: nodes.map((n) => n.id),
      explanation: `Объект данных «${dataName}» вводится независимо в ${systems.size} разных информационных системах — вероятна ручная синхронизация и риск расхождений.`,
      quotes: nodes.flatMap((n) => n.source),
    });
  }

  // --- Ручная передача между системами: выход(ИС) -> ручная задача (нет системы) -> вход(ИС) ---
  for (const n of model.nodes) {
    if (n.system_ids.length > 0) continue; // ищем именно РУЧНОЙ узел в середине цепочки
    const preds = model.flows.filter((f) => f.to === n.id).map((f) => nodeById.get(f.from)).filter((x): x is ProcessNode => !!x);
    const succs = (outAdj.get(n.id) ?? []).map((f) => nodeById.get(f.to)).filter((x): x is ProcessNode => !!x);
    const predWithSystem = preds.find((p) => p.system_ids.length > 0);
    const succWithSystem = succs.find((s) => s.system_ids.length > 0);
    if (predWithSystem && succWithSystem) {
      findings.push({
        id: `ap_handoff_${n.id}`,
        rule: "manual_handoff",
        label: RULE_LABEL.manual_handoff,
        elementIds: [predWithSystem.id, n.id, succWithSystem.id],
        explanation: `Шаг «${n.name}» вручную переносит результат между системами (после «${predWithSystem.name}», перед «${succWithSystem.name}») — кандидат на автоматизацию/интеграцию.`,
        quotes: n.source,
      });
    }
  }

  // --- Избыточное согласование: цепочка ≥3 подряд идущих шагов-согласований без изменения объекта ---
  const approvalLike = (n: ProcessNode) => {
    const lower = n.name.toLowerCase();
    return APPROVE_STEMS.some((s) => lower.includes(s)) || CONSULT_STEMS.some((s) => lower.includes(s));
  };
  const visitedChainStart = new Set<string>();
  for (const n of model.nodes) {
    if (!approvalLike(n) || visitedChainStart.has(n.id)) continue;
    const chain: ProcessNode[] = [n];
    let cur = n;
    while (true) {
      const succs = (outAdj.get(cur.id) ?? []).map((f) => nodeById.get(f.to)).filter((x): x is ProcessNode => !!x);
      const next = succs.find((s) => approvalLike(s));
      if (!next || chain.includes(next)) break;
      chain.push(next);
      visitedChainStart.add(next.id);
      cur = next;
    }
    if (chain.length >= 3) {
      findings.push({
        id: `ap_approval_${n.id}`,
        rule: "excessive_approval",
        label: RULE_LABEL.excessive_approval,
        elementIds: chain.map((c) => c.id),
        explanation: `Подряд ${chain.length} согласований (${chain.map((c) => c.name).join(" → ")}) без явного изменения объекта между ними — возможно, часть можно объединить или делегировать порогом суммы.`,
        quotes: chain.flatMap((c) => c.source),
      });
    }
  }

  // --- Шаг без выхода ---
  for (const n of model.nodes) {
    if (n.type !== "task" && n.type !== "subprocess") continue;
    const hasOutgoingFlow = (outAdj.get(n.id) ?? []).length > 0;
    if (n.outputs.length === 0 && !hasOutgoingFlow) {
      findings.push({
        id: `ap_nooutput_${n.id}`,
        rule: "step_without_output",
        label: RULE_LABEL.step_without_output,
        elementIds: [n.id],
        explanation: `Шаг «${n.name}» не производит ни объекта данных, ни дальнейшего потока — результат его выполнения нигде не используется.`,
        quotes: n.source,
      });
    }
  }

  // --- Петля без выхода по сроку ---
  const { cycles } = findCyclesWithMarkers(model);
  for (const cycle of cycles) {
    const hasTimerOrCount = cycle.some((id) => {
      const n = nodeById.get(id);
      if (!n) return false;
      if (n.type === "event" && n.subtype === "timer") return true;
      const flowsOut = outAdj.get(id) ?? [];
      return flowsOut.some((f) => f.condition && TIMER_OR_COUNT_MARKERS.some((mk) => f.condition!.toLowerCase().includes(mk)));
    });
    if (!hasTimerOrCount) {
      const names = cycle.map((id) => nodeById.get(id)?.name ?? id);
      findings.push({
        id: `ap_loop_${cycle[0]}`,
        rule: "loop_without_exit",
        label: RULE_LABEL.loop_without_exit,
        elementIds: cycle,
        explanation: `Цикл возврата (${names.join(" → ")}) не имеет ни таймера, ни счётчика попыток — риск бесконечного повторения.`,
        quotes: cycle.flatMap((id) => nodeById.get(id)?.source ?? []),
      });
    }
  }

  // --- Пинг-понг: более 2 передач между одной и той же парой ролей подряд ---
  const orderedNodes = topoOrderApprox(model);
  let lastPair: [string, string] | null = null;
  let streak = 0;
  let streakNodes: string[] = [];
  for (let i = 0; i < orderedNodes.length - 1; i++) {
    const a = nodeById.get(orderedNodes[i]);
    const b = nodeById.get(orderedNodes[i + 1]);
    if (!a?.role_id || !b?.role_id || a.role_id === b.role_id) {
      if (streak > 2) recordPingPong(streakNodes);
      lastPair = null;
      streak = 0;
      streakNodes = [];
      continue;
    }
    const pair: [string, string] = [a.role_id, b.role_id].sort() as [string, string];
    if (lastPair && pair[0] === lastPair[0] && pair[1] === lastPair[1]) {
      streak += 1;
      streakNodes.push(b.id);
    } else {
      if (streak > 2) recordPingPong(streakNodes);
      streak = 1;
      streakNodes = [a.id, b.id];
    }
    lastPair = pair;
  }
  if (streak > 2) recordPingPong(streakNodes);

  function recordPingPong(nodeIds: string[]) {
    const names = nodeIds.map((id) => nodeById.get(id)?.name ?? id);
    findings.push({
      id: `ap_pingpong_${nodeIds[0]}`,
      rule: "ping_pong",
      label: RULE_LABEL.ping_pong,
      elementIds: nodeIds,
      explanation: `Более двух передач подряд между одними и теми же ролями (${names.join(" → ")}) — признак несогласованного взаимодействия.`,
      quotes: nodeIds.flatMap((id) => nodeById.get(id)?.source ?? []),
    });
  }

  return findings;
}

function findCyclesWithMarkers(model: ProcessLogicModel): { cycles: string[][] } {
  const outAdj = new Map<string, string[]>();
  for (const f of model.flows) outAdj.set(f.from, [...(outAdj.get(f.from) ?? []), f.to]);
  const cycles: string[][] = [];
  const visited = new Set<string>();
  const stack: string[] = [];
  const stackSet = new Set<string>();
  function dfs(id: string) {
    visited.add(id);
    stack.push(id);
    stackSet.add(id);
    for (const next of outAdj.get(id) ?? []) {
      if (stackSet.has(next)) {
        const idx = stack.indexOf(next);
        cycles.push(stack.slice(idx));
      } else if (!visited.has(next)) {
        dfs(next);
      }
    }
    stack.pop();
    stackSet.delete(id);
  }
  for (const n of model.nodes) if (!visited.has(n.id)) dfs(n.id);
  return { cycles };
}

/** Приблизительный топологический/последовательный порядок узлов для поиска пинг-понга — BFS от стартовых узлов. */
function topoOrderApprox(model: ProcessLogicModel): string[] {
  const outAdj = new Map<string, string[]>();
  for (const f of model.flows) outAdj.set(f.from, [...(outAdj.get(f.from) ?? []), f.to]);
  const starts = model.nodes.filter((n) => n.type === "event" && n.subtype === "start").map((n) => n.id);
  const roots = starts.length > 0 ? starts : model.nodes.map((n) => n.id).slice(0, 1);
  const order: string[] = [];
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    order.push(id);
    for (const next of outAdj.get(id) ?? []) queue.push(next);
  }
  return order;
}
