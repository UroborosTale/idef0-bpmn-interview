import type { ProcessLogicModel } from "../types/model.js";

export interface ChecklistRuleResult {
  code: string;
  label: string;
  passed: boolean;
  detail: string;
}
export interface ChecklistResult {
  compliancePercent: number;
  results: ChecklistRuleResult[];
}

type RuleCheck = (model: ProcessLogicModel) => { passed: boolean; detail: string };

const RULE_CHECKS: Record<string, RuleCheck> = {
  owner_assigned: (m) => ({ passed: !!m.process.owner, detail: m.process.owner ? `Владелец: ${m.process.owner}` : "Владелец не указан" }),
  inputs_outputs_defined: (m) => {
    const hasInputs = m.nodes.some((n) => n.inputs.length > 0);
    const hasOutputs = m.nodes.some((n) => n.outputs.length > 0);
    return { passed: hasInputs && hasOutputs, detail: hasInputs && hasOutputs ? "Входы и выходы определены" : "Не у всех шагов определены входы/выходы" };
  },
  kpi_with_targets: (m) => {
    const withTargets = m.process.kpi.filter((k) => k.target);
    return { passed: withTargets.length > 0, detail: withTargets.length > 0 ? `KPI с целями: ${withTargets.length}` : "Нет показателей с целевыми значениями" };
  },
  risks_defined: (m) => ({ passed: m.process.risks.length > 0, detail: m.process.risks.length > 0 ? `Рисков: ${m.process.risks.length}` : "Риски не определены" }),
  records_defined: (m) => {
    const records = m.data.filter((d) => d.kind === "document");
    return { passed: records.length > 0, detail: records.length > 0 ? `Записей (документов): ${records.length}` : "Записи процесса не определены" };
  },
  control_points_exist: (m) => ({ passed: m.controls.length > 0, detail: m.controls.length > 0 ? `Регламентирующих факторов: ${m.controls.length}` : "Точки контроля не определены" }),
  review_date_set: (m) => ({ passed: !!m.process.review_date, detail: m.process.review_date ? `Дата пересмотра: ${m.process.review_date}` : "Дата планового пересмотра не назначена" }),
};

/** ФТ-М6.2: чек-лист процессного подхода — % соответствия и список несоответствий. Правила настраиваются (какие включены), логика проверки — фиксированный набор. */
export function runChecklist(model: ProcessLogicModel, enabledRules: { code: string; label: string }[]): ChecklistResult {
  const results: ChecklistRuleResult[] = enabledRules.map((r) => {
    const check = RULE_CHECKS[r.code];
    if (!check) return { code: r.code, label: r.label, passed: false, detail: "Неизвестное правило" };
    const { passed, detail } = check(model);
    return { code: r.code, label: r.label, passed, detail };
  });
  const compliancePercent = results.length > 0 ? Math.round((results.filter((r) => r.passed).length / results.length) * 100) : 100;
  return { compliancePercent, results };
}
