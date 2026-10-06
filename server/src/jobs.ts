import { nanoid } from "nanoid";
import { db } from "./db.js";
import { currentLogin, runWithUser } from "./util/requestContext.js";

/**
 * Фоновые задачи: долгие операции (обработка интервью LLM) выполняются вне HTTP-запроса.
 * Клиент получает id задачи и опрашивает её состояние; прогресс и результат хранятся в SQLite,
 * поэтому видны и после перезагрузки страницы. На сессию — не больше одной активной задачи.
 */

db.exec(`CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  progress_json TEXT,
  result_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`);
db.exec(`CREATE INDEX IF NOT EXISTS jobs_session ON jobs(session_id, created_at)`);

export type JobStatus = "running" | "done" | "failed";

export interface Job {
  id: string;
  sessionId: string | null;
  kind: string;
  status: JobStatus;
  progress: { done: number; total: number; stage?: string } | null;
  result: unknown;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

const toJob = (r: any): Job => ({
  id: r.id,
  sessionId: r.session_id,
  kind: r.kind,
  status: r.status,
  progress: r.progress_json ? JSON.parse(r.progress_json) : null,
  result: r.result_json ? JSON.parse(r.result_json) : null,
  error: r.error,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export const getJob = (id: string): Job | null => {
  const r = db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id);
  return r ? toJob(r) : null;
};

export const activeJob = (sessionId: string): Job | null => {
  const r = db.prepare(`SELECT * FROM jobs WHERE session_id = ? AND status = 'running' ORDER BY created_at DESC LIMIT 1`).get(sessionId);
  return r ? toJob(r) : null;
};

const update = (id: string, patch: { status?: JobStatus; progress?: Job["progress"]; result?: unknown; error?: string | null }) => {
  const cur = getJob(id);
  if (!cur) return;
  db.prepare(`UPDATE jobs SET status = ?, progress_json = ?, result_json = ?, error = ?, updated_at = ? WHERE id = ?`).run(
    patch.status ?? cur.status,
    JSON.stringify(patch.progress !== undefined ? patch.progress : cur.progress),
    patch.result !== undefined ? JSON.stringify(patch.result) : cur.result === null ? null : JSON.stringify(cur.result),
    patch.error !== undefined ? patch.error : cur.error,
    new Date().toISOString(),
    id
  );
};

export class JobConflictError extends Error {}

/**
 * Запускает задачу и сразу возвращает её. work получает функцию отчёта о прогрессе; результат или
 * ошибка записываются в задачу. Пользователь запроса сохраняется для журнала аудита.
 */
export function startJob(sessionId: string | null, kind: string, work: (progress: (p: NonNullable<Job["progress"]>) => void) => Promise<unknown>): Job {
  if (sessionId && activeJob(sessionId)) throw new JobConflictError("для этой сессии уже выполняется обработка — дождитесь её завершения");
  const id = `job_${nanoid(10)}`;
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO jobs (id, session_id, kind, status, created_at, updated_at) VALUES (?, ?, ?, 'running', ?, ?)`).run(id, sessionId, kind, now, now);
  const login = currentLogin();
  const run = () =>
    work((p) => update(id, { progress: p }))
      .then((result) => update(id, { status: "done", result: result ?? null }))
      .catch((e) => {
        console.error(`задача ${kind} ${id} завершилась ошибкой`, e);
        update(id, { status: "failed", error: (e as Error).message });
      });
  setImmediate(() => (login ? runWithUser(login, run) : run()));
  return getJob(id)!;
}

/** При запуске сервера: задачи, оборванные перезапуском, помечаются ошибкой. */
export function failInterruptedJobs(): string[] {
  const rows = db.prepare(`SELECT id, session_id FROM jobs WHERE status = 'running'`).all() as { id: string; session_id: string | null }[];
  for (const r of rows) update(r.id, { status: "failed", error: "сервер был перезапущен во время обработки — запустите её снова" });
  return rows.flatMap((r) => (r.session_id ? [r.session_id] : []));
}
