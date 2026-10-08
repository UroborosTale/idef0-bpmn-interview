import { useEffect, useState } from "react";
import type { AgentQuestionRow } from "../../api/client";

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

/**
 * Вопросы к интервью. Их готовит агент-интервьюер (MCP add_questions); здесь аналитик видит список с адресатами и
 * приоритетами, переносит его на интервью и отмечает, что задано и что отвечено. Ответ на вопрос в модель вносит моделист
 * по новым фрагментам интервью — отметка здесь только помогает агентам не повторяться.
 */
/** Автор вопроса: роль агента или человек (подпись «user:логин» ставит сервер для вопросов, добавленных вручную). */
const authorOf = (agent: string) => (agent.startsWith("user:") ? `добавлен вручную (${agent.slice(5)})` : `от агента ${agent}`);

export default function QuestionsPanel({
  questions,
  labelOf,
  processName,
  onStatus,
  selected = null,
  onAdd,
}: {
  questions: AgentQuestionRow[];
  labelOf: (nodeId: string) => string;
  processName: string;
  onStatus: (q: AgentQuestionRow, status: AgentQuestionRow["status"], answer?: string) => void | Promise<void>;
  /** Выделенная в студии функция — к ней можно привязать свой вопрос. */
  selected?: { id: string; label: string } | null;
  /** Добавить свой вопрос (когда в ходе интервью возник вопрос, которого агент не предложил). */
  onAdd?: (q: { text: string; addressee?: string; scope: string | null; priority: AgentQuestionRow["priority"] }) => void | Promise<void>;
}) {
  const [text, setText] = useState("");
  const [addressee, setAddressee] = useState("");
  const [priority, setPriority] = useState<AgentQuestionRow["priority"]>("important");
  const [withScope, setWithScope] = useState(true);
  const [busy, setBusy] = useState(false);
  useEffect(() => setWithScope(true), [selected?.id]);
  const add = async () => {
    if (text.trim().length < 5 || !onAdd) return;
    setBusy(true);
    try {
      await onAdd({ text: text.trim(), ...(addressee.trim() ? { addressee: addressee.trim() } : {}), scope: withScope && selected ? selected.id : null, priority });
      setText("");
    } finally {
      setBusy(false);
    }
  };
  const [showClosed, setShowClosed] = useState(false);
  const [answering, setAnswering] = useState<string | null>(null);
  const [answer, setAnswer] = useState("");
  const [copied, setCopied] = useState(false);
  const live = questions.filter(isLiveQuestion);
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
        <button disabled={live.length === 0} onClick={() => void copy()} title="Список для интервью: по функциям, с адресатами">
          {copied ? "Скопировано" : "Копировать для интервью"}
        </button>
      </div>
      {onAdd && (
        <div className="task-form question-form">
          <textarea
            rows={2}
            value={text}
            placeholder="Свой вопрос к интервью — например, появившийся по ходу разговора"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void add();
            }}
          />
          <div className="task-form-row">
            {selected ? (
              <label className="problems-filter">
                <input type="checkbox" checked={withScope} onChange={(e) => setWithScope(e.target.checked)} /> к функции {selected.label}
              </label>
            ) : (
              <span className="muted">ко всему процессу (выделите функцию — вопрос привяжется к ней)</span>
            )}
            <span className="spacer" />
            <input value={addressee} placeholder="Кого спросить" aria-label="Кого спросить" onChange={(e) => setAddressee(e.target.value)} />
            <select value={priority} aria-label="Важность" onChange={(e) => setPriority(e.target.value as AgentQuestionRow["priority"])}>
              <option value="critical">критично</option>
              <option value="important">важно</option>
              <option value="desirable">желательно</option>
            </select>
            <button className="primary" disabled={busy || text.trim().length < 5} onClick={() => void add()} title="Ctrl+Enter">
              Добавить вопрос
            </button>
          </div>
        </div>
      )}
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
