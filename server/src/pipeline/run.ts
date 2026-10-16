import type { Fragment, ProcessLogicModel, ValidationIssue } from "../types/model.js";
import { extractModel, type ExtractionReport, type ExtractProgress } from "./extract.js";
import { detectGaps } from "./gaps.js";
import { validateModel } from "./validate.js";
import { generateBpmn } from "./bpmn.js";
import { generateIdef0, type Idef0Result } from "./idef0.js";
import { getLLMProvider } from "../llm/provider.js";
import type { LLMProvider } from "../llm/types.js";
import type { SessionMeta } from "../repo.js";
import { keepGapStatuses } from "./carryOver.js";

export interface PipelineOutput {
  model: ProcessLogicModel;
  validation: ReturnType<typeof validateModel>;
  bpmnXml: string;
  idef0: Idef0Result;
  providerName: string;
  report: ExtractionReport;
}

/** Сбои извлечения — предупреждения в проверках модели, чтобы неполная модель не выглядела полной. */
export function reportIssues(report: ExtractionReport): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  report.failedChunks.forEach((c, i) => {
    const range = c.fragmentIds.length > 1 ? `${c.fragmentIds[0]}–${c.fragmentIds[c.fragmentIds.length - 1]}` : c.fragmentIds[0];
    issues.push({
      id: `extract_fail_${i + 1}`,
      notation: "MODEL",
      severity: "warning",
      rule: "extract_chunk_failed",
      message: `Фрагменты ${range} не обработаны (ошибка LLM: ${c.error.slice(0, 160)}). Модель неполная — перезапустите обработку.`,
      element_id: null,
    });
  });
  if (report.unverified > 0) {
    issues.push({
      id: "extract_unverified",
      notation: "MODEL",
      severity: "warning",
      rule: "extract_quote_unverified",
      message: `У ${report.unverified} извлечённых элементов цитата не найдена в тексте интервью — они помечены как гипотезы, проверьте их.`,
      element_id: null,
    });
  }
  return issues;
}

/** Пересчитывает пробелы, проверки и диаграммы для изменённой модели (например, после переноса ручных правок). */
export async function rebuildOutputs(model: ProcessLogicModel, report: ExtractionReport, prevGaps: ProcessLogicModel["gaps"] = []) {
  model.gaps = keepGapStatuses(prevGaps, detectGaps(model));
  const validation = [...reportIssues(report), ...validateModel(model)];
  const bpmn = await generateBpmn(model);
  return { model, validation, bpmnXml: bpmn.xml, idef0: generateIdef0(model) };
}

/**
 * Общее ядро конвейера (ФТ-3..ФТ-8), используемое и режимом А, и режимом Б:
 * извлечение → пробелы → валидация → генерация BPMN/IDEF0.
 * ФТ-М9.2/9.3: provider/llmModel/fewShotContext позволяют оркестратору
 * (pipeline/agents.ts) подставить конфиденциально-маршрутизированный
 * провайдер, модель конкретного агента и few-shot контекст из корпуса —
 * по умолчанию поведение не меняется (используется глобальный провайдер).
 */
export async function runPipeline(
  processId: string,
  fragments: Fragment[],
  meta: SessionMeta,
  opts?: { provider?: LLMProvider; llmModel?: string; fewShotContext?: string; onProgress?: (p: ExtractProgress) => void }
): Promise<PipelineOutput> {
  const provider = opts?.provider ?? getLLMProvider();
  const report: ExtractionReport = { failedChunks: [], dropped: 0, unverified: 0 };
  const model = await extractModel(fragments, provider, {
    processId,
    processName: meta.processName,
    modelType: meta.modelType,
    department: meta.department,
    owner: meta.owner,
    decompositionDepth: meta.decompositionDepth,
    llmModel: opts?.llmModel,
    fewShotContext: opts?.fewShotContext,
    onProgress: opts?.onProgress,
    report,
  });

  model.gaps = detectGaps(model);
  // Код процесса, заданный аналитиком при создании сессии: если извлечение код не нашло, берём его
  if (meta.code && !model.process.code) model.process.code = meta.code;
  const validation = [...reportIssues(report), ...validateModel(model)];
  const bpmn = await generateBpmn(model);
  const idef0 = generateIdef0(model);

  return { model, validation, bpmnXml: bpmn.xml, idef0, providerName: provider.name, report };
}
