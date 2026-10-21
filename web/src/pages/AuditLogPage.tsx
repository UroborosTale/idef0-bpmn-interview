import { useEffect, useState } from "react";
import { api, type AuditLogRow } from "../api/client";
import { routePath } from "../router";
import type { SessionListItem } from "../types";

/** Человекочитаемые названия действий журнала (в API они хранятся кодами). */
const ACTION_LABEL: Record<string, string> = {
  session_created: "Создана сессия",
  session_meta_updated: "Изменены реквизиты сессии",
  session_deleted: "Удалена сессия",
  model_edited: "Изменена модель",
  pipeline_run: "Запущена обработка текста",
  blank_session_created: "Создана пустая модель",
  gap_answered: "Ответ на уточнение",
  text_ingested: "Добавлен текст интервью",
  file_uploaded: "Загружен файл интервью",
  verification_paragraph_confirmed: "Подтверждён абзац пересказа",
  registry_process_created: "Создан процесс в реестре",
  registry_process_updated: "Изменён процесс реестра",
  registry_process_deleted: "Удалён процесс реестра",
  registry_imported_from_sessions: "Реестр заполнен из сессий",
  repository_sync: "Синхронизирован объект репозитория",
  repository_merge: "Объединены объекты репозитория",
  mining_log_imported: "Импортирован журнал process mining",
  duplicate_dismissed: "Пара дублей отклонена",
};

const DETAIL_LABEL: Record<string, string> = {
  title: "название",
  mode: "режим",
  name: "название",
  code: "код",
  id: "id",
  gapId: "пробел",
  filename: "файл",
  events: "события",
  cases: "случаи",
  activities: "активности",
  nodes: "шаги",
  provider: "провайдер",
  created: "добавлено",
  updated: "обновлено",
};

function formatDetails(details: unknown): string {
  if (details == null) return "";
  if (typeof details !== "object") return String(details);
  return Object.entries(details as Record<string, unknown>)
    .map(([k, v]) => `${DETAIL_LABEL[k] ?? k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    .join(" · ");
}

/** ФТ-М6.4: журнал аудита — все зафиксированные системой действия, с фильтрами. */
export default function AuditLogPage() {
  const [rows, setRows] = useState<AuditLogRow[]>([]);
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [sessionId, setSessionId] = useState("");
  const [actor, setActor] = useState("");
  const [action, setAction] = useState("");
  const [limit, setLimit] = useState(50);

  async function reload() {
    setRows(await api.listAuditLog({ session_id: sessionId || undefined, actor: actor || undefined, action: action || undefined, limit }));
  }

  useEffect(() => {
    api.listSessions().then(setSessions).catch(() => setSessions([]));
  }, []);

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, actor, action, limit]);

  const titleOf = new Map(sessions.map((s) => [s.id, s.title] as const));

  return (
    <div className="card" style={{ margin: 16 }}>
      <div className="toolbar">
        <h2 style={{ margin: 0 }}>Журнал аудита</h2>
      </div>
      <p className="muted" style={{ fontSize: 12 }}>Полная история действий в системе — кто, что и когда сделал (показаны последние {rows.length} записей).</p>

      <div className="toolbar" style={{ marginTop: 10 }}>
        <input placeholder="ID сессии" value={sessionId} onChange={(e) => setSessionId(e.target.value)} style={{ width: 220 }} />
        <input placeholder="Инициатор (actor)" value={actor} onChange={(e) => setActor(e.target.value)} style={{ width: 140 }} />
        <input placeholder="Действие содержит…" value={action} onChange={(e) => setAction(e.target.value)} style={{ width: 200 }} />
        <div className="spacer" />
        {rows.length >= limit && limit < 500 && <button onClick={() => setLimit((n) => Math.min(500, n + 50))}>Показать ещё 50</button>}
      </div>

      <table style={{ width: "100%", fontSize: 12, marginTop: 12, borderCollapse: "collapse" }}>
        <thead><tr style={{ textAlign: "left" }}><th>Время</th><th>Сессия</th><th>Инициатор</th><th>Действие</th><th>Детали</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} style={{ borderTop: "1px solid #e5e7eb" }}>
              <td style={{ whiteSpace: "nowrap" }}>{new Date(r.ts).toLocaleString("ru-RU")}</td>
              <td style={{ whiteSpace: "nowrap" }}>
                {r.sessionId ? <a href={routePath({ name: "workspace", id: r.sessionId })} title={r.sessionId}>{titleOf.get(r.sessionId) ?? r.sessionId}</a> : <span className="muted">—</span>}
              </td>
              <td>{r.actor}</td>
              <td>{ACTION_LABEL[r.action] ?? r.action}</td>
              <td className="muted">{formatDetails(r.details)}</td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={5} className="muted" style={{ padding: 12 }}>Записей не найдено.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
