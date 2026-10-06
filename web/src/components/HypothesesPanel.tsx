import { useEffect, useState } from "react";
import { api, type HypothesisRow, type CompareReport } from "../api/client";
import type { SessionRecord } from "../types";

const STATUS_LABEL: Record<string, string> = { proposed: "предложена", applied: "применена", dismissed: "отклонена" };

function fmtMinutes(m: number | null): string {
  if (m === null) return "—";
  if (m >= 1440) return `${(m / 1440).toFixed(1)} дн.`;
  if (m >= 60) return `${(m / 60).toFixed(1)} ч.`;
  return `${m.toFixed(0)} мин.`;
}
function fmtMoney(v: number | null): string {
  return v === null ? "—" : `${v.toLocaleString("ru-RU", { maximumFractionDigits: 0 })} ₽`;
}

/** ФТ-М2.4: гипотезы TO-BE по результатам аналитики (М2.1-2.3) — никогда не применяются автоматически. */
export default function HypothesesPanel({ session }: { session: SessionRecord }) {
  const [hyps, setHyps] = useState<HypothesisRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [compareTarget, setCompareTarget] = useState<{ toBeId: string; title: string } | null>(null);

  async function reload() {
    setHyps(await api.listHypotheses(session.id));
  }
  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id]);

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
        <h4 style={{ margin: 0 }}>Гипотезы TO-BE</h4>
        <div className="spacer" />
        <button disabled={busy} onClick={() => withBusy(async () => { setHyps(await api.generateHypotheses(session.id)); })}>
          Сгенерировать гипотезы
        </button>
      </div>
      <p className="muted" style={{ fontSize: 12 }}>
        Формируются автоматически по результатам аналитики узких мест и антипаттернов (М2.1–М2.3). Гипотеза применяется только по явному
        действию аналитика и создаёт НОВУЮ сессию с TO-BE-моделью — исходная модель никогда не изменяется.
      </p>
      {error && <div className="validation-item error">{error}</div>}

      {!hyps ? (
        <p className="muted">Загрузка…</p>
      ) : hyps.length === 0 ? (
        <p className="muted">Гипотез пока нет — нажмите «Сгенерировать гипотезы».</p>
      ) : (
        hyps.map((h) => (
          <div key={h.id} className="card" style={{ marginTop: 10, background: h.status === "dismissed" ? "#f8fafc" : "#fff", opacity: h.status === "dismissed" ? 0.6 : 1 }}>
            <div className="toolbar">
              <strong>{h.templateLabel}</strong>
              <span className="muted" style={{ fontSize: 12 }}>— {STATUS_LABEL[h.status]}</span>
              <div className="spacer" />
              {h.status === "proposed" && (
                <>
                  <button disabled={busy} onClick={() => withBusy(async () => { await api.applyHypothesis(session.id, h.id); await reload(); })}>
                    Применить
                  </button>
                  <button disabled={busy} onClick={() => withBusy(async () => { await api.dismissHypothesis(session.id, h.id); await reload(); })}>
                    Отклонить
                  </button>
                </>
              )}
              {h.status === "applied" && h.appliedSessionId && (
                <button onClick={() => setCompareTarget({ toBeId: h.appliedSessionId!, title: h.title })}>Сравнить AS-IS/TO-BE</button>
              )}
            </div>
            <div style={{ fontSize: 14, fontWeight: 600, marginTop: 4 }}>{h.title}</div>
            <div style={{ fontSize: 13, marginTop: 4 }}>{h.description}</div>
            <div className="form-grid" style={{ marginTop: 8 }}>
              <div><span className="muted">Экономия времени</span><div>{fmtMinutes(h.minutesSaved)}</div></div>
              <div><span className="muted">Экономия стоимости</span><div>{fmtMoney(h.costSaved)}</div></div>
            </div>
            <div className="muted" style={{ fontSize: 12, marginTop: 6 }}><strong>Риски:</strong> {h.risks}</div>
            <div className="muted" style={{ fontSize: 12, marginTop: 2 }}><strong>Предпосылки:</strong> {h.assumptions}</div>
          </div>
        ))
      )}

      {compareTarget && <CompareModal asIsId={session.id} toBeId={compareTarget.toBeId} title={compareTarget.title} onClose={() => setCompareTarget(null)} />}
    </div>
  );
}

function CompareModal({ asIsId, toBeId, title, onClose }: { asIsId: string; toBeId: string; title: string; onClose: () => void }) {
  const [report, setReport] = useState<CompareReport | null>(null);

  useEffect(() => {
    api.getCompare(asIsId, toBeId).then(setReport);
  }, [asIsId, toBeId]);

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }} onClick={onClose}>
      <div className="card" style={{ width: 600, maxHeight: "85vh", overflow: "auto", background: "#fff" }} onClick={(e) => e.stopPropagation()}>
        <div className="toolbar">
          <h3 style={{ margin: 0 }}>Сравнение AS-IS / TO-BE</h3>
          <div className="spacer" />
          <button onClick={onClose}>✕</button>
        </div>
        <div className="muted" style={{ fontSize: 12 }}>{title}</div>
        {!report ? (
          <p className="muted">Загрузка…</p>
        ) : (
          <>
            <table className="mono" style={{ width: "100%", fontSize: 13, marginTop: 10, borderCollapse: "collapse" }}>
              <thead><tr style={{ textAlign: "left" }}><th>Показатель</th><th>AS-IS</th><th>TO-BE</th></tr></thead>
              <tbody>
                <tr style={{ borderTop: "1px solid #e5e7eb" }}><td>Число шагов</td><td>{report.delta.stepCount.before}</td><td>{report.delta.stepCount.after}</td></tr>
                <tr style={{ borderTop: "1px solid #e5e7eb" }}><td>Передач между ролями</td><td>{report.delta.handoffCount.before}</td><td>{report.delta.handoffCount.after}</td></tr>
                <tr style={{ borderTop: "1px solid #e5e7eb" }}><td>Время цикла</td><td>{fmtMinutes(report.delta.cycleTimeMinutes.before)}</td><td>{fmtMinutes(report.delta.cycleTimeMinutes.after)}</td></tr>
                <tr style={{ borderTop: "1px solid #e5e7eb" }}><td>Стоимость экземпляра</td><td>{fmtMoney(report.delta.laborCostPerInstance.before)}</td><td>{fmtMoney(report.delta.laborCostPerInstance.after)}</td></tr>
              </tbody>
            </table>
            <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
              Изменения: добавлено шагов {report.diff.nodes.added.length}, удалено {report.diff.nodes.removed.length}, изменено {report.diff.nodes.changed.length};
              связей добавлено {report.diff.flows.added.length}, удалено {report.diff.flows.removed.length}.
            </div>
            <div className="toolbar" style={{ marginTop: 12 }}>
              <a href={api.comparePreviewUrl(asIsId, toBeId)} target="_blank" rel="noreferrer"><button>Просмотр HTML</button></a>
              <a href={api.compareExportPdfUrl(asIsId, toBeId)} target="_blank" rel="noreferrer"><button>Экспорт PDF</button></a>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
