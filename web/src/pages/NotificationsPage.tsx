import { useEffect, useState } from "react";
import { api, type NotificationRow } from "../api/client";

/** ФТ-М7.4.2: канал "уведомления в системе" — простой информационный центр по всем сессиям. */
export default function NotificationsPage() {
  const [rows, setRows] = useState<NotificationRow[]>([]);
  const [onlyUnread, setOnlyUnread] = useState(false);

  async function reload() {
    setRows(await api.listNotifications(onlyUnread ? { unread: true } : undefined));
  }
  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onlyUnread]);

  return (
    <div className="card" style={{ margin: 16 }}>
      <div className="toolbar">
        <h2 style={{ margin: 0 }}>Уведомления</h2>
        <div className="spacer" />
        <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12 }}>
          <input type="checkbox" checked={onlyUnread} onChange={(e) => setOnlyUnread(e.target.checked)} />
          Только непрочитанные
        </label>
      </div>
      <p className="muted" style={{ fontSize: 12 }}>
        Создаются автоматически при финальном утверждении изменений (ФТ-М7.4): владельцам смежных процессов и по затронутым ролям.
      </p>
      {rows.length === 0 && <p className="muted">Уведомлений нет.</p>}
      {rows.map((n) => (
        <div key={n.id} className={`validation-item ${n.is_read ? "" : "warning"}`} style={{ marginBottom: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
            <div>
              <strong>{n.recipient_label}</strong>
              <div style={{ fontSize: 13, marginTop: 2 }}>{n.message}</div>
              <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>{new Date(n.created_at).toLocaleString("ru-RU")}</div>
            </div>
            {!n.is_read && (
              <button onClick={async () => { await api.markNotificationRead(n.id); await reload(); }}>Прочитано</button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
