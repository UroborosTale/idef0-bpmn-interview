import type { ProcessLogicModel, ProcessNode, Gap } from "../types/model.js";
import { parseDurationToMinutes } from "./timeUtils.js";
import { APPROVE_STEMS, CONSULT_STEMS } from "./raci.js";

export interface PathInfo {
  nodeIds: string[];
  nodeNames: string[];
  totalMinutes: number;
}

export interface NodeHeat {
  nodeId: string;
  name: string;
  heat: number; // 0..1
  minutes: number;
  inLoop: boolean;
}

export interface BottleneckReport {
  hasTimingData: boolean;
  mainPath: PathInfo | null;
  worstPath: PathInfo | null;
  waitingShare: number | null; // доля времени ожидания в общем времени (0..1)
  handoffCount: number; // число передач между ролями
  approvalCount: number; // число согласований
  returnLoopCount: number; // число циклов возврата
  nodeHeat: NodeHeat[];
}

function nodeMinutes(n: ProcessNode): { processing: number; waiting: number } {
  const processing = parseDurationToMinutes(n.time_processing) ?? parseDurationToMinutes(n.duration) ?? 0;
  const waiting = parseDurationToMinutes(n.time_waiting) ?? 0;
  return { processing, waiting };
}

/** Все простые пути старт→конец (без повторных посещений узла) с ограничением на число путей/глубину — граф может быть большим/циклическим. */
function findPaths(model: ProcessLogicModel, maxPaths = 300, maxDepth = 60): string[][] {
  const outAdj = new Map<string, string[]>();
  for (const f of model.flows) outAdj.set(f.from, [...(outAdj.get(f.from) ?? []), f.to]);
  const starts = model.nodes.filter((n) => n.type === "event" && n.subtype === "start").map((n) => n.id);
  const ends = new Set(model.nodes.filter((n) => n.type === "event" && n.subtype === "end").map((n) => n.id));
  const roots = starts.length > 0 ? starts : model.nodes.filter((n) => !model.flows.some((f) => f.to === n.id)).map((n) => n.id);
  const terminal = ends.size > 0 ? ends : new Set(model.nodes.filter((n) => (outAdj.get(n.id) ?? []).length === 0).map((n) => n.id));

  const paths: string[][] = [];
  function dfs(nodeId: string, path: string[], visited: Set<string>) {
    if (paths.length >= maxPaths || path.length > maxDepth) return;
    if (terminal.has(nodeId)) {
      paths.push([...path, nodeId]);
      return;
    }
    const nexts = outAdj.get(nodeId) ?? [];
    if (nexts.length === 0) {
      paths.push([...path, nodeId]); // тупиковый путь — тоже учитываем как завершённый для анализа
      return;
    }
    for (const next of nexts) {
      if (visited.has(next)) continue; // не проходим циклы повторно в рамках одного простого пути
      visited.add(next);
      dfs(next, [...path, nodeId], visited);
      visited.delete(next);
      if (paths.length >= maxPaths) return;
    }
  }
  for (const r of roots) dfs(r, [], new Set([r]));
  return paths;
}

function pathInfo(model: ProcessLogicModel, nodeIds: string[]): PathInfo {
  const nodeById = new Map(model.nodes.map((n) => [n.id, n] as const));
  let total = 0;
  const names: string[] = [];
  for (const id of nodeIds) {
    const n = nodeById.get(id);
    if (!n) continue;
    names.push(n.name);
    const { processing, waiting } = nodeMinutes(n);
    total += processing + waiting;
  }
  return { nodeIds, nodeNames: names, totalMinutes: total };
}

