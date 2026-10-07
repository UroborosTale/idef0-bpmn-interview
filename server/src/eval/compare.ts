import { functionCodes } from "../shared/codes.js";
import { validateModel } from "../shared/validate.js";
import type { ProcessLogicModel, ProcessNode } from "../types/model.js";

/**
 * Сравнение модели с эталоном (например, B002): насколько собранная агентом модель совпадает с утверждённой.
 * Названия сравниваются нестрого (по корням слов), поэтому «Согласовать заявку» и «Согласование заявки» — одно и то же.
 * Результат — набор мер (точность, полнота, F1) по функциям, шагам BPMN, последовательности шагов, должностям,
 * продуктам и системам, плюс число нарушений правил Соглашения у кандидата.
 */

export interface Metric {
  /** Сколько элементов в эталоне / у кандидата / совпало. */
  reference: number;
  candidate: number;
  matched: number;
  precision: number;
  recall: number;
  f1: number;
}

export interface OperationScore {
  code: string;
  name: string;
  /** Найденная функция кандидата (код) или null — операции нет в модели кандидата. */
  matchedWith: string | null;
  steps: Metric;
}

export interface EvalResult {
  /** Взвешенное среднее F1 по основным мерам, 0..1. */
  overall: number;
  functions: Metric;
  steps: Metric;
  /** Последовательность: пары «шаг → следующий шаг» между совпавшими шагами. */
  order: Metric;
  roles: Metric;
  products: Metric;
  systems: Metric;
  operations: OperationScore[];
  /** Совпавшие функции, у которых совпал и код по Соглашению. */
  codes: { matched: number; same: number };
  violations: { errors: number; warnings: number; byRule: Record<string, number> };
}

const stems = (name: string): Set<string> =>
  new Set(
    (name.toLowerCase().replace(/ё/g, "е").match(/[\p{L}\p{N}]+/gu) ?? [])
      .filter((w) => w.length > 2 || /\d/.test(w))
      .map((w) => w.slice(0, 5))
  );

/** Коэффициент Дайса по корням слов: 1 — названия совпадают, 0 — общего нет. */
export function similarity(a: string, b: string): number {
  const x = stems(a);
  const y = stems(b);
  if (x.size === 0 || y.size === 0) return 0;
  let common = 0;
  for (const s of x) if (y.has(s)) common++;
  return (2 * common) / (x.size + y.size);
}

const THRESHOLD = 0.6;

/** Жадное сопоставление один к одному по убыванию сходства: пары [индекс эталона, индекс кандидата]. */
export function matchNames(reference: string[], candidate: string[], threshold = THRESHOLD): [number, number][] {
  const pairs: [number, number, number][] = [];
  reference.forEach((r, i) => candidate.forEach((c, j) => {
    const s = similarity(r, c);
    if (s >= threshold) pairs.push([i, j, s]);
  }));
  pairs.sort((p, q) => q[2] - p[2]);
  const usedR = new Set<number>();
  const usedC = new Set<number>();
  const out: [number, number][] = [];
  for (const [i, j] of pairs) {
    if (usedR.has(i) || usedC.has(j)) continue;
    usedR.add(i);
    usedC.add(j);
    out.push([i, j]);
  }
  return out;
}

const metric = (reference: number, candidate: number, matched: number): Metric => {
  const precision = candidate === 0 ? (reference === 0 ? 1 : 0) : matched / candidate;
  const recall = reference === 0 ? 1 : matched / reference;
  return { reference, candidate, matched, precision, recall, f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall) };
};

const isTask = (n: ProcessNode) => n.type === "task" || n.type === "subprocess";
const isFn = (n: ProcessNode) => isTask(n) && !n.bpmn_scope;

/** Пары «задача → следующая задача» диаграммы операции: события и шлюзы между ними не в счёт. */
function taskEdges(m: ProcessLogicModel, scope: string): [string, string][] {
  const nodes = new Map(m.nodes.filter((n) => n.bpmn_scope === scope).map((n) => [n.id, n] as const));
  const out: [string, string][] = [];
  for (const t of nodes.values()) {
    if (!isTask(t)) continue;
    const seen = new Set<string>();
    const walk = (from: string) => {
      for (const f of m.flows.filter((x) => x.from === from)) {
        const n = nodes.get(f.to);
        if (!n || seen.has(n.id)) continue;
        seen.add(n.id);
        if (isTask(n)) out.push([t.id, n.id]);
        else walk(n.id);
      }
    };
    walk(t.id);
  }
  return out;
}

const WEIGHTS = { functions: 0.2, steps: 0.3, order: 0.15, roles: 0.1, products: 0.15, systems: 0.1 };

