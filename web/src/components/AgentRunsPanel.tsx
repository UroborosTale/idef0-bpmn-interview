import { useEffect, useState } from "react";
import { api, type AgentRunRow, type LlmUsage } from "../api/client";

/** ФТ-М9.2.3: журнал шагов мультиагентного конвейера по сессии. */
export default function AgentRunsPanel({ sessionId }: { sessionId: string }) {
  const [rows, setRows] = useState<AgentRunRow[] | null>(null);
  const [usage, setUsage] = useState<LlmUsage | null>(null);

  useEffect(() => {
    api.listAgentRuns(sessionId).then(setRows);
    api.llmUsage(sessionId).then(setUsage).catch(() => setUsage(null));
  }, [sessionId]);
  const fmt = (n: number) => n.toLocaleString("ru-RU");

  if (!rows) return <p className="muted">Загрузка…</p>;

  const byRun = new Map<string, AgentRunRow[]>();
  for (const r of rows) byRun.set(r.runId, [...(byRun.get(r.runId) ?? []), r]);
  const runIds = [...byRun.keys()].reverse();

  return (
    <div>
      <div className="toolbar">
        <h4 style={{ margin: 0 }}>Журнал агентов</h4>
      </div>
      <p className="muted" style={{ fontSize: 12 }}>
        Шаги мультиагентного конвейера (Извлекатель → Интервьюер → Критик; повторный проход при ошибках критика — по настройке AGENT_MAX_ITERATIONS, для платных LLM по умолчанию один проход; Сборщик/Аналитик/Документалист — по вызову соответствующих операций).
      </p>
      {usage && usage.calls > 0 && (
        <div className="card" style={{ marginTop: 10 }}>
          <b>Расход LLM по сессии:</b> {fmt(usage.calls)} вызовов, {fmt(usage.inputTokens)} входных и {fmt(usage.outputTokens)} выходных токенов
          {usage.costUsd !== null ? ` · ≈ $${usage.costUsd}` : " · стоимость не считается (задайте LLM_PRICE_INPUT_PER_M и LLM_PRICE_OUTPUT_PER_M)"}
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            {usage.byModel.map((m) => `${m.provider}${m.model ? ` / ${m.model}` : ""}: ${fmt(m.calls)} выз., ${fmt(m.inputTokens + m.outputTokens)} ток.`).join(" · ")}
          </div>
        </div>
      )}
      {runIds.length === 0 && <p className="muted">Пока нет ни одного запуска.</p>}
      {runIds.map((runId) => (
        <div key={runId} className="card" style={{ marginTop: 10, background: "#f8fafc" }}>
          <div className="muted" style={{ fontSize: 12 }}>Запуск {runId}</div>
          <table className="mono" style={{ width: "100%", fontSize: 12, marginTop: 6, borderCollapse: "collapse" }}>
            <thead><tr style={{ textAlign: "left" }}><th>Итерация</th><th>Агент</th><th>Описание</th><th>Модель</th><th>Время</th></tr></thead>
            <tbody>
              {byRun.get(runId)!.map((r) => (
                <tr key={r.id} style={{ borderTop: "1px solid #e5e7eb" }}>
                  <td>{r.iteration}</td>
                  <td>{r.label}</td>
                  <td>{r.summary}</td>
                  <td className="muted">{r.model ?? "—"}</td>
                  <td className="muted">{new Date(r.ts).toLocaleTimeString("ru-RU")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}
