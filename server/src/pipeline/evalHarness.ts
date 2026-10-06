import { fragmentText } from "./fragment.js";
import type { LLMProvider, LLMFragmentInput } from "../llm/types.js";

/**
 * ФТ-М9.1.4/9.3.3: эталонный набор для регрессионной оценки перед выкаткой
 * нового варианта промпта/модели (9.1.4) и для сравнения деградации качества
 * локальной модели относительно основной (9.3.3). Ожидаемые роли/действия
 * подобраны так, чтобы детерминированно извлекаться офлайн-провайдером
 * (см. llm/mockProvider.ts: словари ролей и канонические формы глаголов) —
 * это даёт стабильную базовую линию (baseline) даже без сети.
 */
export interface ReferenceCase {
  id: string;
  processName: string;
  text: string;
  expectedRoles: string[];
  expectedNodeNames: string[];
}

export const REFERENCE_SET: ReferenceCase[] = [
  {
    id: "ref-1-purchase",
    processName: "Эталон: закупка",
    text: "Владелец: Менеджер оформляет договор с клиентом. Бухгалтер проверяет оплату по счету.",
    expectedRoles: ["Менеджер", "Бухгалтер"],
    expectedNodeNames: ["оформить документ", "проверить данные"],
  },
  {
    id: "ref-2-approval",
    processName: "Эталон: согласование",
    text: "Владелец: Специалист согласовывает заявку с руководителем. Затем руководитель утверждает заявку.",
    expectedRoles: ["Специалист", "Руководитель"],
    expectedNodeNames: ["согласовать заявку", "утвердить документ"],
  },
  {
    id: "ref-3-branch",
    processName: "Эталон: ветвление",
    text: "Владелец: Если бюджет превышен, директор отклоняет заявку. Иначе кассир выполняет оплату.",
    expectedRoles: ["Директор", "Кассир"],
    expectedNodeNames: ["отклонить заявку", "выполнить задачу"],
  },
];

export interface EvalCaseResult {
  caseId: string;
  expectedRoles: string[];
  foundRoles: string[];
  expectedNodes: string[];
  foundNodes: string[];
  roleRecall: number;
  nodeRecall: number;
  error?: string;
}

export interface EvalSummary {
  provider: string;
  cases: EvalCaseResult[];
  avgRoleRecall: number;
  avgNodeRecall: number;
}

function recall(expected: string[], found: string[]): number {
  if (expected.length === 0) return 1;
  const foundSet = new Set(found);
  return expected.filter((e) => foundSet.has(e)).length / expected.length;
}

/** Прогоняет эталонный набор через указанный провайдер и считает recall по ролям и действиям. */
export async function runReferenceEval(provider: LLMProvider): Promise<EvalSummary> {
  const cases: EvalCaseResult[] = [];
  for (const c of REFERENCE_SET) {
    const fragments = fragmentText(c.text);
    const llmInput: LLMFragmentInput[] = fragments.map((f) => ({ id: f.id, speaker: f.speaker, speaker_label: f.speaker_label, text: f.text }));
    let foundRoles: string[] = [];
    let foundNodes: string[] = [];
    let error: string | undefined;
    try {
      const chunkResult = await provider.extractChunk(llmInput, { processName: c.processName, modelType: "AS-IS" });
      foundRoles = (chunkResult.roles ?? []).map((r) => r.name);
      foundNodes = (chunkResult.nodes ?? []).map((n) => n.name);
    } catch (e) {
      error = (e as Error).message;
    }
    cases.push({
      caseId: c.id,
      expectedRoles: c.expectedRoles,
      foundRoles,
      expectedNodes: c.expectedNodeNames,
      foundNodes,
      roleRecall: recall(c.expectedRoles, foundRoles),
      nodeRecall: recall(c.expectedNodeNames, foundNodes),
      error,
    });
  }
  const avgRoleRecall = cases.reduce((s, c) => s + c.roleRecall, 0) / cases.length;
  const avgNodeRecall = cases.reduce((s, c) => s + c.nodeRecall, 0) / cases.length;
  return { provider: provider.name, cases, avgRoleRecall, avgNodeRecall };
}
