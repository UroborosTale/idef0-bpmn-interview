import { useEffect, useState } from "react";
import { api, type TraceabilityReport, type RequirementRow } from "../api/client";
import type { SessionRecord } from "../types";

const COVERAGE_LABEL: Record<string, string> = { full: "полное", partial: "частичное", none: "нет" };

/** ФТ-М6.3: трассировка требований — связи требование↔элемент модели и отчёт о покрытии. */
export default function TraceabilityPanel({ session, onChanged }: { session: SessionRecord; onChanged: () => void }) {
  const model = session.model!;
  const [report, setReport] = useState<TraceabilityReport | null>(null);
  const [catalog, setCatalog] = useState<RequirementRow[]>([]);
  const [reqId, setReqId] = useState("");
  const [elementId, setElementId] = useState("");
  const [coverage, setCoverage] = useState<"full" | "partial">("full");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const elementOptions = [
    ...model.nodes.filter((n) => n.type === "task" || n.type === "subprocess").map((n) => ({ id: n.id, label: n.name })),
    ...model.controls.map((c) => ({ id: c.id, label: `${c.name} (контроль)` })),
  ];
  const elementLabelById = new Map(elementOptions.map((e) => [e.id, e.label] as const));

  async function reload() {
    setReport(await api.getTraceability(session.id));
  }

  useEffect(() => {
    api.listRequirements().then(setCatalog);
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id, session.model]);

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
        <h4 style={{ margin: 0 }}>Трассировка требований</h4>
      </div>
      <p className="muted" style={{ fontSize: 12 }}>
        Связывает требования из реестра (М6.1) с конкретными элементами модели (задачи, контрольные точки) — показывает, какие требования покрыты, а какие элементы не обоснованы ни одним требованием.
      </p>

      {error && <div className="validation-item error">{error}</div>}

      <div className="chat-input-row" style={{ marginTop: 10 }}>
        <select value={reqId} onChange={(e) => setReqId(e.target.value)}>
          <option value="">— требование —</option>
          {catalog.map((r) => <option key={r.id} value={r.id}>{r.code} — {r.title.slice(0, 50)}</option>)}
        </select>
        <select value={elementId} onChange={(e) => setElementId(e.target.value)}>
          <option value="">— элемент модели —</option>
          {elementOptions.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
        </select>
        <select value={coverage} onChange={(e) => setCoverage(e.target.value as "full" | "partial")}>
          <option value="full">Полное покрытие</option>
          <option value="partial">Частичное покрытие</option>
        </select>
        <button
          disabled={!reqId || !elementId || busy}
          onClick={() =>
            withBusy(async () => {
              await api.addRequirementsLink(session.id, reqId, elementId, coverage);
              onChanged();
              await reload();
            })
          }
        >
          Связать
        </button>
      </div>

      {report && (
        <>
          <div style={{ fontSize: 24, fontWeight: 600, marginTop: 16 }}>
            {report.coveragePercent}% <span style={{ fontSize: 13, fontWeight: 400 }} className="muted">требований покрыто</span>
          </div>

          <table className="mono" style={{ width: "100%", fontSize: 13, marginTop: 12, borderCollapse: "collapse" }}>
            <thead><tr style={{ textAlign: "left" }}><th>Требование</th><th>Покрытие</th><th>Элементы</th></tr></thead>
            <tbody>
              {report.requirements.map((r) => (
                <tr key={r.requirementId} style={{ borderTop: "1px solid #e5e7eb" }}>
                  <td>{r.code} — {r.title}</td>
                  <td style={{ color: r.coverage === "none" ? "#dc2626" : r.coverage === "partial" ? "#b45309" : "#16a34a" }}>{COVERAGE_LABEL[r.coverage]}</td>
                  <td>
                    {r.linkedElementIds.map((id) => (
                      <span key={id} style={{ display: "inline-block", marginRight: 6, marginBottom: 2 }}>
                        {elementLabelById.get(id) ?? id}{" "}
                        <button
                          disabled={busy}
                          onClick={() => withBusy(async () => { await api.removeRequirementsLink(session.id, r.requirementId, id); onChanged(); await reload(); })}
                        >
                          ✕
                        </button>
                      </span>
                    ))}
                  </td>
                </tr>
              ))}
              {report.requirements.length === 0 && <tr><td colSpan={3} className="muted" style={{ padding: 12 }}>Реестр требований пуст.</td></tr>}
            </tbody>
          </table>

          {report.unlinkedElementIds.length > 0 && (
            <div className="validation-item warning" style={{ marginTop: 12 }}>
              Элементы без обосновывающего требования: {report.unlinkedElementIds.map((id) => elementLabelById.get(id) ?? id).join(", ")}
            </div>
          )}
        </>
      )}
    </div>
  );
}
