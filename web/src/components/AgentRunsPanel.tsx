import { useEffect, useState } from "react";
import { api, type AgentRunRow } from "../api/client";

/** ФТ-М9.2.3: журнал шагов мультиагентного конвейера по сессии. */
export default function AgentRunsPanel({ sessionId }: { sessionId: string }) {
  const [rows, setRows] = useState<AgentRunRow[] | null>(null);

  useEffect(() => {
    api.listAgentRuns(sessionId).then(setRows);
  }, [sessionId]);

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
        Шаги мультиагентного конвейера (Извлекатель → Интервьюер → Критик, с повтором до {"2"} итераций при найденных критиком ошибках; Сборщик/Аналитик/Документалист — по вызову соответствующих операций).
      </p>
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
