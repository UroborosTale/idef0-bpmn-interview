import { useEffect, useState } from "react";
import { api, type AuditLogRow } from "../api/client";

/** ФТ-М6.4: журнал аудита — все зафиксированные системой действия, с фильтрами. */
export default function AuditLogPage() {
  const [rows, setRows] = useState<AuditLogRow[]>([]);
  const [sessionId, setSessionId] = useState("");
  const [actor, setActor] = useState("");
  const [action, setAction] = useState("");

  async function reload() {
    setRows(await api.listAuditLog({ session_id: sessionId || undefined, actor: actor || undefined, action: action || undefined }));
  }

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, actor, action]);

  return (
    <div className="card" style={{ margin: 16 }}>
      <div className="toolbar">
        <h2 style={{ margin: 0 }}>Журнал аудита</h2>
      </div>
      <p className="muted" style={{ fontSize: 12 }}>Полная история действий в системе — кто, что и когда сделал (последние {rows.length} записей).</p>

      <div className="toolbar" style={{ marginTop: 10 }}>
        <input placeholder="ID сессии" value={sessionId} onChange={(e) => setSessionId(e.target.value)} style={{ width: 220 }} />
        <input placeholder="Инициатор (actor)" value={actor} onChange={(e) => setActor(e.target.value)} style={{ width: 140 }} />
        <input placeholder="Действие содержит…" value={action} onChange={(e) => setAction(e.target.value)} style={{ width: 200 }} />
      </div>

      <table className="mono" style={{ width: "100%", fontSize: 12, marginTop: 12, borderCollapse: "collapse" }}>
        <thead><tr style={{ textAlign: "left" }}><th>Время</th><th>Сессия</th><th>Инициатор</th><th>Действие</th><th>Детали</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} style={{ borderTop: "1px solid #e5e7eb" }}>
              <td style={{ whiteSpace: "nowrap" }}>{new Date(r.ts).toLocaleString("ru-RU")}</td>
              <td className="muted" style={{ whiteSpace: "nowrap" }}>{r.sessionId ?? "—"}</td>
              <td>{r.actor}</td>
              <td>{r.action}</td>
              <td className="muted">{r.details ? JSON.stringify(r.details) : ""}</td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={5} className="muted" style={{ padding: 12 }}>Записей не найдено.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
