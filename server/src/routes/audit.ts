import { Router } from "express";
import { db } from "../db.js";

export const auditRouter = Router();

interface AuditRow {
  id: number;
  session_id: string | null;
  actor: string;
  action: string;
  details_json: string | null;
  ts: string;
}

/** ФТ-М6.4: журнал аудита — все зафиксированные системой действия (кто/что/когда), с фильтрами. */
auditRouter.get("/audit-log", (req, res) => {
  const { session_id, actor, action, limit } = req.query as { session_id?: string; actor?: string; action?: string; limit?: string };
  const clauses: string[] = [];
  const params: any[] = [];
  if (session_id) {
    clauses.push("session_id = ?");
    params.push(session_id);
  }
  if (actor) {
    clauses.push("actor = ?");
    params.push(actor);
  }
  if (action) {
    clauses.push("action LIKE ?");
    params.push(`%${action}%`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const lim = Math.min(500, Math.max(1, Number(limit) || 200));
  const rows = db.prepare(`SELECT * FROM audit_log ${where} ORDER BY id DESC LIMIT ?`).all(...params, lim) as AuditRow[];
  res.json(
    rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      actor: r.actor,
      action: r.action,
      details: r.details_json ? JSON.parse(r.details_json) : null,
      ts: r.ts,
    }))
  );
});
