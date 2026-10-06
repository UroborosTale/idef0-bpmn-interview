import { useEffect, useState } from "react";
import { api, type ChecklistRuleRow } from "../api/client";

/** ФТ-М6.2.2: настройка состава правил чек-листа процессного подхода (включить/выключить). */
export default function ChecklistRulesPage() {
  const [rows, setRows] = useState<ChecklistRuleRow[]>([]);

  async function reload() {
    setRows(await api.listChecklistRules());
  }

  useEffect(() => {
    reload();
  }, []);

  return (
    <div className="card" style={{ margin: 16 }}>
      <div className="toolbar">
        <h2 style={{ margin: 0 }}>Чек-лист: правила</h2>
      </div>
      <p className="muted" style={{ fontSize: 12 }}>
        Базовые правила проверки процессного подхода. Отключённое правило не учитывается в результате чек-листа сессии и в проценте соответствия.
      </p>

      <table className="mono" style={{ width: "100%", fontSize: 13, marginTop: 12, borderCollapse: "collapse" }}>
        <thead><tr style={{ textAlign: "left" }}><th>Правило</th><th>Код</th><th>Включено</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} style={{ borderTop: "1px solid #e5e7eb" }}>
              <td>{r.label}</td>
              <td className="muted">{r.code}</td>
              <td>
                <input
                  type="checkbox"
                  checked={!!r.enabled}
                  onChange={async (e) => {
                    await api.setChecklistRuleEnabled(r.id, e.target.checked);
                    reload();
                  }}
                />
              </td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={3} className="muted" style={{ padding: 12 }}>Правил нет.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
