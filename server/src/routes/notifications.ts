import { Router } from "express";
import { db } from "../db.js";
import { validateWebhookUrl } from "../util/webhook.js";

export const notificationsRouter = Router();

interface NotificationRow {
  id: string;
  session_id: string;
  recipient_kind: string;
  recipient_label: string;
  recipient_contact: string | null;
  channel: string;
  message: string;
  diff_link: string | null;
  is_read: number;
  created_at: string;
}

/** ФТ-М7.4.2: канал "уведомления в системе" — список для простого информационного центра. */
notificationsRouter.get("/notifications", (req, res) => {
  const { session_id, unread } = req.query as { session_id?: string; unread?: string };
  const clauses: string[] = [];
  const params: any[] = [];
  if (session_id) {
    clauses.push("session_id = ?");
    params.push(session_id);
  }
  if (unread === "1") clauses.push("is_read = 0");
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db.prepare(`SELECT * FROM notifications ${where} ORDER BY created_at DESC LIMIT 200`).all(...params) as NotificationRow[];
  res.json(rows);
});

notificationsRouter.post("/notifications/:id/read", (req, res) => {
  db.prepare(`UPDATE notifications SET is_read = 1 WHERE id = ?`).run(req.params.id);
  res.status(204).end();
});

notificationsRouter.get("/sessions/:id/notification-webhook", (req, res) => {
  const row = db.prepare(`SELECT webhook_url FROM notification_webhooks WHERE session_id = ?`).get(req.params.id) as { webhook_url: string } | undefined;
  res.json({ webhook_url: row?.webhook_url ?? null });
});

notificationsRouter.put("/sessions/:id/notification-webhook", (req, res) => {
  const { webhook_url } = req.body as { webhook_url: string };
  if (!webhook_url) {
    res.status(400).json({ error: "webhook_url is required" });
    return;
  }
  const check = validateWebhookUrl(webhook_url);
  if (!check.ok) {
    res.status(400).json({ error: check.error });
    return;
  }
  db.prepare(
    `INSERT INTO notification_webhooks (session_id, webhook_url) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET webhook_url = excluded.webhook_url`
  ).run(req.params.id, webhook_url);
  res.json({ webhook_url });
});
