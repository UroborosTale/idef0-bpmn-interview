import { Router } from "express";
import { db } from "../db.js";
import { getSession } from "../repo.js";
import { AGENT_LABELS, type AgentKey } from "../pipeline/agents.js";
import { findSimilarEntries } from "../pipeline/corpus.js";
import { runReferenceEval } from "../pipeline/evalHarness.js";
import { getProviderByName, providerStatus } from "../llm/provider.js";

export const technologyRouter = Router();

/** ФТ-М9.1.3: порог накопления пар для (опционального) дообучения локальной модели. */
const FINE_TUNE_THRESHOLD = 100;

interface AgentModelRow {
  agent_key: string;
  model_name: string;
}

/** ФТ-М9.2.4: настройка модели LLM для каждого агента. */
technologyRouter.get("/agent-config", (_req, res) => {
  const rows = db.prepare(`SELECT * FROM agent_model_config`).all() as AgentModelRow[];
  res.json(rows.map((r) => ({ agentKey: r.agent_key, label: AGENT_LABELS[r.agent_key as AgentKey] ?? r.agent_key, modelName: r.model_name })));
});

technologyRouter.put("/agent-config/:agentKey", (req, res) => {
  const { modelName } = req.body as { modelName: string };
  if (!modelName || !modelName.trim()) {
    res.status(400).json({ error: "modelName обязателен" });
    return;
  }
  db.prepare(`UPDATE agent_model_config SET model_name = ? WHERE agent_key = ?`).run(modelName.trim(), req.params.agentKey);
  const row = db.prepare(`SELECT * FROM agent_model_config WHERE agent_key = ?`).get(req.params.agentKey) as AgentModelRow | undefined;
  if (!row) {
    res.status(404).json({ error: "агент не найден" });
    return;
  }
  res.json({ agentKey: row.agent_key, label: AGENT_LABELS[row.agent_key as AgentKey] ?? row.agent_key, modelName: row.model_name });
});

/** ФТ-М9.2.3: журнал шагов агентов по сессии. */
technologyRouter.get("/sessions/:id/agent-runs", (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const rows = db.prepare(`SELECT * FROM agent_run_log WHERE session_id = ? ORDER BY id ASC`).all(req.params.id) as any[];
  res.json(
    rows.map((r) => ({ id: r.id, runId: r.run_id, iteration: r.iteration, agent: r.agent, label: AGENT_LABELS[r.agent as AgentKey] ?? r.agent, summary: r.summary, model: r.model, ts: r.ts }))
  );
});

/** ФТ-М9.1.1/9.1.3: размер корпуса и готовность к (опциональному) дообучению. */
technologyRouter.get("/corpus/stats", (_req, res) => {
  const count = (db.prepare(`SELECT COUNT(*) AS c FROM corpus_entries`).get() as { c: number }).c;
  res.json({
    count,
    fineTuneThreshold: FINE_TUNE_THRESHOLD,
    fineTuneReady: count >= FINE_TUNE_THRESHOLD,
    note: "Реальное дообучение локальной модели (ФТ-М9.1.3) требует GPU-инфраструктуры, недоступной в этом окружении — отслеживается только готовность корпуса по порогу.",
  });
});

/** ФТ-М9.1.1: список записей корпуса (без полного текста/модели — только метаданные). */
technologyRouter.get("/corpus", (_req, res) => {
  const rows = db.prepare(`SELECT id, session_id, process_name, created_at FROM corpus_entries ORDER BY created_at DESC LIMIT 200`).all() as any[];
  res.json(rows.map((r) => ({ id: r.id, sessionId: r.session_id, processName: r.process_name, createdAt: r.created_at })));
});

/** ФТ-М9.1.2: похожие утверждённые примеры из корпуса для заданного текста (TF-IDF, см. pipeline/corpus.ts). */
technologyRouter.get("/corpus/similar", (req, res) => {
  const text = (req.query.text as string) || "";
  if (!text.trim()) {
    res.status(400).json({ error: "text обязателен" });
    return;
  }
  const rows = db.prepare(`SELECT id, process_name, raw_text FROM corpus_entries ORDER BY created_at DESC LIMIT 200`).all() as any[];
  const similar = findSimilarEntries(
    text,
    rows.map((r) => ({ id: r.id, processName: r.process_name, rawText: r.raw_text }))
  );
  res.json(similar);
});

/** ФТ-М9.1.4/9.3.3: прогон эталонного набора на указанном провайдере (регрессия/сравнение деградации). */
technologyRouter.get("/eval", async (req, res) => {
  const providerName = (req.query.provider as string) || "mock";
  try {
    const provider = getProviderByName(providerName);
    const summary = await runReferenceEval(provider);
    res.json(summary);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

/** ФТ-М9.3.1/9.3.2: статус провайдеров (доступность локального провайдера для конфиденциальных процессов). */
technologyRouter.get("/llm-status", (_req, res) => {
  res.json(providerStatus());
});