/** Циклы возврата: рёбра, ведущие к узлу, уже присутствующему в текущем стеке DFS (back edges). */
function findReturnLoops(model: ProcessLogicModel): { loopNodeIds: Set<string>; count: number } {
  const outAdj = new Map<string, string[]>();
  for (const f of model.flows) outAdj.set(f.from, [...(outAdj.get(f.from) ?? []), f.to]);
  const loopNodeIds = new Set<string>();
  let count = 0;
  const visited = new Set<string>();
  const stack = new Set<string>();
  function dfs(id: string) {
    visited.add(id);
    stack.add(id);
    for (const next of outAdj.get(id) ?? []) {
      if (stack.has(next)) {
        count += 1;
        loopNodeIds.add(id);
        loopNodeIds.add(next);
        continue;
      }
      if (!visited.has(next)) dfs(next);
    }
    stack.delete(id);
  }
  for (const n of model.nodes) if (!visited.has(n.id)) dfs(n.id);
  return { loopNodeIds, count };
}

/** ФТ-М2.1: узкие места — время цикла по основному пути/наихудшей ветке, ожидание, передачи, согласования, циклы возврата, тепловая карта. */
export function analyzeBottlenecks(model: ProcessLogicModel): BottleneckReport {
  const hasTimingData = model.nodes.some((n) => n.time_processing || n.time_waiting || n.duration);

  const paths = findPaths(model);
  const infos = paths.map((p) => pathInfo(model, p));
  let mainPath: PathInfo | null = null;
  let worstPath: PathInfo | null = null;
  if (infos.length > 0) {
    mainPath = [...infos].sort((a, b) => a.nodeIds.length - b.nodeIds.length || a.totalMinutes - b.totalMinutes)[0];
    worstPath = [...infos].sort((a, b) => b.totalMinutes - a.totalMinutes)[0];
  }

  let totalProcessing = 0;
  let totalWaiting = 0;
  for (const n of model.nodes) {
    const { processing, waiting } = nodeMinutes(n);
    totalProcessing += processing;
    totalWaiting += waiting;
  }
  const waitingShare = hasTimingData && totalProcessing + totalWaiting > 0 ? totalWaiting / (totalProcessing + totalWaiting) : null;

  const roleById = new Map(model.roles.map((r) => [r.id, r.name] as const));
  const nodeById = new Map(model.nodes.map((n) => [n.id, n] as const));
  let handoffCount = 0;
  for (const f of model.flows) {
    const from = nodeById.get(f.from);
    const to = nodeById.get(f.to);
    if (from?.role_id && to?.role_id && from.role_id !== to.role_id) handoffCount += 1;
  }
  void roleById;

  const approvalCount = model.nodes.filter((n) => {
    const nameLower = n.name.toLowerCase();
    return APPROVE_STEMS.some((s) => nameLower.includes(s)) || CONSULT_STEMS.some((s) => nameLower.includes(s));
  }).length;

  const { loopNodeIds, count: returnLoopCount } = findReturnLoops(model);

  const maxMinutes = Math.max(1, ...model.nodes.map((n) => { const { processing, waiting } = nodeMinutes(n); return processing + waiting; }));
  const nodeHeat: NodeHeat[] = model.nodes
    .filter((n) => n.type === "task" || n.type === "subprocess")
    .map((n) => {
      const { processing, waiting } = nodeMinutes(n);
      const minutes = processing + waiting;
      const timeScore = minutes / maxMinutes;
      const loopScore = loopNodeIds.has(n.id) ? 1 : 0;
      const heat = Math.min(1, 0.7 * timeScore + 0.3 * loopScore);
      return { nodeId: n.id, name: n.name, heat, minutes, inLoop: loopNodeIds.has(n.id) };
    });

  return { hasTimingData, mainPath, worstPath, waitingShare, handoffCount, approvalCount, returnLoopCount, nodeHeat };
}

/** ФТ-М2.1.3: если временных данных нет, формирует вопросы для интервью (М4) по длительности ключевых шагов. */
export function generateTimingGaps(model: ProcessLogicModel): Gap[] {
  const tasks = model.nodes.filter((n) => n.type === "task" || n.type === "subprocess");
  return tasks
    .filter((n) => !n.time_processing && !n.duration)
    .map((n) => ({
      id: `gap_timing_${n.id}`,
      rule: "missing_timing_data",
      priority: "desirable" as const,
      element_id: n.id,
      question: `Сколько времени обычно занимает шаг «${n.name}»?`,
      status: "open" as const,
      topic: `timing_${n.id}`,
      asked_count: 0,
    }));
}

