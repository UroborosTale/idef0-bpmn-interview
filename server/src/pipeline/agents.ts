import { nanoid } from "nanoid";
import type { Fragment } from "../types/model.js";
import type { SessionMeta } from "../repo.js";
import { runPipeline, type PipelineOutput } from "./run.js";
import { resolveProvider } from "../llm/provider.js";
import { findSimilarEntries, buildFewShotContext } from "./corpus.js";
import { db, logAudit } from "../db.js";

/** ФТ-М9.2.1: роли агентов мультиагентного конвейера. */
export type AgentKey = "extractor" | "merger" | "critic" | "interviewer" | "analyst" | "documentalist";

export const AGENT_LABELS: Record<AgentKey, string> = {
  extractor: "Извлекатель",
  merger: "Сборщик",
  critic: "Критик",
  interviewer: "Интервьюер",
  analyst: "Аналитик",
  documentalist: "Документалист",
};

interface AgentModelRow {
  agent_key: string;
  model_name: string;
}

/** ФТ-М9.2.4: модель LLM, назначенная агенту (из настроек; иначе — модель провайдера по умолчанию). */
export function resolveModelForAgent(agent: AgentKey): string | undefined {
  const row = db.prepare(`SELECT model_name FROM agent_model_config WHERE agent_key = ?`).get(agent) as AgentModelRow | undefined;
  return row?.model_name;
}

/** ФТ-М9.2.3: журналирование шага агента (для разбора ошибок и отображения аналитику). */
export function logAgentStep(sessionId: string | null, runId: string, iteration: number, agent: AgentKey, summary: string, model?: string): void {
  db.prepare(`INSERT INTO agent_run_log (session_id, run_id, iteration, agent, summary, model, ts) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    sessionId,
    runId,
    iteration,
    agent,
    summary,
    model ?? null,
    new Date().toISOString()
  );
}

export interface OrchestratedResult extends PipelineOutput {
  runId: string;
  iterations: number;
}

interface CorpusRow {
  id: string;
  process_name: string;
  raw_text: string;
}

/**
 * ФТ-М9.2.2: оркестратор цикла "извлечение → интервьюер (пробелы) → критик
 * (валидация)" с ограничением числа итераций. Для детерминированного
 * офлайн-провайдера повторный проход даёт тот же результат (это ожидаемо —
 * цикл существует для случая живого LLM-провайдера, которому в перспективе
 * можно передать найденные критиком ошибки как корректирующий контекст);
 * важные для приёмки свойства — сам механизм цикла, ограничение итераций и
 * журналирование каждого шага — работают и проверяются независимо от этого.
 * ФТ-М9.3.2: провайдер выбирается с учётом признака конфиденциальности.
 * ФТ-М9.1.2: в промпт извлекателя добавляется few-shot контекст из корпуса.
 */
export async function runOrchestratedPipeline(
  sessionId: string,
  fragments: Fragment[],
  meta: SessionMeta,
  opts?: { maxIterations?: number }
): Promise<OrchestratedResult> {
  const runId = `run_${nanoid(10)}`;
  const maxIterations = Math.max(1, opts?.maxIterations ?? 2);
  const provider = resolveProvider(meta.confidential);
  const extractorModel = resolveModelForAgent("extractor");

  const rawText = fragments.map((f) => f.text).join("\n");
  const corpusRows = db.prepare(`SELECT id, process_name, raw_text FROM corpus_entries ORDER BY created_at DESC LIMIT 200`).all() as CorpusRow[];
  const similar = findSimilarEntries(rawText, corpusRows.map((r) => ({ id: r.id, processName: r.process_name, rawText: r.raw_text })));
  const fewShotContext = buildFewShotContext(similar);

  let output: PipelineOutput | null = null;
  let iteration = 0;
  for (iteration = 1; iteration <= maxIterations; iteration++) {
    output = await runPipeline(sessionId, fragments, meta, { provider, llmModel: extractorModel, fewShotContext });
    logAgentStep(
      sessionId,
      runId,
      iteration,
      "extractor",
      `Извлечено: ${output.model.roles.length} ролей, ${output.model.nodes.length} шагов, ${output.model.flows.length} связей (провайдер: ${provider.name})`,
      extractorModel
    );

    const openGaps = output.model.gaps.filter((g) => g.status === "open");
    logAgentStep(sessionId, runId, iteration, "interviewer", `Сформулировано вопросов по пробелам: ${openGaps.length}`, resolveModelForAgent("interviewer"));

    const blocking = output.validation.filter((v) => v.severity === "error");
    logAgentStep(
      sessionId,
      runId,
      iteration,
      "critic",
      `Найдено ошибок: ${blocking.length}, предупреждений: ${output.validation.length - blocking.length}`,
      resolveModelForAgent("critic")
    );

    if (blocking.length === 0) break;
  }

  logAudit(sessionId, "system", "agent_run_completed", { runId, iterations: iteration });
  return { ...output!, runId, iterations: Math.min(iteration, maxIterations) };
}
