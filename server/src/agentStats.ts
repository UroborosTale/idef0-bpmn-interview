import { db } from "./db.js";

/**
 * Сводка работы агентов по ролям — чтобы настраивать инструкции по реальным запускам: сколько предложений принято и отклонено,
 * почему отклоняют, сколько замечаний проверок предложения вносят и снимают, сколько вопросов и отчётов дала каждая роль.
 * Роли сводятся без учёта регистра и пробелов по краям (агент мог подписаться «Моделист»).
 */

export interface RoleStats {
  role: string;
  proposals: {
    total: number;
    pending: number;
    applied: number;
    rejected: number;
    /** Доля применённых среди решённых (применено / (применено + отклонено)); null — решений ещё нет. */
    acceptance: number | null;
    /** Сколько новых замечаний проверок предложения вносили и сколько снимали (по расчёту на момент отправки). */
    introduced: number;
    resolved: number;
    /** Самые частые причины отказа аналитика. */
    topReasons: { reason: string; count: number }[];
  };
  tasks: { taken: number; done: number; created: number };
  questions: { added: number; asked: number; answered: number; dismissed: number };
  reports: { total: number; unread: number; findings: number; highImpact: number };
}

const key = (s: string) => s.trim().toLowerCase();
const normReason = (s: string) => s.trim().replace(/\s+/g, " ").replace(/[.!\s]+$/, "");

/** Сводка по одной сессии или (sessionId = null) по всем сессиям приложения. Роли — по убыванию числа предложений. */
export function agentStats(sessionId: string | null): { scope: "session" | "all"; roles: RoleStats[] } {
  const where = sessionId ? "WHERE session_id = ?" : "";
  const args = sessionId ? [sessionId] : [];
  const roles = new Map<string, RoleStats>();
  const reasons = new Map<string, Map<string, { reason: string; count: number }>>();
  const of = (name: string): RoleStats => {
    const k = key(name);
    let r = roles.get(k);
    if (!r) {
      r = {
        role: name.trim(),
        proposals: { total: 0, pending: 0, applied: 0, rejected: 0, acceptance: null, introduced: 0, resolved: 0, topReasons: [] },
        tasks: { taken: 0, done: 0, created: 0 },
        questions: { added: 0, asked: 0, answered: 0, dismissed: 0 },
        reports: { total: 0, unread: 0, findings: 0, highImpact: 0 },
      };
      roles.set(k, r);
    }
    return r;
  };

  for (const p of db.prepare(`SELECT agent, status, reason, delta_json FROM proposals ${where}`).all(...args) as { agent: string; status: string; reason: string | null; delta_json: string }[]) {
    const s = of(p.agent).proposals;
    s.total++;
    if (p.status === "pending") s.pending++;
    if (p.status === "applied") s.applied++;
    if (p.status === "rejected") {
      s.rejected++;
      const reason = normReason(p.reason ?? "");
      if (reason) {
        const byRole = reasons.get(key(p.agent)) ?? new Map();
        const prev = byRole.get(reason.toLowerCase());
        byRole.set(reason.toLowerCase(), { reason: prev?.reason ?? reason, count: (prev?.count ?? 0) + 1 });
        reasons.set(key(p.agent), byRole);
      }
    }
    try {
      const d = JSON.parse(p.delta_json) as { introduced?: unknown[]; resolved?: unknown[] };
      s.introduced += d.introduced?.length ?? 0;
      s.resolved += d.resolved?.length ?? 0;
    } catch {
      /* старые записи без расчёта */
    }
  }

  for (const t of db.prepare(`SELECT taken_by, status, created_by FROM agent_tasks ${where}`).all(...args) as { taken_by: string | null; status: string; created_by: string }[]) {
    if (t.taken_by) {
      const s = of(t.taken_by).tasks;
      s.taken++;
      if (t.status === "done") s.done++;
    }
    if (t.created_by.startsWith("agent:")) of(t.created_by.slice(6)).tasks.created++;
  }

  for (const q of db.prepare(`SELECT agent, status FROM agent_questions ${where}`).all(...args) as { agent: string; status: string }[]) {
    if (q.agent.startsWith("user:")) continue; // вопросы аналитика — не работа агента
    const s = of(q.agent).questions;
    s.added++;
    if (q.status === "asked") s.asked++;
    if (q.status === "answered") s.answered++;
    if (q.status === "dismissed") s.dismissed++;
  }

  for (const r of db.prepare(`SELECT agent, status, findings FROM agent_reports ${where}`).all(...args) as { agent: string; status: string; findings: string }[]) {
    const s = of(r.agent).reports;
    s.total++;
    if (r.status === "new") s.unread++;
    try {
      const f = JSON.parse(r.findings) as { impact?: string }[];
      s.findings += f.length;
      s.highImpact += f.filter((x) => x.impact === "high").length;
    } catch {
      /* повреждённые выводы не мешают сводке */
    }
  }

  for (const [k, r] of roles) {
    const p = r.proposals;
    p.acceptance = p.applied + p.rejected > 0 ? p.applied / (p.applied + p.rejected) : null;
    p.topReasons = [...(reasons.get(k)?.values() ?? [])].sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason, "ru")).slice(0, 5);
  }
  const list = [...roles.values()].sort((a, b) => b.proposals.total - a.proposals.total || a.role.localeCompare(b.role, "ru"));
  return { scope: sessionId ? "session" : "all", roles: list };
}