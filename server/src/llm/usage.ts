import { AsyncLocalStorage } from "node:async_hooks";
import { db } from "../db.js";

/**
 * Учёт расхода LLM: каждый вызов провайдера записывает число токенов, а сессия, к которой он относится,
 * берётся из контекста выполнения (withLlmContext) — провайдерам не нужно знать о сессиях.
 * Стоимость оценивается по ценам из окружения (долларов за 1 млн токенов), если они заданы.
 */

db.exec(`CREATE TABLE IF NOT EXISTS llm_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  provider TEXT NOT NULL,
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  ts TEXT NOT NULL
)`);
db.exec(`CREATE INDEX IF NOT EXISTS llm_usage_session ON llm_usage(session_id)`);

const ctx = new AsyncLocalStorage<{ sessionId: string | null }>();

export const withLlmContext = <T>(sessionId: string | null, fn: () => Promise<T>): Promise<T> => ctx.run({ sessionId }, fn);

export function recordUsage(provider: string, model: string | undefined, inputTokens: number | undefined, outputTokens: number | undefined): void {
  if (!inputTokens && !outputTokens) return;
  try {
    db.prepare(`INSERT INTO llm_usage (session_id, provider, model, input_tokens, output_tokens, ts) VALUES (?, ?, ?, ?, ?, ?)`).run(
      ctx.getStore()?.sessionId ?? null,
      provider,
      model ?? null,
      Math.round(inputTokens ?? 0),
      Math.round(outputTokens ?? 0),
      new Date().toISOString()
    );
  } catch (e) {
    console.warn("не удалось записать расход LLM", e); // учёт не должен ломать обработку
  }
}

const price = (name: string) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : null;
};

export interface UsageSummary {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** Оценка в долларах, если заданы LLM_PRICE_INPUT_PER_M и LLM_PRICE_OUTPUT_PER_M. */
  costUsd: number | null;
  byModel: { provider: string; model: string | null; calls: number; inputTokens: number; outputTokens: number }[];
}

export function usageForSession(sessionId: string): UsageSummary {
  const rows = db
    .prepare(
      `SELECT provider, model, COUNT(*) AS calls, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens
       FROM llm_usage WHERE session_id = ? GROUP BY provider, model ORDER BY calls DESC`
    )
    .all(sessionId) as { provider: string; model: string | null; calls: number; input_tokens: number; output_tokens: number }[];
  const byModel = rows.map((r) => ({ provider: r.provider, model: r.model, calls: r.calls, inputTokens: r.input_tokens, outputTokens: r.output_tokens }));
  const inputTokens = byModel.reduce((s, r) => s + r.inputTokens, 0);
  const outputTokens = byModel.reduce((s, r) => s + r.outputTokens, 0);
  const pin = price("LLM_PRICE_INPUT_PER_M");
  const pout = price("LLM_PRICE_OUTPUT_PER_M");
  return {
    calls: byModel.reduce((s, r) => s + r.calls, 0),
    inputTokens,
    outputTokens,
    costUsd: pin !== null && pout !== null ? Math.round(((inputTokens * pin + outputTokens * pout) / 1e6) * 10000) / 10000 : null,
    byModel,
  };
}
