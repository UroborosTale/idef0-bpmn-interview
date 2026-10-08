import { useState } from "react";
import { api, type AgentQuestionRow } from "../../api/client";

const PRIORITY: Record<AgentQuestionRow["priority"], string> = { critical: "критично", important: "важно", desirable: "желательно" };
const STATUS: Record<AgentQuestionRow["status"], string> = { open: "ждёт интервью", asked: "задан", answered: "получен ответ", dismissed: "снят" };

/** Вопросы, ждущие интервью: ещё не заданные и заданные без ответа. */
export const isLiveQuestion = (q: AgentQuestionRow) => q.status === "open" || q.status === "asked";

/**
 * Лист вопросов к следующему интервью для печати или письма: по функциям в порядке процесса, внутри — по важности.
 * Адресат и «зачем» помогают провести интервью; ответов и снятых вопросов в листе нет.
 */
export function interviewSheet(questions: AgentQuestionRow[], labelOf: (nodeId: string) => string, processName: string): string {
  const live = questions.filter(isLiveQuestion);
  const groups = new Map<string | null, AgentQuestionRow[]>();
  for (const q of live) groups.set(q.scopeNodeId, [...(groups.get(q.scopeNodeId) ?? []), q]);
  const lines = [`Вопросы к интервью: ${processName}`, ""];
  let n = 0;
  for (const [scope, items] of groups) {
    lines.push(scope ? labelOf(scope) : "Процесс в целом");
    for (const q of items) lines.push(`${++n}. [${PRIORITY[q.priority]}] ${q.text}${q.addressee ? ` — спросить: ${q.addressee}` : ""}${q.reason ? ` (зачем: ${q.reason})` : ""}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

/** Автор вопроса: роль агента или интервьюер (подпись «user:логин» ставит сервер для вопросов, заданных в ходе интервью). */
const authorOf = (agent: string) => (agent.startsWith("user:") ? `задан интервьюером${agent !== "user:local" ? ` (${agent.slice(5)})` : ""}` : `от агента ${agent}`);

/**
 * Вопросы к интервью. Их готовит агент-интервьюер (MCP add_questions); здесь аналитик видит список с адресатами и
 * приоритетами, переносит его на интервью и отмечает, что задано и что отвечено. Ответ на вопрос в модель вносит моделист
 * по новым фрагментам интервью — отметка здесь только помогает агентам не повторяться.
 */
export default function QuestionsPanel({
  questions,
  labelOf,
  processName,
  onStatus,
  onHandOff,
  sessionId,
}: {
  questions: AgentQuestionRow[];
  labelOf: (nodeId: string) => string;
  processName: string;
  onStatus: (q: AgentQuestionRow, status: AgentQuestionRow["status"], answer?: string) => void | Promise<void>;
  /** Поручить моделисту внести в модель полученные ответы (одним заданием). */
  onHandOff?: () => void | Promise<void>;
  /** Сессия — для выгрузки листа вопросов в Word. */
  sessionId?: string;
}) {
  const [showClosed, setShowClosed] = useState(false);
  const [answering, setAnswering] = useState<string | null>(null);
  const [answer, setAnswer] = useState("");
  const [copied, setCopied] = useState(false);
  const live = questions.filter(isLiveQuestion);
  const toHandOff = questions.filter((q) => q.status === "answered" && !q.handoffTaskId);
  const shown = showClosed ? questions : live;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(interviewSheet(questions, labelOf, processName));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* буфер обмена недоступен — список остаётся на экране */
    }
  };
  const commitAnswer = (q: AgentQuestionRow) => {
    void onStatus(q, "answered", answer.trim() || undefined);
    setAnswering(null);
    setAnswer("");
  };

  return (
    <div className="questions">
      <div className="task-form-row questions-bar">
        <span className="muted">
          {live.length ? `Ждут интервью: ${live.length}` : "Ждущих вопросов нет"}
        </span>
        <span className="spacer" />
        <label className="problems-filter">
          <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} /> с отвеченными и снятыми ({questions.length - live.length})
        </label>
        {onHandOff && (
          <button
            className={toHandOff.length ? "primary" : ""}
            disabled={toHandOff.length === 0}
            onClick={() => void onHandOff()}
            title="Задание моделисту: внести ответы владельца в модель. При завершении интервью в чате это делается само"
          >
            Передать ответы моделисту ({toHandOff.length})
          </button>
        )}
        {sessionId && live.length > 0 && (
          <a className="btn-link" href={api.questionsDocxUrl(sessionId)} download title="Лист вопросов по функциям, с колонкой для записи ответа">
            Скачать Word
          </a>
        )}
        <button disabled={live.length === 0} onClick={() => void copy()} title="Список для интервью: по функциям, с адресатами">
          {copied ? "Скопировано" : "Копировать для интервью"}
        </button>
      </div>
      {questions.length === 0 && <div className="muted problems-empty">Вопросов нет. Их готовит агент-интервьюер (инструмент add_questions) — например, по заданию «подготовь вопросы к следующему интервью».</div>}
      {questions.length > 0 && shown.length === 0 && <div className="muted problems-empty">Все вопросы закрыты.</div>}
      {shown.map((q) => (
        <div key={q.id} className={`task question question-${q.status}`} data-question-id={q.id}>
          <div className="proposal-head">
            <span className={`agent-badge question-prio-${q.priority}`}>{PRIORITY[q.priority]}</span>
            <span>{q.text}</span>
            <span className="spacer" />
            <span className="muted">{STATUS[q.status]}</span>
          </div>
          <div className="muted task-meta">
            {q.scopeNodeId ? `${labelOf(q.scopeNodeId)} · ` : "процесс в целом · "}
            {q.addressee ? `спросить: ${q.addressee} · ` : ""}{authorOf(q.agent)} · {new Date(q.createdAt).toLocaleString("ru-RU")}
          </div>
          {q.reason && <p className="proposal-why">Зачем: {q.reason}</p>}
          {q.handoffTaskId && <p className="muted task-meta">Передано моделисту: задание {q.handoffTaskId}</p>}
          {q.status === "answered" && <p className="proposal-why">Ответ{q.fragmentId ? ` (фрагмент ${q.fragmentId})` : ""}: {q.answer ?? "дан на интервью"}</p>}
          {answering === q.id ? (
            <div className="proposal-actions">
              <input
                autoFocus
                value={answer}
                placeholder="Ответ респондента (необязательно) — Enter"
                onChange={(e) => setAnswer(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") commitAnswer(q);
                  if (e.key === "Escape") setAnswering(null);
                }}
              />
              <button className="primary" onClick={() => commitAnswer(q)}>
                Ответ получен
              </button>
              <button onClick={() => setAnswering(null)}>Отмена</button>
            </div>
          ) : (
            <div className="proposal-actions">
              {q.status === "open" && <button onClick={() => void onStatus(q, "asked")}>Задан</button>}
              {isLiveQuestion(q) && (
                <button
                  onClick={() => {
                    setAnswering(q.id);
                    setAnswer("");
                  }}
                >
                  Получен ответ
                </button>
              )}
              {isLiveQuestion(q) && <button onClick={() => void onStatus(q, "dismissed")}>Снять</button>}
              {!isLiveQuestion(q) && <button onClick={() => void onStatus(q, "open")}>Вернуть в список</button>}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
