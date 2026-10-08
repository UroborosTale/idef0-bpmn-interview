import { createHash } from "node:crypto";
import { customAlphabet } from "nanoid";
import { db } from "./db.js";

const shortId = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 8);

/**
 * Отчёты агентов: выводы аналитика, итоги проверок, разборы методолога. В отличие от предложений правок, отчёт модель
 * не меняет — его читают и архивируют. Выводы хранятся структурой, чтобы их можно было отсортировать и показать таблицей.
 */

db.exec(`CREATE TABLE IF NOT EXISTS agent_reports (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'analysis',
  title TEXT NOT NULL,
  summary TEXT,
  body TEXT,
  findings TEXT NOT NULL DEFAULT '[]',
  scope_node_id TEXT,
  task_id TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_reports_session ON agent_reports(session_id, status)`);
// отпечаток модели на момент отчёта: по нему видно, что модель с тех пор изменилась; столбец добавлен позже
if (!(db.prepare(`PRAGMA table_info(agent_reports)`).all() as { name: string }[]).some((c) => c.name === "model_hash")) db.exec(`ALTER TABLE agent_reports ADD COLUMN model_hash TEXT`);

/** Отпечаток содержания модели: раскладка диаграмм, ручные маршруты стрелок и номер версии (растёт при каждом сохранении) в него не входят — смысла процесса они не меняют. */
export function modelFingerprint(model: unknown): string | null {
  if (!model) return null;
  const skip = new Set(["layout", "idef0_layout", "route"]);
  const process = (model as { process?: unknown }).process;
  // номер версии процесса растёт при каждом сохранении; одноимённые поля других записей — содержание и в отпечаток входят
  return createHash("sha1")
    .update(JSON.stringify(model, function (this: unknown, k, v) { return skip.has(k) || (k === "version" && this === process) ? undefined : v; }))
    .digest("hex")
    .slice(0, 16);
}

export type ReportKind = "analysis" | "review" | "methodology" | "other";
export type ReportStatus = "new" | "read" | "archived";
export type Level = "high" | "medium" | "low";
export const REPORT_KINDS: ReportKind[] = ["analysis", "review", "methodology", "other"];
export const REPORT_STATUSES: ReportStatus[] = ["new", "read", "archived"];

/** Один вывод отчёта (формат — в workflow аналитика: что, где, основание, влияние, уверенность, рекомендация). */
export interface Finding {
  what: string;
  where?: string;
  basis?: string;
  impact: Level;
  confidence: Level;
  recommendation?: string;
}

export interface AgentReport {
  id: string;
  sessionId: string;
  agent: string;
  kind: ReportKind;
  title: string;
  summary: string | null;
  body: string | null;
  findings: Finding[];
  scopeNodeId: string | null;
  taskId: string | null;
  status: ReportStatus;
  /** Отпечаток модели на момент отчёта (modelFingerprint); null — модели тогда не было. */
  modelHash: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  id: string;
  session_id: string;
  agent: string;
  kind: string;
  title: string;
  summary: string | null;
  body: string | null;
  findings: string;
  scope_node_id: string | null;
  task_id: string | null;
  status: string;
  model_hash: string | null;
  created_at: string;
  updated_at: string;
}

const parseFindings = (s: string): Finding[] => {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? (v as Finding[]) : [];
  } catch {
    return [];
  }
};

const fromRow = (r: Row): AgentReport => ({
  id: r.id,
  sessionId: r.session_id,
  agent: r.agent,
  kind: r.kind as ReportKind,
  title: r.title,
  summary: r.summary,
  body: r.body,
  findings: parseFindings(r.findings),
  scopeNodeId: r.scope_node_id,
  taskId: r.task_id,
  status: r.status as ReportStatus,
  modelHash: r.model_hash,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export function addReport(input: {
  sessionId: string;
  agent: string;
  kind: ReportKind;
  title: string;
  summary?: string | null;
  body?: string | null;
  findings: Finding[];
  scopeNodeId?: string | null;
  taskId?: string | null;
  modelHash?: string | null;
}): AgentReport {
  const id = `rep_${shortId()}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO agent_reports (id, session_id, agent, kind, title, summary, body, findings, scope_node_id, task_id, status, model_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?)`
  ).run(id, input.sessionId, input.agent, input.kind, input.title, input.summary || null, input.body || null, JSON.stringify(input.findings), input.scopeNodeId ?? null, input.taskId ?? null, input.modelHash ?? null, now, now);
  return getReport(id)!;
}

export function getReport(id: string): AgentReport | null {
  const row = db.prepare(`SELECT * FROM agent_reports WHERE id = ?`).get(id) as Row | undefined;
  return row ? fromRow(row) : null;
}

/** Отчёты сессии: новые раньше прочитанных, архивные в конце; внутри группы — свежие сверху. */
export function listReports(sessionId: string, status?: ReportStatus): AgentReport[] {
  const rows = (status
    ? db.prepare(`SELECT * FROM agent_reports WHERE session_id = ? AND status = ? ORDER BY created_at DESC, rowid DESC`).all(sessionId, status)
    : db.prepare(`SELECT * FROM agent_reports WHERE session_id = ? ORDER BY created_at DESC, rowid DESC`).all(sessionId)) as Row[];
  const rank = (r: AgentReport) => REPORT_STATUSES.indexOf(r.status);
  return rows.map(fromRow).sort((a, b) => rank(a) - rank(b));
}

export function setReportStatus(id: string, status: ReportStatus): AgentReport | null {
  const res = db.prepare(`UPDATE agent_reports SET status = ?, updated_at = ? WHERE id = ?`).run(status, new Date().toISOString(), id);
  return res.changes > 0 ? getReport(id) : null;
}

/** Отчёт с признаком «модель с тех пор изменилась» (stale) — для выдачи студии и агентам. */
export const withStale = <T extends AgentReport>(report: T, model: unknown): T & { stale: boolean } => ({
  ...report,
  stale: !!report.modelHash && report.modelHash !== modelFingerprint(model),
});