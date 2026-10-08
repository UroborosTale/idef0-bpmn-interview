import { customAlphabet } from "nanoid";
import { db } from "./db.js";

const shortId = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 8);

/**
 * Вопросы к следующему интервью. Их готовит агент-интервьюер (MCP add_questions), а решает судьбу аналитик: спросил,
 * получил ответ или снял вопрос. Модель вопросы не меняют; ответ в модель вносит моделист по новым фрагментам интервью.
 */

db.exec(`CREATE TABLE IF NOT EXISTS agent_questions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  text TEXT NOT NULL,
  addressee TEXT,
  scope_node_id TEXT,
  reason TEXT,
  priority TEXT NOT NULL DEFAULT 'important',
  status TEXT NOT NULL DEFAULT 'open',
  answer TEXT,
  fragment_id TEXT,
  agent TEXT NOT NULL,
  task_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_questions_session ON agent_questions(session_id, status)`);

export type QuestionStatus = "open" | "asked" | "answered" | "dismissed";
export type QuestionPriority = "critical" | "important" | "desirable";
export const QUESTION_STATUSES: QuestionStatus[] = ["open", "asked", "answered", "dismissed"];

export interface AgentQuestion {
  id: string;
  sessionId: string;
  text: string;
  /** Кому адресовать на интервью: должность, которая знает ответ. */
  addressee: string | null;
  /** Функция модели (id узла), к которой относится вопрос; null — к процессу в целом. */
  scopeNodeId: string | null;
  /** Зачем: какое замечание или пробел снимет ответ. */
  reason: string | null;
  priority: QuestionPriority;
  status: QuestionStatus;
  answer: string | null;
  /** Фрагмент интервью, где прозвучал ответ. */
  fragmentId: string | null;
  agent: string;
  taskId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  id: string;
  session_id: string;
  text: string;
  addressee: string | null;
  scope_node_id: string | null;
  reason: string | null;
  priority: string;
  status: string;
  answer: string | null;
  fragment_id: string | null;
  agent: string;
  task_id: string | null;
  created_at: string;
  updated_at: string;
}

const fromRow = (r: Row): AgentQuestion => ({
  id: r.id,
  sessionId: r.session_id,
  text: r.text,
  addressee: r.addressee,
  scopeNodeId: r.scope_node_id,
  reason: r.reason,
  priority: r.priority as QuestionPriority,
  status: r.status as QuestionStatus,
  answer: r.answer,
  fragmentId: r.fragment_id,
  agent: r.agent,
  taskId: r.task_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** Для поиска повторов: без регистра, знаков препинания и лишних пробелов. */
export const normalizeQuestion = (text: string): string =>
  text
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

export function getQuestion(id: string): AgentQuestion | null {
  const row = db.prepare(`SELECT * FROM agent_questions WHERE id = ?`).get(id) as Row | undefined;
  return row ? fromRow(row) : null;
}

const RANK: Record<QuestionPriority, number> = { critical: 0, important: 1, desirable: 2 };

/** Вопросы сессии: ждущие ответа раньше закрытых, внутри — по важности и порядку добавления. */
export function listQuestions(sessionId: string, status?: QuestionStatus): AgentQuestion[] {
  const rows = (status
    ? db.prepare(`SELECT * FROM agent_questions WHERE session_id = ? AND status = ? ORDER BY created_at, rowid`).all(sessionId, status)
    : db.prepare(`SELECT * FROM agent_questions WHERE session_id = ? ORDER BY created_at, rowid`).all(sessionId)) as Row[];
  const live = (q: AgentQuestion) => (q.status === "open" || q.status === "asked" ? 0 : 1);
  return rows
    .map(fromRow)
    .sort((a, b) => live(a) - live(b) || RANK[a.priority] - RANK[b.priority]);
}

/** Создаёт вопрос; если такой уже есть среди не снятых — возвращает его (duplicate), не плодя повторов. */
export function addQuestion(input: {
  sessionId: string;
  text: string;
  addressee?: string | null;
  scopeNodeId?: string | null;
  reason?: string | null;
  priority: QuestionPriority;
  agent: string;
  taskId?: string | null;
}): { question: AgentQuestion; duplicate: boolean } {
  const key = normalizeQuestion(input.text);
  const same = listQuestions(input.sessionId).find((q) => q.status !== "dismissed" && normalizeQuestion(q.text) === key);
  if (same) return { question: same, duplicate: true };
  const id = `q_${shortId()}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO agent_questions (id, session_id, text, addressee, scope_node_id, reason, priority, status, agent, task_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`
  ).run(id, input.sessionId, input.text, input.addressee ?? null, input.scopeNodeId ?? null, input.reason ?? null, input.priority, input.agent, input.taskId ?? null, now, now);
  return { question: getQuestion(id)!, duplicate: false };
}

/** Решение аналитика: задан на интервью, получен ответ, снят. Ответ и фрагмент имеют смысл только для «answered». */
export function setQuestionStatus(id: string, status: QuestionStatus, extra: { answer?: string | null; fragmentId?: string | null } = {}): AgentQuestion | null {
  const answered = status === "answered";
  const res = db
    .prepare(`UPDATE agent_questions SET status = ?, answer = ?, fragment_id = ?, updated_at = ? WHERE id = ?`)
    .run(status, answered ? extra.answer?.trim() || null : null, answered ? extra.fragmentId ?? null : null, new Date().toISOString(), id);
  return res.changes > 0 ? getQuestion(id) : null;
}
