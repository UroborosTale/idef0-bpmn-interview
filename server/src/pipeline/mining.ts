import type { ProcessLogicModel } from "../types/model.js";
import { formatMinutes } from "./timeUtils.js";

/**
 * ФТ-М4.3: сверка модели с данными (process mining).
 *
 * Область реализации: импорт CSV-журнала событий (case_id, activity,
 * timestamp, resource), построение графа непосредственного следования
 * (directly-follows graph) и на его основе — эвристическое обнаружение
 * связей (в духе heuristic miner: частотные переходы), проверка
 * соответствия (fitness/precision) и подстановка фактических длительностей.
 *
 * Импорт XES (упомянут в ТЗ как "CSV или XES") сознательно не реализован:
 * это отдельный XML-диалект с расширениями (частоты, атрибуты жизненного
 * цикла, лог-расширения), не являющийся необходимым для демонстрации
 * конвейера — CSV полностью покрывает функциональное требование 4.3.1.
 * Полный inductive miner (рекурсивное построение дерева процесса через
 * cut-разбиения log/exclusive/parallel/loop) также не реализован — это
 * самостоятельный исследовательский алгоритм; вместо него используется
 * частотный directly-follows граф, который даёт содержательные, проверяемые
 * метрики соответствия без внешних ML-зависимостей.
 */

export interface MiningEvent {
  caseId: string;
  activity: string;
  timestamp: string; // ISO 8601 после парсинга
  resource?: string;
}

const HEADER_ALIASES: Record<string, string[]> = {
  case_id: ["case_id", "caseid", "case", "case id"],
  activity: ["activity", "activity_name", "action", "step"],
  timestamp: ["timestamp", "time", "ts", "date", "datetime"],
  resource: ["resource", "performer", "executor", "role"],
};

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === "," || ch === ";") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** ФТ-М4.3.1: импорт журнала событий из CSV (заголовок обязателен, порядок колонок произвольный). */
export function parseEventLogCsv(csv: string): MiningEvent[] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) throw new Error("CSV пуст или не содержит строк данных");
  const header = parseCsvLine(lines[0]).map((h) => h.toLowerCase().trim());

  function findCol(key: string): number {
    for (const alias of HEADER_ALIASES[key]) {
      const idx = header.indexOf(alias);
      if (idx >= 0) return idx;
    }
    return -1;
  }

  const caseIdx = findCol("case_id");
  const actIdx = findCol("activity");
  const tsIdx = findCol("timestamp");
  const resIdx = findCol("resource");
  if (caseIdx < 0 || actIdx < 0 || tsIdx < 0) {
    throw new Error("в заголовке CSV должны быть колонки case_id, activity, timestamp (resource — опционально)");
  }

  const events: MiningEvent[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]);
    const rawTs = cells[tsIdx];
    const ts = new Date(rawTs);
    if (!cells[caseIdx] || !cells[actIdx] || Number.isNaN(ts.getTime())) continue; // пропускаем некорректные строки
    events.push({ caseId: cells[caseIdx], activity: cells[actIdx], timestamp: ts.toISOString(), resource: resIdx >= 0 ? cells[resIdx] : undefined });
  }
  if (events.length === 0) throw new Error("не удалось разобрать ни одной строки журнала (проверьте формат timestamp)");
  return events;
}

function groupByCase(events: MiningEvent[]): Map<string, MiningEvent[]> {
  const byCase = new Map<string, MiningEvent[]>();
  for (const e of events) byCase.set(e.caseId, [...(byCase.get(e.caseId) ?? []), e]);
  for (const list of byCase.values()) list.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return byCase;
}

export interface DfgEdge {
  from: string;
  to: string;
  count: number;
}

/** ФТ-М4.3.3: граф непосредственного следования — основа эвристического обнаружения модели из журнала. */
export function buildDirectlyFollowsGraph(events: MiningEvent[]): { activities: string[]; edges: DfgEdge[]; caseCount: number } {
  const byCase = groupByCase(events);
  const edgeCounts = new Map<string, number>();
  const activityCounts = new Map<string, number>();

  for (const list of byCase.values()) {
    for (let i = 0; i < list.length; i++) {
      activityCounts.set(list[i].activity, (activityCounts.get(list[i].activity) ?? 0) + 1);
      if (i + 1 < list.length) {
        const key = `${list[i].activity}\u0000${list[i + 1].activity}`;
        edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
      }
    }
  }

  const activities = [...activityCounts.entries()].sort((a, b) => b[1] - a[1]).map(([a]) => a);
  const edges: DfgEdge[] = [...edgeCounts.entries()].map(([k, count]) => {
    const [from, to] = k.split("\u0000");
    return { from, to, count };
  });
  return { activities, edges: edges.sort((a, b) => b.count - a.count), caseCount: byCase.size };
}

const STOPWORDS = new Set(["и", "в", "на", "для", "по", "от", "с", "из", "к", "о", "об", "а", "но"]);
function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w))
  );
}
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

export interface ActivityMappingSuggestion {
  activity: string;
  nodeId: string | null;
  nodeName: string | null;
  score: number;
}

