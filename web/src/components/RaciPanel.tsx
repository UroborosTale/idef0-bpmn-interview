import { useState } from "react";
import { api } from "../api/client";
import type { ProcessLogicModel, SessionRecord } from "../types";

const TYPES: ("R" | "A" | "C" | "I")[] = ["R", "A", "C", "I"];
const TYPE_TITLE: Record<string, string> = { R: "Исполняет (Responsible)", A: "Ответственный (Accountable)", C: "Согласовывает (Consulted)", I: "Уведомляется (Informed)" };

/** ФТ-М1.3: матрица RACI — автопостроение, ручное редактирование, экспорт. */
export default function RaciPanel({ session, onChanged }: { session: SessionRecord; onChanged: () => void }) {
  const model = session.model as ProcessLogicModel;
  const [busy, setBusy] = useState(false);
  const tasks = model.nodes.filter((n) => n.type === "task" || n.type === "subprocess");

  async function withBusy(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  }

  function cellHas(nodeId: string, roleId: string, type: string) {
    return model.raci.some((r) => r.node_id === nodeId && r.role_id === roleId && r.type === type);
  }

  async function toggle(nodeId: string, roleId: string, type: "R" | "A" | "C" | "I") {
    await withBusy(async () => {
      if (cellHas(nodeId, roleId, type)) {
        await api.removeRaciEntry(session.id, nodeId, roleId, type);
      } else {
        await api.addRaciEntry(session.id, nodeId, roleId, type);
      }
      onChanged();
    });
  }

  const raciIssues = session.validation.filter((v) => v.rule.startsWith("raci_"));

  return (
    <div>
      <div className="toolbar">
        <h4 style={{ margin: 0 }}>Матрица RACI</h4>
        <div className="spacer" />
        <button disabled={busy} onClick={() => withBusy(async () => { await api.buildRaci(session.id); onChanged(); })}>
          Построить автоматически
        </button>
        <a href={api.raciExportXlsxUrl(session.id)} target="_blank" rel="noreferrer"><button>Экспорт .xlsx</button></a>
      </div>

      <p className="muted" style={{ fontSize: 12 }}>
        R — исполняет, A — несёт ответственность (ровно один на действие), C — согласовывает, I — уведомляется.
        Кликните по ячейке, чтобы добавить/убрать отметку.
      </p>

      {raciIssues.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          {raciIssues.map((v) => (
            <div key={v.id} className={`validation-item ${v.severity}`}>{v.message}</div>
          ))}
        </div>
      )}

      {model.roles.length === 0 || tasks.length === 0 ? (
        <p className="muted">Нужны роли и действия в модели, чтобы построить матрицу.</p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="mono" style={{ fontSize: 12, borderCollapse: "collapse", minWidth: "100%" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", padding: 6, position: "sticky", left: 0, background: "#fff" }}>Действие</th>
                {model.roles.map((r) => (
                  <th key={r.id} style={{ padding: 6, minWidth: 110 }}>{r.name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tasks.map((n) => (
                <tr key={n.id} style={{ borderTop: "1px solid #e5e7eb" }}>
                  <td style={{ padding: 6, position: "sticky", left: 0, background: "#fff", maxWidth: 220 }}>{n.name}</td>
                  {model.roles.map((r) => (
                    <td key={r.id} style={{ padding: 4, textAlign: "center" }}>
                      <div style={{ display: "flex", gap: 3, justifyContent: "center" }}>
                        {TYPES.map((t) => (
                          <button
                            key={t}
                            title={TYPE_TITLE[t]}
                            disabled={busy}
                            onClick={() => toggle(n.id, r.id, t)}
                            style={{
                              width: 20,
                              height: 20,
                              padding: 0,
                              fontSize: 10,
                              background: cellHas(n.id, r.id, t) ? "#2A57A3" : "#f1f5f9",
                              color: cellHas(n.id, r.id, t) ? "#fff" : "#64748b",
                              border: "1px solid #cbd5e1",
                              borderRadius: 3,
                            }}
                          >
                            {t}
                          </button>
                        ))}
                      </div>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
