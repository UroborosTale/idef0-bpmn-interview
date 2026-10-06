import { useEffect, useState } from "react";
import { api, type ChecklistResult } from "../api/client";
import type { SessionRecord } from "../types";

/** ФТ-М6.2.3: результат проверки процесса по чек-листу процессного подхода. */
export default function ChecklistPanel({ session }: { session: SessionRecord }) {
  const [result, setResult] = useState<ChecklistResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getChecklist(session.id).then(setResult).catch((e) => setError((e as Error).message));
  }, [session.id, session.model]);

  return (
    <div>
      <div className="toolbar">
        <h4 style={{ margin: 0 }}>Чек-лист процессного подхода</h4>
      </div>
      <p className="muted" style={{ fontSize: 12 }}>
        Базовая проверка соответствия модели процессному подходу (ISO 9001, п. 4.4). Состав правил настраивается в разделе «Чек-лист: правила».
      </p>

      {error && <div className="validation-item error">{error}</div>}
      {!result ? (
        <p className="muted">Загрузка…</p>
      ) : (
        <>
          <div style={{ fontSize: 28, fontWeight: 600, marginTop: 10 }}>
            {result.compliancePercent}% <span style={{ fontSize: 14, fontWeight: 400 }} className="muted">соответствия</span>
          </div>
          <table className="mono" style={{ width: "100%", fontSize: 13, marginTop: 14, borderCollapse: "collapse" }}>
            <thead><tr style={{ textAlign: "left" }}><th>Правило</th><th>Статус</th><th>Комментарий</th></tr></thead>
            <tbody>
              {result.results.map((r) => (
                <tr key={r.code} style={{ borderTop: "1px solid #e5e7eb" }}>
                  <td>{r.label}</td>
                  <td>{r.passed ? <span style={{ color: "#16a34a" }}>соответствует</span> : <span style={{ color: "#dc2626" }}>несоответствие</span>}</td>
                  <td className="muted">{r.detail}</td>
                </tr>
              ))}
              {result.results.length === 0 && <tr><td colSpan={3} className="muted" style={{ padding: 12 }}>Нет включённых правил.</td></tr>}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
