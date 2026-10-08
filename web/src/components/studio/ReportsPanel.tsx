import { useState } from "react";
import type { AgentReportRow } from "../../api/client";

const KIND: Record<AgentReportRow["kind"], string> = { analysis: "анализ", review: "проверка", methodology: "методология", other: "прочее" };
const STATUS: Record<AgentReportRow["status"], string> = { new: "новый", read: "прочитан", archived: "в архиве" };
const LEVEL = { high: "высокое", medium: "среднее", low: "низкое" } as const;

/**
 * Отчёты агентов: выводы аналитика, итоги проверок, разборы методолога (MCP add_report). Отчёт модель не меняет — его
 * читают и убирают в архив; правки по выводам агент предлагает отдельно, на вкладке «Предложения агентов». Открытие
 * нового отчёта отмечает его прочитанным.
 */
export default function ReportsPanel({
  reports,
  labelOf,
  onStatus,
}: {
  reports: AgentReportRow[];
  labelOf: (nodeId: string) => string;
  onStatus: (r: AgentReportRow, status: AgentReportRow["status"]) => void | Promise<void>;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const archived = reports.filter((r) => r.status === "archived").length;
  const shown = showArchived ? reports : reports.filter((r) => r.status !== "archived");

  const toggle = (r: AgentReportRow) => {
    const next = open === r.id ? null : r.id;
    setOpen(next);
    if (next && r.status === "new") void onStatus(r, "read");
  };

  return (
    <div className="reports">
      <div className="task-form-row questions-bar">
        <span className="muted">{reports.some((r) => r.status === "new") ? `Новых отчётов: ${reports.filter((r) => r.status === "new").length}` : "Новых отчётов нет"}</span>
        <span className="spacer" />
        <label className="problems-filter">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> с архивом ({archived})
        </label>
      </div>
      {reports.length === 0 && <div className="muted problems-empty">Отчётов нет. Их присылает агент-аналитик (инструмент add_report) — например, по заданию «найди узкие места процесса».</div>}
      {reports.length > 0 && shown.length === 0 && <div className="muted problems-empty">Все отчёты в архиве.</div>}
      {shown.map((r) => (
        <div key={r.id} className={`task report report-${r.status}`} data-report-id={r.id}>
          <div className="proposal-head report-head" onClick={() => toggle(r)} role="button" aria-expanded={open === r.id}>
            <span className={`agent-badge ${r.status === "new" ? "task-badge-open" : ""}`}>{STATUS[r.status]}</span>
            <strong>{r.title}</strong>
            <span className="spacer" />
            <span className="muted">
              {KIND[r.kind]} · {r.agent} · {new Date(r.createdAt).toLocaleString("ru-RU")}
            </span>
          </div>
          {r.summary && <p className="proposal-why">{r.summary}</p>}
          {open === r.id && (
            <div className="report-body">
              {r.scopeNodeId && <div className="muted task-meta">Относится к: {labelOf(r.scopeNodeId)}</div>}
              {r.findings.length > 0 && (
                <table className="report-findings">
                  <thead>
                    <tr>
                      <th>Влияние</th>
                      <th>Вывод</th>
                      <th>Где</th>
                      <th>Основание</th>
                      <th>Уверенность</th>
                      <th>Рекомендация</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.findings.map((f, i) => (
                      <tr key={i} className={`finding-${f.impact}`}>
                        <td>{LEVEL[f.impact]}</td>
                        <td>{f.what}</td>
                        <td>{f.where ?? ""}</td>
                        <td>{f.basis ?? ""}</td>
                        <td>{LEVEL[f.confidence]}</td>
                        <td>{f.recommendation ?? ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {r.body && <pre className="report-text">{r.body}</pre>}
            </div>
          )}
          <div className="proposal-actions">
            {r.status === "archived" ? <button onClick={() => void onStatus(r, "read")}>Вернуть из архива</button> : <button onClick={() => void onStatus(r, "archived")}>В архив</button>}
            {r.status === "read" && <button onClick={() => void onStatus(r, "new")}>Отметить новым</button>}
          </div>
        </div>
      ))}
    </div>
  );
}
