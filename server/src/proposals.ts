import { nanoid } from "nanoid";
import { db } from "./db.js";
import type { ModelPatch } from "./shared/patch.js";

/**
 * Предложения правок от агентов. Агент только предлагает; человек применяет предложение в студии (правки попадают в его
 * черновик) или отклоняет его с причиной. Статус и причина доступны агенту — так он учится на отказах.
 */

db.exec(`CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  title TEXT NOT NULL,
  rationale TEXT NOT NULL DEFAULT '',
  patch_json TEXT NOT NULL,
  delta_json TEXT NOT NULL DEFAULT '{}',
  base_updated_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  reason TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT
)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_proposals_session ON proposals(session_id, status)`);
// предложение, подготовленное по заданию аналитика (agentTasks.ts); столбец добавлен позже — дополняем уже созданные базы
if (!(db.prepare(`PRAGMA table_info(proposals)`).all() as { name: string }[]).some((c) => c.name === "task_id")) db.exec(`ALTER TABLE proposals ADD COLUMN task_id TEXT`);

export type ProposalStatus = "pending" | "applied" | "rejected";

/** Как предложение меняет проверки модели на момент его создания. */
export interface ProposalDelta {
  introduced: { severity: string; message: string }[];
  resolved: { severity: string; message: string }[];
}

export interface Proposal {
  id: string;
  sessionId: string;
  agent: string;
  title: string;
  rationale: string;
  patch: ModelPatch;
  delta: ProposalDelta;
  /** updatedAt сессии, к модели которой агент готовил предложение. */
  baseUpdatedAt: string;
  status: ProposalStatus;
  reason: string | null;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  /** Задание аналитика, по которому подготовлено предложение. */
  taskId: string | null;
}

interface Row {
  id: string;
  session_id: string;
  agent: string;
  title: string;
  rationale: string;
  patch_json: string;
  delta_json: string;
  base_updated_at: string;
  status: string;
  reason: string | null;
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  task_id: string | null;
}

const fromRow = (r: Row): Proposal => ({
  id: r.id,
  sessionId: r.session_id,
  agent: r.agent,
  title: r.title,
  rationale: r.rationale,
  patch: JSON.parse(r.patch_json) as ModelPatch,
  delta: JSON.parse(r.delta_json) as ProposalDelta,
  baseUpdatedAt: r.base_updated_at,
  status: r.status as ProposalStatus,
  reason: r.reason,
  createdAt: r.created_at,
  resolvedAt: r.resolved_at,
  resolvedBy: r.resolved_by,
  taskId: r.task_id,
});

export function createProposal(input: { sessionId: string; agent: string; title: string; rationale: string; patch: ModelPatch; delta: ProposalDelta; baseUpdatedAt: string; taskId?: string | null }): Proposal {
  const id = `prop_${nanoid(8)}`;
  db.prepare(
    `INSERT INTO proposals (id, session_id, agent, title, rationale, patch_json, delta_json, base_updated_at, status, created_at, task_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
  ).run(id, input.sessionId, input.agent, input.title, input.rationale, JSON.stringify(input.patch), JSON.stringify(input.delta), input.baseUpdatedAt, new Date().toISOString(), input.taskId ?? null);
  return getProposal(id)!;
}

export function getProposal(id: string): Proposal | null {
  const row = db.prepare(`SELECT * FROM proposals WHERE id = ?`).get(id) as Row | undefined;
  return row ? fromRow(row) : null;
}

export function listProposals(sessionId: string, status?: ProposalStatus): Proposal[] {
  const rows = (status
    ? db.prepare(`SELECT * FROM proposals WHERE session_id = ? AND status = ? ORDER BY created_at DESC`).all(sessionId, status)
    : db.prepare(`SELECT * FROM proposals WHERE session_id = ? ORDER BY created_at DESC`).all(sessionId)) as Row[];
  return rows.map(fromRow);
}

/** Отметить решение человека. Решённое предложение не меняется: повторное решение — ошибка вызывающего кода. */
export function resolveProposal(id: string, status: "applied" | "rejected", by: string, reason?: string): Proposal | null {
  const res = db.prepare(`UPDATE proposals SET status = ?, reason = ?, resolved_at = ?, resolved_by = ? WHERE id = ? AND status = 'pending'`).run(status, reason?.trim() || null, new Date().toISOString(), by, id);
  return res.changes > 0 ? getProposal(id) : null;
}
