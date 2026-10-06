import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { SessionListItem } from "../types";

const STATUS_LABEL: Record<string, string> = {
  draft: "Черновик",
  processing: "Обработка…",
  ready: "Готово",
  interviewing: "Интервью идёт",
  completed: "Завершено",
};

export default function SessionsListPage({ onOpen, onCreateNew }: { onOpen: (id: string) => void; onCreateNew: () => void }) {
  const [items, setItems] = useState<SessionListItem[] | null>(null);

  function reload() {
    api.listSessions().then(setItems);
  }
  useEffect(reload, []);

  async function handleDelete(e: React.MouseEvent, id: string) {
    e.stopPropagation();
    if (!confirm("Удалить сессию безвозвратно?")) return;
    await api.deleteSession(id);
    reload();
  }

  return (
    <div>
      <div className="toolbar">
        <h2 style={{ margin: 0 }}>Сессии моделирования</h2>
        <div className="spacer" />
        <button className="primary" onClick={onCreateNew}>+ Новая сессия</button>
      </div>

      {items === null && <p className="muted">Загрузка…</p>}
      {items && items.length === 0 && (
        <div className="card">
          <p>Пока нет ни одной сессии. Создайте первую — загрузите текст интервью (режим А) или начните диалог с владельцем процесса (режим Б).</p>
          <button className="primary" onClick={onCreateNew}>+ Новая сессия</button>
        </div>
      )}

      <div className="session-list">
        {items?.map((s) => (
          <div key={s.id} className="session-row" onClick={() => onOpen(s.id)}>
            <div>
              <div className="title">{s.title}</div>
              <div className="sub">
                {s.meta.owner ? `Владелец: ${s.meta.owner} · ` : ""}
                {s.meta.modelType} · обновлено {new Date(s.updatedAt).toLocaleString("ru-RU")}
              </div>
            </div>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span className={`pill mode-${s.mode}`}>{s.mode === "B" ? "Интервью" : "Текст"}</span>
              <span className={`pill status-${s.status}`}>{STATUS_LABEL[s.status] ?? s.status}</span>
              {s.gapsOpen > 0 && <span className="pill">{s.gapsOpen} пробел(ов)</span>}
              {s.hasErrors && <span className="pill errors">ошибки валидации</span>}
              {s.diagramsStale && <span className="pill">требует пересборки</span>}
              <button onClick={(e) => handleDelete(e, s.id)}>Удалить</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
