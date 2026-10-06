import type { ProcessLogicModel, Gap } from "../types/model.js";

/**
 * ФТ-М4.5: адаптивная глубина интервью — критичность участка процесса
 * определяется по признакам (деньги, сроки, внешние стороны, связанные
 * требования СМК) либо задаётся аналитиком вручную через тег
 * "critical_override" на узле (переиспользует существующее поле tags —
 * отдельное поле в PLM не требуется).
 */
export interface CriticalityScore {
  nodeId: string;
  name: string;
  score: number;
  reasons: string[];
}

const MONEY_WORDS = ["бюджет", "сумма", "оплат", "платеж", "платёж", "счет", "счёт", "стоимост", "цена", "инвойс", "касса", "деньг"];
const DEADLINE_WORDS = ["срок", "дедлайн", "крайний", "просроч"];

/** ФТ-М4.5.1/4.5.3: критичность участка процесса — эвристика по деньгам/срокам/внешним сторонам/требованиям + ручной override. */
export function computeCriticality(model: ProcessLogicModel): CriticalityScore[] {
  const linkedElementIds = new Set(model.requirements_links.map((l) => l.element_id));
  const dataNameById = new Map(model.data.map((d) => [d.id, d.name.toLowerCase()] as const));
  const tasks = model.nodes.filter((n) => n.type === "task" || n.type === "subprocess");

  return tasks
    .map((n) => {
      let score = 0;
      const reasons: string[] = [];

      const role = model.roles.find((r) => r.id === n.role_id);
      if (role?.kind === "external") {
        score += 1;
        reasons.push("исполнитель — внешняя сторона");
      }

      const nameLower = n.name.toLowerCase();
      const relatedData = [...n.inputs, ...n.outputs].map((id) => dataNameById.get(id) ?? "");
      if (MONEY_WORDS.some((w) => nameLower.includes(w) || relatedData.some((d) => d.includes(w)))) {
        score += 1;
        reasons.push("связано с деньгами/оплатой");
      }

      if (n.duration && DEADLINE_WORDS.some((w) => (n.duration ?? "").toLowerCase().includes(w))) {
        score += 0.5;
        reasons.push("указан жёсткий срок");
      }

      if (n.requirement_ids.length > 0 || linkedElementIds.has(n.id)) {
        score += 1;
        reasons.push("связано с требованием СМК (М6)");
      }

      if (n.tags.includes("critical_override")) {
        score += 2;
        reasons.push("отмечено аналитиком вручную как критичное");
      }

      return { nodeId: n.id, name: n.name, score, reasons };
    })
    .sort((a, b) => b.score - a.score);
}

/** ФТ-М4.5.2: для критичных, но слабо детализированных участков — вопросы на доуточнение (опционально, не встроено в детектор пробелов по умолчанию). */
export function generateAdaptiveDepthGaps(model: ProcessLogicModel): Gap[] {
  const scores = computeCriticality(model);
  const nodeById = new Map(model.nodes.map((n) => [n.id, n] as const));
  const gaps: Gap[] = [];

  for (const c of scores) {
    if (c.score < 1) continue;
    const node = nodeById.get(c.nodeId);
    if (!node) continue;
    const underDetailed = node.status === "hypothesis" || !node.role_id || (node.inputs.length === 0 && node.outputs.length === 0);
    if (!underDetailed) continue;
    gaps.push({
      id: `gap_critical_${node.id}`,
      rule: "adaptive_depth_critical",
      priority: "critical",
      element_id: node.id,
      question: `Шаг «${node.name}» отмечен как критичный (${c.reasons.join(", ")}) — опишите подробнее: исполнителя, входы/выходы, возможные исключения.`,
      status: "open",
      topic: `critical_${node.id}`,
      asked_count: 0,
    });
  }
  return gaps;
}
