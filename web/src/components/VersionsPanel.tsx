import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { SessionRecord, VersionListItem } from "../types";

/** М7.1: история версий модели — снимок, утверждение (мажорная версия), откат, сравнение. */
export default function VersionsPanel({ session, onChanged }: { session: SessionRecord; onChanged: () => void }) {
  const [versions, setVersions] = useState<VersionListItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [a, setA] = useState<number | "">("");
  const [b, setB] = useState<number | "">("");
  const [diff, setDiff] = useState<any>(null);
  const id = session.id;

  async function reload() {
    setVersions(await api.listVersions(id));
  }

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, session.updatedAt]);

  async function withBusy(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  }

  const currentStatus = session.model?.process.status;
  const currentVersion = session.model?.process.version;

  return (
    <div>
      <h4>Версии модели</h4>
      <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
        Текущая версия: <strong>v{currentVersion ?? "—"}</strong>
        {currentStatus && <span className={`pill status-${currentStatus}`} style={{ marginLeft: 8 }}>{currentStatus}</span>}
        . Каждое сохранение (правка, запуск конвейера, ход интервью) создаёт минорную версию автоматически.
      </div>

      <div className="chat-input-row">
        <input placeholder="Примечание к снимку версии" value={note} onChange={(e) => setNote(e.target.value)} />
        <button
          disabled={!session.model || busy}
          onClick={() => withBusy(async () => { await api.addVersion(id, note || "снимок версии"); setNote(""); onChanged(); await reload(); })}
        >
          Снимок
        </button>
        <button
          disabled={!session.model || busy}
          title="Присваивает мажорную версию и статус «утверждено»"
          onClick={() => withBusy(async () => { await api.approveVersion(id, note || "Утверждено"); setNote(""); onChanged(); await reload(); })}
        >
          Утвердить
        </button>
      </div>

      {versions.length === 0 && <p className="muted">Снимков версий пока нет.</p>}

      {versions.length > 0 && (
        <>
          <table className="mono" style={{ width: "100%", fontSize: 12, marginTop: 10, borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ textAlign: "left" }}>
                <th>Версия</th>
                <th>Дата</th>
                <th>Автор</th>
                <th>Примечание</th>
                <th>Узлы/связи</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {[...versions].reverse().map((v) => (
                <tr key={v.seq} style={{ borderTop: "1px solid #e5e7eb" }}>
                  <td>
                    v{v.version} {v.major && <span className="badge-hyp" title="Мажорная версия (утверждение)">MAJOR</span>}
                  </td>
                  <td>{new Date(v.ts).toLocaleString("ru-RU")}</td>
                  <td>{v.author}</td>
                  <td>{v.note}</td>
                  <td>{v.nodeCount}/{v.flowCount}</td>
                  <td>
                    <button
                      disabled={busy}
                      onClick={() => withBusy(async () => {
                        if (!confirm(`Откатить модель к версии v${v.version}? Будет создан новый снимок, история не удаляется.`)) return;
                        await api.rollbackVersion(id, v.seq);
                        onChanged();
                        await reload();
                      })}
                    >
                      Откатить
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="toolbar" style={{ marginTop: 14 }}>
            <select value={a} onChange={(e) => setA(Number(e.target.value))}>
              <option value="">версия A</option>
              {versions.map((v) => <option key={v.seq} value={v.seq}>v{v.version} ({v.ts.slice(0, 16)})</option>)}
            </select>
            <select value={b} onChange={(e) => setB(Number(e.target.value))}>
              <option value="">версия B</option>
              {versions.map((v) => <option key={v.seq} value={v.seq}>v{v.version} ({v.ts.slice(0, 16)})</option>)}
            </select>
            <button disabled={a === "" || b === ""} onClick={async () => setDiff(await api.diffVersions(id, a, b))}>
              Сравнить
            </button>
          </div>

          {diff && <DiffView diff={diff.diff} from={diff.from} to={diff.to} />}
        </>
      )}
    </div>
  );
}

function DiffView({ diff, from, to }: { diff: any; from: { version: string }; to: { version: string } }) {
  const sections: { key: string; label: string }[] = [
    { key: "nodes", label: "Действия" },
    { key: "flows", label: "Потоки" },
    { key: "roles", label: "Роли" },
    { key: "systems", label: "Системы" },
    { key: "data", label: "Данные/документы" },
    { key: "controls", label: "Регламенты" },
    { key: "kpi", label: "KPI" },
    { key: "raci", label: "RACI" },
  ];
  return (
    <div style={{ marginTop: 12 }}>
      <h5>
        Сравнение v{from.version} → v{to.version}
      </h5>
      {diff.process && (
        <div className="validation-item warning" style={{ marginBottom: 8 }}>
          Изменены атрибуты процесса (цель/триггер/статус/владелец и т.п.)
        </div>
      )}
      {sections.map(({ key, label }) => {
        const d = diff[key];
        if (!d) return null;
        const hasChanges = d.added.length || d.removed.length || d.changed.length;
        if (!hasChanges) return null;
        return (
          <div key={key} style={{ marginBottom: 10 }}>
            <div style={{ fontWeight: 600, fontSize: 13 }}>{label}</div>
            {d.added.length > 0 && (
              <div className="mono" style={{ fontSize: 12, color: "#2C7A57" }}>
                + добавлено ({d.added.length}): {d.added.map((x: any) => x.name ?? x.id).join(", ")}
              </div>
            )}
            {d.removed.length > 0 && (
              <div className="mono" style={{ fontSize: 12, color: "#AD4130" }}>
                − удалено ({d.removed.length}): {d.removed.map((x: any) => x.name ?? x.id).join(", ")}
              </div>
            )}
            {d.changed.length > 0 && (
              <div className="mono" style={{ fontSize: 12, color: "#B87317" }}>
                ~ изменено ({d.changed.length}): {d.changed.map((c: any) => c.after?.name ?? c.id).join(", ")}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
