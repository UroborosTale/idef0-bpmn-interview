import { customAlphabet } from "nanoid";
import { db } from "./db.js";

const shortId = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 10);

/**
 * Уведомление аналитику о работе агента: новые предложения, вопросы, отчёты. Попадает в тот же центр «Уведомления», что и
 * уведомления об утверждении изменений, и считается в счётчике непрочитанных в шапке. Сбой записи работе агента не мешает.
 */
export function notifyAnalyst(sessionId: string, processName: string, message: string): void {
  try {
    db.prepare(
      `INSERT INTO notifications (id, session_id, recipient_kind, recipient_label, recipient_contact, channel, message, diff_link, is_read, created_at) VALUES (?, ?, 'analyst', ?, NULL, 'system', ?, ?, 0, ?)`
    ).run(`notif_${shortId()}`, sessionId, `Аналитик · ${processName}`, message, `/s/${sessionId}?tab=studio`, new Date().toISOString());
  } catch {
    /* уведомление — удобство, а не часть работы агента */
  }
}