/** ФТ-М4.3.2: автоматическое сопоставление активностей журнала с действиями PLM (требует подтверждения аналитика). */
export function suggestActivityMappings(activities: string[], model: ProcessLogicModel): ActivityMappingSuggestion[] {
  const tasks = model.nodes.filter((n) => n.type === "task" || n.type === "subprocess");
  const taskTokens = tasks.map((n) => ({ node: n, tokens: tokenize(n.name) }));
  return activities.map((activity) => {
    const activityTokens = tokenize(activity);
    let best: { node: (typeof tasks)[number]; score: number } | null = null;
    for (const t of taskTokens) {
      const score = jaccard(activityTokens, t.tokens);
      if (!best || score > best.score) best = { node: t.node, score };
    }
    if (best && best.score >= 0.3) return { activity, nodeId: best.node.id, nodeName: best.node.name, score: best.score };
    return { activity, nodeId: null, nodeName: null, score: best?.score ?? 0 };
  });
}

export interface ConformanceDeviation {
  fromLabel: string;
  toLabel: string;
  count?: number;
}
export interface ActivityStat {
  activity: string;
  count: number;
  avgMinutes: number | null;
  mappedNodeId: string | null;
}
export interface ConformanceReport {
  fitness: number | null;
  precision: number | null;
  deviationsInLogNotModel: ConformanceDeviation[];
  deviationsInModelNotLog: ConformanceDeviation[];
  activityStats: ActivityStat[];
}

/** ФТ-М4.3.4: fitness (доля переходов журнала, объяснимых моделью) и precision (доля переходов модели, реально наблюдаемых). */
export function computeConformance(events: MiningEvent[], model: ProcessLogicModel, mapping: Map<string, string>): ConformanceReport {
  const nodeById = new Map(model.nodes.map((n) => [n.id, n] as const));
  const byCase = groupByCase(events);

  const logEdgeCounts = new Map<string, number>();
  let totalTransitions = 0;
  for (const list of byCase.values()) {
    for (let i = 0; i < list.length - 1; i++) {
      const fromNode = mapping.get(list[i].activity);
      const toNode = mapping.get(list[i + 1].activity);
      if (!fromNode || !toNode) continue; // неподтверждённые/несопоставленные активности не участвуют в проверке соответствия
      totalTransitions++;
      const key = `${fromNode}|${toNode}`;
      logEdgeCounts.set(key, (logEdgeCounts.get(key) ?? 0) + 1);
    }
  }

  const modelEdgeSet = new Set(model.flows.map((f) => `${f.from}|${f.to}`));

  let fitCovered = 0;
  const deviationsInLogNotModel: ConformanceDeviation[] = [];
  for (const [key, count] of logEdgeCounts) {
    if (modelEdgeSet.has(key)) {
      fitCovered += count;
    } else {
      const [from, to] = key.split("|");
      deviationsInLogNotModel.push({ fromLabel: nodeById.get(from)?.name ?? from, toLabel: nodeById.get(to)?.name ?? to, count });
    }
  }
  deviationsInLogNotModel.sort((a, b) => (b.count ?? 0) - (a.count ?? 0));
  const fitness = totalTransitions > 0 ? fitCovered / totalTransitions : null;

  let precCovered = 0;
  const deviationsInModelNotLog: ConformanceDeviation[] = [];
  for (const key of modelEdgeSet) {
    if (logEdgeCounts.has(key)) {
      precCovered++;
    } else {
      const [from, to] = key.split("|");
      deviationsInModelNotLog.push({ fromLabel: nodeById.get(from)?.name ?? from, toLabel: nodeById.get(to)?.name ?? to });
    }
  }
  const precision = modelEdgeSet.size > 0 ? precCovered / modelEdgeSet.size : null;

  // ФТ-М4.3.5 (данные для): средняя длительность активности — интервал до следующего события в той же трассе.
  const activityDeltas = new Map<string, number[]>();
  const activityCounts = new Map<string, number>();
  for (const list of byCase.values()) {
    for (let i = 0; i < list.length; i++) {
      activityCounts.set(list[i].activity, (activityCounts.get(list[i].activity) ?? 0) + 1);
      if (i + 1 < list.length) {
        const deltaMin = (new Date(list[i + 1].timestamp).getTime() - new Date(list[i].timestamp).getTime()) / 60000;
        if (deltaMin >= 0) activityDeltas.set(list[i].activity, [...(activityDeltas.get(list[i].activity) ?? []), deltaMin]);
      }
    }
  }
  const activityStats: ActivityStat[] = [...activityCounts.entries()].map(([activity, count]) => {
    const deltas = activityDeltas.get(activity) ?? [];
    const avgMinutes = deltas.length > 0 ? deltas.reduce((s, v) => s + v, 0) / deltas.length : null;
    return { activity, count, avgMinutes, mappedNodeId: mapping.get(activity) ?? null };
  });

  return { fitness, precision, deviationsInLogNotModel, deviationsInModelNotLog, activityStats };
}

/** ФТ-М4.3.5: фактические длительности из журнала подставляются в PLM, узел помечается тегом источника. */
export function applyDurationsFromLog(model: ProcessLogicModel, activityStats: ActivityStat[]): ProcessLogicModel {
  const out: ProcessLogicModel = JSON.parse(JSON.stringify(model));
  const nodeById = new Map(out.nodes.map((n) => [n.id, n] as const));
  for (const stat of activityStats) {
    if (!stat.mappedNodeId || stat.avgMinutes === null) continue;
    const node = nodeById.get(stat.mappedNodeId);
    if (!node) continue;
    node.time_processing = formatMinutes(stat.avgMinutes);
    if (!node.tags.includes("from_event_log")) node.tags = [...node.tags, "from_event_log"];
  }
  return out;
}
