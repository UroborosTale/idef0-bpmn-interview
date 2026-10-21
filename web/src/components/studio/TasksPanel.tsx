import { useEffect, useState } from "react";
import type { AgentTaskRow } from "../../api/client";

const STATUS: Record<AgentTaskRow["status"], string> = { open: "ждёт агента", taken: "в работе", done: "выполнено", cancelled: "отменено" };
const PROPOSAL_STATUS = { pending: "ожидает решения", applied: "применено", rejected: "отклонено" } as const;

/** Роли агентов, которым можно адресовать задание (необязательно). */
const AGENTS = ["моделист", "нормоконтролёр", "интервьюер", "аналитик"];

/**
 * Задания агенту: аналитик формулирует поручение («разбей операцию B002.01.02 на шаги», «проверь роли»), агент (Cline) забирает
 * его через MCP-сервер и отвечает предложениями — они появятся на вкладке «Предложения агентов». Агент и студия не обязаны
 * работать одновременно: задание ждёт, пока агент до него дойдёт.
 */
export default function TasksPanel({
  tasks,
  selected,
  labelOf,
  onCreate,
  onCancel,
  onShowProposals,
}: {
  tasks: AgentTaskRow[];
  /** Выделенная в студии функция — к ней привязывается задание. */
  selected: { id: string; label: string } | null;
  labelOf: (nodeId: string) => string;
  onCreate: (task: { text: string; scope: string | null; agent?: string }) => void | Promise<void>;
  onCancel: (task: AgentTaskRow) => void | Promise<void>;
  onShowProposals: () => void;
}) {
  const [text, setText] = useState("");
  const [agent, setAgent] = useState("");
  const [withScope, setWithScope] = useState(true);
  const [busy, setBusy] = useState(false);
  useEffect(() => setWithScope(true), [selected?.id]);

  const send = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      await onCreate({ text: text.trim(), scope: withScope && selected ? selected.id : null, ...(agent ? { agent } : {}) });
      setText("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="tasks">
      <div className="task-form">
        <textarea
          rows={2}
          value={text}
          placeholder="Что поручить агенту? Например: разбей операцию на шаги по тексту интервью; проверь роли; найди повторы в названиях"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void send();
          }}
        />
        <div className="task-form-row">
          {selected ? (
            <label className="problems-filter">
              <input type="checkbox" checked={withScope} onChange={(e) => setWithScope(e.target.checked)} /> к функции {selected.label}
            </label>
          ) : (
            <span className="muted">ко всему процессу (выделите функцию — задание привяжется к ней)</span>
          )}
          <span className="spacer" />
          <select value={agent} aria-label="Кому адресовано" onChange={(e) => setAgent(e.target.value)}>
            <option value="">любому агенту</option>
            {AGENTS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
          <button className="primary" disabled={busy || !text.trim()} onClick={() => void send()} title="Ctrl+Enter">
            Поручить
          </button>
        </div>
      </div>
      {tasks.length === 0 && <div className="muted problems-empty">Заданий нет. Агент увидит поручение, когда обратится к MCP-серверу (инструмент get_tasks).</div>}
      {tasks.map((t) => (
        <div key={t.id} className={`task task-${t.status}`} data-task-id={t.id}>
          <div className="proposal-head">
            <span className={`agent-badge task-badge-${t.status}`}>{STATUS[t.status]}{t.status === "taken" && t.takenBy ? ` · ${t.takenBy}` : ""}</span>
            <span>{t.text}</span>
          </div>
          <div className="muted task-meta">
            {t.scopeNodeId ? `функция ${labelOf(t.scopeNodeId)} · ` : "процесс в целом · "}
            {t.createdBy.startsWith("agent:") ? `от агента ${t.createdBy.slice(6)} · ` : ""}
            {t.agent ? `адресовано: ${t.agent} · ` : ""}
            {new Date(t.createdAt).toLocaleString("ru-RU")}
          </div>
          {t.resultNote && <p className="proposal-why">Итог агента: {t.resultNote}</p>}
          {t.proposals.length > 0 && (
            <ul className="proposal-lines">
              {t.proposals.map((p) => (
                <li key={p.id}>
                  <button className="link-button" onClick={onShowProposals}>
                    {p.title}
                  </button>{" "}
                  — {PROPOSAL_STATUS[p.status]}
                </li>
              ))}
            </ul>
          )}
          {(t.status === "open" || t.status === "taken") && (
            <div className="proposal-actions">
              <button onClick={() => void onCancel(t)}>Отменить</button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
