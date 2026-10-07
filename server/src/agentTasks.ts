import { customAlphabet } from "nanoid";
import { db } from "./db.js";

// идентификаторы без «-» и «_»: их удобно передавать агентам, в командной строке и искать регулярными выражениями
const shortId = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 8);

/**
 * Задания аналитика агенту. Аналитик ставит задание в студии («разбей операцию B002.01.02 на шаги»), агент (Cline)
 * забирает его через MCP, готовит предложения и отмечает задание выполненным. Связь не требует постоянного соединения:
 * задания ждут, пока агент их возьмёт.
 */

db.exec(`CREATE TABLE IF NOT EXISTS agent_tasks (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  text TEXT NOT NULL,
  scope_node_id TEXT,
  agent TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  taken_by TEXT,
  taken_at TEXT,
  result_note TEXT,
  done_at TEXT
)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_tasks_session ON agent_tasks(session_id, status)`);

export type TaskStatus = "open" | "taken" | "done" | "cancelled";

export interface AgentTask {
  id: string;
  sessionId: string;
  text: string;
  /** Функция модели, к которой относится задание (id узла), или null — к процессу в целом. */
  scopeNodeId: string | null;
  /** Роль агента, которой адресовано задание (необязательно). */
  agent: string | null;
  status: TaskStatus;
  createdBy: string;
  createdAt: string;
  takenBy: string | null;
  takenAt: string | null;
  resultNote: string | null;
  doneAt: string | null;
}

interface Row {
  id: string;
  session_id: string;
  text: string;
  scope_node_id: string | null;
  agent: string | null;
  status: string;
  created_by: string;
  created_at: string;
  taken_by: string | null;
  taken_at: string | null;
  result_note: string | null;
  done_at: string | null;
}

const fromRow = (r: Row): AgentTask => ({
  id: r.id,
  sessionId: r.session_id,
  text: r.text,
  scopeNodeId: r.scope_node_id,
  agent: r.agent,
  status: r.status as TaskStatus,
  createdBy: r.created_by,
  createdAt: r.created_at,
  takenBy: r.taken_by,
  takenAt: r.taken_at,
  resultNote: r.result_note,
  doneAt: r.done_at,
});

export function createTask(input: { sessionId: string; text: string; scopeNodeId?: string | null; agent?: string | null; createdBy: string }): AgentTask {
  const id = `task_${shortId()}`;
  db.prepare(`INSERT INTO agent_tasks (id, session_id, text, scope_node_id, agent, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`).run(
    id,
    input.sessionId,
    input.text,
    input.scopeNodeId ?? null,
    input.agent ?? null,
    input.createdBy,
    new Date().toISOString()
  );
  return getTask(id)!;
}

export function getTask(id: string): AgentTask | null {
  const row = db.prepare(`SELECT * FROM agent_tasks WHERE id = ?`).get(id) as Row | undefined;
  return row ? fromRow(row) : null;
}

/** Задания сессии: сначала ожидающие и взятые в работу, затем завершённые; внутри группы — старые раньше. */
export function listTasks(sessionId: string, status?: TaskStatus): AgentTask[] {
  const rows = (status
    ? db.prepare(`SELECT * FROM agent_tasks WHERE session_id = ? AND status = ? ORDER BY created_at`).all(sessionId, status)
    : db.prepare(`SELECT * FROM agent_tasks WHERE session_id = ? ORDER BY created_at`).all(sessionId)) as Row[];
  const tasks = rows.map(fromRow);
  const active = (t: AgentTask) => (t.status === "open" || t.status === "taken" ? 0 : 1);
  return tasks.sort((a, b) => active(a) - active(b));
}

/** Агент берёт задание: только ожидающее; два агента не возьмут одно задание. */
export function takeTask(id: string, agent: string): AgentTask | null {
  const res = db.prepare(`UPDATE agent_tasks SET status = 'taken', taken_by = ?, taken_at = ? WHERE id = ? AND status = 'open'`).run(agent, new Date().toISOString(), id);
  return res.changes > 0 ? getTask(id) : null;
}

/** Задание выполнено: взятое в работу (или ожидающее — если агент выполнил его, не беря). */
export function completeTask(id: string, note: string): AgentTask | null {
  const res = db.prepare(`UPDATE agent_tasks SET status = 'done', result_note = ?, done_at = ? WHERE id = ? AND status IN ('open', 'taken')`).run(note.trim() || null, new Date().toISOString(), id);
  return res.changes > 0 ? getTask(id) : null;
}

export function cancelTask(id: string): AgentTask | null {
  const res = db.prepare(`UPDATE agent_tasks SET status = 'cancelled', done_at = ? WHERE id = ? AND status IN ('open', 'taken')`).run(new Date().toISOString(), id);
  return res.changes > 0 ? getTask(id) : null;
}