export function compareModels(reference: ProcessLogicModel, candidate: ProcessLogicModel): EvalResult {
  const refFns = reference.nodes.filter(isFn);
  const candFns = candidate.nodes.filter(isFn);
  const fnPairs = matchNames(refFns.map((n) => n.name), candFns.map((n) => n.name));
  const refCodes = functionCodes(reference);
  const candCodes = functionCodes(candidate);
  const fnMap = new Map(fnPairs.map(([i, j]) => [refFns[i].id, candFns[j].id] as const));

  let sameCodes = 0;
  for (const [r, c] of fnMap) if (refCodes.get(r) === candCodes.get(c)) sameCodes++;

  // шаги и порядок: по операциям эталона, у которых нашлась функция кандидата
  const refOps = refFns.filter((f) => reference.nodes.some((n) => n.bpmn_scope === f.id));
  let stepsRef = 0;
  let stepsCand = 0;
  let stepsMatched = 0;
  let edgesRef = 0;
  let edgesCand = 0;
  let edgesMatched = 0;
  const operations: OperationScore[] = [];
  const countedCandOps = new Set<string>();
  for (const op of refOps) {
    const rs = reference.nodes.filter((n) => n.bpmn_scope === op.id && isTask(n));
    const candOpId = fnMap.get(op.id) ?? null;
    const cs = candOpId ? candidate.nodes.filter((n) => n.bpmn_scope === candOpId && isTask(n)) : [];
    const pairs = matchNames(rs.map((n) => n.name), cs.map((n) => n.name));
    const map = new Map(pairs.map(([i, j]) => [rs[i].id, cs[j].id] as const));
    stepsRef += rs.length;
    stepsCand += cs.length;
    stepsMatched += pairs.length;
    if (candOpId) countedCandOps.add(candOpId);
    operations.push({ code: refCodes.get(op.id) ?? op.id, name: op.name, matchedWith: candOpId ? candCodes.get(candOpId) ?? candOpId : null, steps: metric(rs.length, cs.length, pairs.length) });

    const refEdges = taskEdges(reference, op.id);
    const candEdges = candOpId ? taskEdges(candidate, candOpId) : [];
    const candSet = new Set(candEdges.map(([a, b]) => `${a}>${b}`));
    edgesRef += refEdges.length;
    edgesCand += candEdges.length;
    edgesMatched += refEdges.filter(([a, b]) => map.has(a) && map.has(b) && candSet.has(`${map.get(a)}>${map.get(b)}`)).length;
  }
  // шаги операций кандидата, которых в эталоне нет, — лишние: снижают точность
  for (const op of candFns) {
    if (countedCandOps.has(op.id)) continue;
    const extra = candidate.nodes.filter((n) => n.bpmn_scope === op.id && isTask(n)).length;
    stepsCand += extra;
    edgesCand += taskEdges(candidate, op.id).length;
  }

  const names = <T extends { name: string }>(xs: T[]) => xs.map((x) => x.name);
  const byNames = (r: { name: string }[], c: { name: string }[]) => metric(r.length, c.length, matchNames(names(r), names(c)).length);
  const functions = metric(refFns.length, candFns.length, fnPairs.length);
  const steps = metric(stepsRef, stepsCand, stepsMatched);
  const order = metric(edgesRef, edgesCand, edgesMatched);
  const roles = byNames(reference.roles, candidate.roles);
  const products = byNames(reference.data, candidate.data);
  const systems = byNames(reference.systems, candidate.systems);

  const issues = validateModel(candidate);
  const byRule: Record<string, number> = {};
  for (const i of issues) byRule[i.rule] = (byRule[i.rule] ?? 0) + 1;

  const overall = Object.entries(WEIGHTS).reduce((sum, [k, w]) => sum + w * ({ functions, steps, order, roles, products, systems } as Record<string, Metric>)[k].f1, 0);
  return {
    overall,
    functions,
    steps,
    order,
    roles,
    products,
    systems,
    operations,
    codes: { matched: fnPairs.length, same: sameCodes },
    violations: { errors: issues.filter((i) => i.severity === "error").length, warnings: issues.filter((i) => i.severity === "warning").length, byRule },
  };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const line = (label: string, m: Metric) => `${label.padEnd(30)} F1 ${pct(m.f1).padStart(4)}  (полнота ${pct(m.recall)}, точность ${pct(m.precision)}; эталон ${m.reference}, у кандидата ${m.candidate}, совпало ${m.matched})`;

/** Отчёт текстом: общий балл, меры, операции эталона и нарушения правил Соглашения. */
export function formatEval(r: EvalResult): string {
  const lines = [
    `Совпадение с эталоном: ${pct(r.overall)}`,
    "",
    line("Функции (подпроцессы, операции)", r.functions),
    `${"".padEnd(30)} коды по Соглашению совпали у ${r.codes.same} из ${r.codes.matched} найденных функций`,
    line("Шаги BPMN операций", r.steps),
    line("Последовательность шагов", r.order),
    line("Должности", r.roles),
    line("Продукты (документы, данные)", r.products),
    line("Информационные системы", r.systems),
    "",
    "Операции эталона:",
    ...r.operations.map((o) => `  ${o.code} ${o.name.slice(0, 60)} — ${o.matchedWith ? `найдена (${o.matchedWith}), шаги F1 ${pct(o.steps.f1)}` : "НЕ НАЙДЕНА"}`),
    "",
    `Нарушения правил у кандидата: ошибок ${r.violations.errors}, предупреждений ${r.violations.warnings}`,
    ...Object.entries(r.violations.byRule).sort((a, b) => b[1] - a[1]).map(([rule, n]) => `  ${rule}: ${n}`),
  ];
  return lines.join("\n");
}