// --- ФТ-М2.2: оценка трудоёмкости и затрат ---

export interface RoleCost {
  roleId: string;
  roleName: string;
  minutesPerInstance: number;
  costPerInstance: number | null; // null если для роли не задана ставка
  hasRate: boolean;
}
export interface CostReport {
  roles: RoleCost[];
  totalMinutesPerInstance: number;
  totalCostPerInstance: number | null;
  frequencyPerMonth: number | null;
  totalCostPerMonth: number | null;
  missingRates: string[]; // названия ролей без заданной ставки
}

export function analyzeCost(model: ProcessLogicModel, rates: Map<string, number>, frequencyOverride?: number | null): CostReport {
  const roleById = new Map(model.roles.map((r) => [r.id, r.name] as const));
  const minutesByRole = new Map<string, number>();
  for (const n of model.nodes) {
    if (!n.role_id) continue;
    const { processing, waiting } = nodeMinutes(n);
    minutesByRole.set(n.role_id, (minutesByRole.get(n.role_id) ?? 0) + processing); // трудозатраты считаем по времени ОБРАБОТКИ (waiting не требует труда исполнителя)
    void waiting;
  }

  const missingRates: string[] = [];
  const roles: RoleCost[] = [...minutesByRole.entries()].map(([roleId, minutes]) => {
    const roleName = roleById.get(roleId) ?? roleId;
    const rate = rates.get(roleName.toLowerCase());
    if (rate === undefined) missingRates.push(roleName);
    return {
      roleId,
      roleName,
      minutesPerInstance: minutes,
      costPerInstance: rate !== undefined ? (minutes / 60) * rate : null,
      hasRate: rate !== undefined,
    };
  });

  const totalMinutesPerInstance = roles.reduce((sum, r) => sum + r.minutesPerInstance, 0);
  const totalCostPerInstance = roles.every((r) => r.hasRate) && roles.length > 0 ? roles.reduce((sum, r) => sum + (r.costPerInstance ?? 0), 0) : null;
  const frequencyPerMonth = frequencyOverride ?? model.process.frequency_per_month ?? null;
  const totalCostPerMonth = totalCostPerInstance !== null && frequencyPerMonth !== null ? totalCostPerInstance * frequencyPerMonth : null;

  return { roles, totalMinutesPerInstance, totalCostPerInstance, frequencyPerMonth, totalCostPerMonth, missingRates };
}

/** ФТ-М2.2.3: анализ чувствительности к частоте и длительности — стоимость за период при -20%/база/+20%. */
export interface SensitivityPoint {
  label: string;
  frequencyPerMonth: number | null;
  durationFactor: number;
  totalCostPerMonth: number | null;
}
export function analyzeSensitivity(model: ProcessLogicModel, rates: Map<string, number>, baseFrequency: number | null): SensitivityPoint[] {
  const factors = [
    { label: "-20% частота / -20% длительность", freqMul: 0.8, durMul: 0.8 },
    { label: "база", freqMul: 1, durMul: 1 },
    { label: "+20% частота / +20% длительность", freqMul: 1.2, durMul: 1.2 },
    { label: "+20% частота, база длительности", freqMul: 1.2, durMul: 1 },
    { label: "база частоты, +20% длительность", freqMul: 1, durMul: 1.2 },
  ];
  return factors.map((f) => {
    const scaledModel: ProcessLogicModel = {
      ...model,
      nodes: model.nodes.map((n) => ({ ...n, time_processing: scaleDuration(n.time_processing, f.durMul) })),
    };
    const freq = baseFrequency !== null ? baseFrequency * f.freqMul : null;
    const report = analyzeCost(scaledModel, rates, freq);
    return { label: f.label, frequencyPerMonth: freq, durationFactor: f.durMul, totalCostPerMonth: report.totalCostPerMonth };
  });
}

function scaleDuration(text: string | null | undefined, factor: number): string | null {
  const minutes = parseDurationToMinutes(text);
  if (minutes === null) return text ?? null;
  const scaled = minutes * factor;
  return `${Math.round(scaled)} минут`;
}
