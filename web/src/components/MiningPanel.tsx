import { useEffect, useState } from "react";
import { api, type MiningImportResult, type MiningMappingRow, type ConformanceReport } from "../api/client";
import type { SessionRecord } from "../types";

/** ФТ-М4.3: сверка модели с данными — импорт журнала событий, сопоставление, проверка соответствия, подстановка длительностей. */
export default function MiningPanel({ session, onChanged }: { session: SessionRecord; onChanged: () => void }) {
  const [csv, setCsv] = useState("");
  const [imported, setImported] = useState<MiningImportResult | null>(null);
  const [mappings, setMappings] = useState<MiningMappingRow[] | null>(null);
  const [conformance, setConformance] = useState<ConformanceReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const model = session.model!;
  const taskOptions = model.nodes.filter((n) => n.type === "task" || n.type === "subprocess");

  async function reloadMappings() {
    try {
      setMappings(await api.listMiningMappings(session.id));
    } catch {
      setMappings(null);
    }
  }

  useEffect(() => {
    api
      .getMiningLog(session.id)
      .then((log) => setImported({ logId: log.logId, eventCount: log.eventCount, caseCount: log.caseCount, dfg: log.dfg, suggestions: [] }))
      .catch(() => {});
    reloadMappings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id]);

  function onFile(f: File) {
    const reader = new FileReader();
    reader.onload = () => setCsv(String(reader.result ?? ""));
    reader.readAsText(f, "utf-8");
  }

  async function withBusy(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="toolbar">
        <h4 style={{ margin: 0 }}>Сверка с данными (process mining)</h4>
      </div>
      <p className="muted" style={{ fontSize: 12 }}>
        Импорт журнала событий (CSV: case_id, activity, timestamp, resource) — сопоставление активностей с действиями модели,
        проверка соответствия («как описывают» против «как происходит») и подстановка фактических длительностей.
      </p>

      <input type="file" accept=".csv,text/csv" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
      <textarea
        style={{ width: "100%", height: 100, marginTop: 8, fontFamily: "monospace", fontSize: 12 }}
        placeholder={"case_id,activity,timestamp,resource\ncase1,Оформить заявку,2026-01-10T09:00:00Z,Иванов"}
        value={csv}
        onChange={(e) => setCsv(e.target.value)}
      />
      {error && <div className="validation-item error">{error}</div>}
      <div className="toolbar" style={{ marginTop: 8 }}>
        <button
          className="primary"
          disabled={!csv.trim() || busy}
          onClick={() =>
            withBusy(async () => {
              const result = await api.importMiningLog(session.id, csv);
              setImported(result);
              await reloadMappings();
              setConformance(null);
            })
          }
        >
          Импортировать журнал
        </button>
      </div>

      {imported && (
        <div className="form-grid" style={{ marginTop: 14 }}>
          <div><span className="muted">Событий</span><div>{imported.eventCount}</div></div>
          <div><span className="muted">Трасс (case)</span><div>{imported.caseCount}</div></div>
          <div><span className="muted">Активностей</span><div>{imported.dfg?.activities.length ?? "—"}</div></div>
        </div>
      )}

      {mappings && mappings.length > 0 && (
        <>
          <h4 style={{ marginTop: 20 }}>Сопоставление активностей журнала с действиями модели</h4>
          <p className="muted" style={{ fontSize: 12 }}>Предложено автоматически по схожести названий — требует подтверждения.</p>
          <table className="mono" style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
            <thead><tr style={{ textAlign: "left" }}><th>Активность журнала</th><th>Действие модели</th><th>Подтверждено</th></tr></thead>
            <tbody>
              {mappings.map((m) => (
                <tr key={m.activity} style={{ borderTop: "1px solid #e5e7eb" }}>
                  <td>{m.activity}</td>
                  <td>
                    <select
                      value={m.nodeId ?? ""}
                      onChange={(e) =>
                        withBusy(async () => {
                          await api.setMiningMapping(session.id, m.activity, e.target.value || null, m.confirmed);
                          await reloadMappings();
                        })
                      }
                    >
                      <option value="">— не сопоставлено —</option>
                      {taskOptions.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
                    </select>
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      checked={m.confirmed}
                      disabled={!m.nodeId}
                      onChange={(e) => withBusy(async () => { await api.setMiningMapping(session.id, m.activity, m.nodeId, e.target.checked); await reloadMappings(); })}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="toolbar" style={{ marginTop: 10 }}>
            <button disabled={busy} onClick={() => withBusy(async () => setConformance(await api.getMiningConformance(session.id)))}>
              Проверить соответствие
            </button>
            <button
              disabled={busy}
              onClick={() =>
                withBusy(async () => {
                  await api.applyMiningDurations(session.id);
                  onChanged();
                })
              }
            >
              Подставить длительности из журнала
            </button>
          </div>
        </>
      )}

      {conformance && (
        <div style={{ marginTop: 14 }}>
          <div className="form-grid">
            <div><span className="muted">Fitness (полнота)</span><div style={{ fontSize: 20, fontWeight: 600 }}>{conformance.fitness !== null ? `${(conformance.fitness * 100).toFixed(0)}%` : "—"}</div></div>
            <div><span className="muted">Precision (точность)</span><div style={{ fontSize: 20, fontWeight: 600 }}>{conformance.precision !== null ? `${(conformance.precision * 100).toFixed(0)}%` : "—"}</div></div>
          </div>
          {conformance.deviationsInLogNotModel.length > 0 && (
            <div className="validation-item warning" style={{ marginTop: 10 }}>
              <strong>В журнале, но не в модели:</strong>
              <ul style={{ margin: "4px 0 0 18px", fontSize: 12 }}>
                {conformance.deviationsInLogNotModel.slice(0, 10).map((d, i) => <li key={i}>{d.fromLabel} → {d.toLabel} ({d.count}×)</li>)}
              </ul>
            </div>
          )}
          {conformance.deviationsInModelNotLog.length > 0 && (
            <div className="validation-item" style={{ marginTop: 8 }}>
              <strong>В модели, но не наблюдалось в журнале:</strong>
              <ul style={{ margin: "4px 0 0 18px", fontSize: 12 }}>
                {conformance.deviationsInModelNotLog.slice(0, 10).map((d, i) => <li key={i}>{d.fromLabel} → {d.toLabel}</li>)}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
