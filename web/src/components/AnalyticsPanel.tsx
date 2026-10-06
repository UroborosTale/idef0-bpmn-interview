import { useEffect, useState } from "react";
import { api, type BottleneckReport, type CostReport, type SensitivityPoint, type RoleRate, type AntipatternFinding } from "../api/client";
import type { SessionRecord } from "../types";

const ANTIPATTERN_LABEL: Record<string, string> = {
  double_entry: "Двойной ввод",
  manual_handoff: "Ручная передача между системами",
  excessive_approval: "Избыточное согласование",
  step_without_output: "Шаг без выхода",
  loop_without_exit: "Петля без выхода по сроку",
  ping_pong: "Пинг-понг",
};

function fmtMinutes(m: number | null): string {
  if (m === null) return "—";
  if (m >= 1440) return `${(m / 1440).toFixed(1)} дн.`;
  if (m >= 60) return `${(m / 60).toFixed(1)} ч.`;
  return `${m.toFixed(0)} мин.`;
}
function fmtMoney(v: number | null): string {
  if (v === null) return "—";
  return v.toLocaleString("ru-RU", { maximumFractionDigits: 0 });
}
function heatColor(heat: number): string {
  const h = Math.max(0, Math.min(1, heat));
  const r = Math.round(255 * h + 241 * (1 - h));
  const g = Math.round(80 * h + 245 * (1 - h));
  const b = Math.round(80 * h + 249 * (1 - h));
  return `rgb(${r},${g},${b})`;
}

/** ФТ-М2.1–М2.3: аналитика процесса — узкие места, трудозатраты/стоимость, антипаттерны. */
export default function AnalyticsPanel({ session, onChanged }: { session: SessionRecord; onChanged: () => void }) {
  const [tab, setTab] = useState<"bottlenecks" | "cost" | "antipatterns">("bottlenecks");
  const [bottlenecks, setBottlenecks] = useState<BottleneckReport | null>(null);
  const [antipatterns, setAntipatterns] = useState<AntipatternFinding[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getBottlenecks(session.id).then(setBottlenecks).catch((e) => setError((e as Error).message));
  }, [session.id, session.model]);

  useEffect(() => {
    if (tab === "antipatterns") {
      api.getAntipatterns(session.id).then(setAntipatterns).catch((e) => setError((e as Error).message));
    }
  }, [tab, session.id, session.model]);

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
        <h4 style={{ margin: 0 }}>Аналитика процесса</h4>
        <div className="spacer" />
        <button className={tab === "bottlenecks" ? "active" : ""} onClick={() => setTab("bottlenecks")}>Узкие места</button>
        <button className={tab === "cost" ? "active" : ""} onClick={() => setTab("cost")}>Трудозатраты и стоимость</button>
        <button className={tab === "antipatterns" ? "active" : ""} onClick={() => setTab("antipatterns")}>
          Антипаттерны{antipatterns && antipatterns.length > 0 ? ` (${antipatterns.length})` : ""}
        </button>
      </div>

      {error && <div className="validation-item error">{error}</div>}

      {tab === "bottlenecks" && (
        <BottlenecksTab
          report={bottlenecks}
          busy={busy}
          onRequestGaps={() =>
            withBusy(async () => {
              await api.requestTimingGaps(session.id);
              onChanged();
            })
          }
        />
      )}
      {tab === "cost" && <CostTab session={session} />}
      {tab === "antipatterns" && <AntipatternsTab findings={antipatterns} />}
    </div>
  );
}

function PathBlock({ title, path }: { title: string; path: BottleneckReport["mainPath"] }) {
  if (!path) return null;
  return (
    <div style={{ marginBottom: 10 }}>
      <div className="muted" style={{ fontSize: 12 }}>{title} {path.totalMinutes !== null && `— ${fmtMinutes(path.totalMinutes)}`}</div>
      <div style={{ fontSize: 13 }}>{path.nodeNames.join(" → ")}</div>
    </div>
  );
}

function BottlenecksTab({
  report,
  busy,
  onRequestGaps,
}: {
  report: BottleneckReport | null;
  busy: boolean;
  onRequestGaps: () => void;
}) {
  if (!report) return <p className="muted">Загрузка…</p>;

  return (
    <div style={{ marginTop: 10 }}>
      {!report.hasTimingData && (
        <div className="validation-item warning" style={{ marginBottom: 10 }}>
          В модели нет данных о длительности шагов — расчёт цикла и ожидания недоступен.{" "}
          <button disabled={busy} onClick={onRequestGaps}>Запросить длительность (добавить вопросы в пробелы)</button>
        </div>
      )}

      <PathBlock title="Основной путь (главный сценарий)" path={report.mainPath} />
      <PathBlock title="Наихудший путь (по суммарной длительности)" path={report.worstPath} />

      <div className="form-grid" style={{ marginTop: 12 }}>
        <div><span className="muted">Доля времени ожидания</span><div>{report.waitingShare !== null ? `${(report.waitingShare * 100).toFixed(0)}%` : "—"}</div></div>
        <div><span className="muted">Передач между ролями (handoff)</span><div>{report.handoffCount}</div></div>
        <div><span className="muted">Согласований</span><div>{report.approvalCount}</div></div>
        <div><span className="muted">Циклов возврата</span><div>{report.returnLoopCount}</div></div>
      </div>

      <h4 style={{ marginTop: 20 }}>Тепловая карта узлов</h4>
      <p className="muted" style={{ fontSize: 12 }}>Чем краснее — тем выше «нагрузка» узла (длительность и/или участие в цикле возврата).</p>
      <table className="mono" style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
        <thead><tr style={{ textAlign: "left" }}><th>Узел</th><th>Длительность</th><th>В цикле</th><th>Индекс нагрузки</th></tr></thead>
        <tbody>
          {[...report.nodeHeat].sort((a, b) => b.heat - a.heat).map((n) => (
            <tr key={n.nodeId} style={{ borderTop: "1px solid #e5e7eb" }}>
              <td>{n.name}</td>
              <td>{fmtMinutes(n.minutes)}</td>
              <td>{n.inLoop ? "да" : "—"}</td>
              <td>
                <div style={{ background: heatColor(n.heat), borderRadius: 3, padding: "2px 8px", display: "inline-block", minWidth: 50, textAlign: "center" }}>
                  {n.heat.toFixed(2)}
                </div>
              </td>
            </tr>
          ))}
          {report.nodeHeat.length === 0 && <tr><td colSpan={4} className="muted" style={{ padding: 12 }}>Нет узлов для анализа.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function CostTab({ session }: { session: SessionRecord }) {
  const [rates, setRates] = useState<RoleRate[]>([]);
  const [cost, setCost] = useState<CostReport | null>(null);
  const [sensitivity, setSensitivity] = useState<SensitivityPoint[] | null>(null);
  const [frequency, setFrequency] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const model = session.model!;
  const roles = model.roles;

  async function reload() {
    setRates(await api.listRoleRates());
    const c = await api.getCost(session.id);
    setCost(c);
    setFrequency(c.frequencyPerMonth !== null ? String(c.frequencyPerMonth) : "");
  }

  useEffect(() => {
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

  const rateByRole = new Map(rates.map((r) => [r.role_name.toLowerCase(), r] as const));

  return (
    <div style={{ marginTop: 10 }}>
      {error && <div className="validation-item error">{error}</div>}

      <h4>Ставки ролей (общий справочник)</h4>
      <table className="mono" style={{ fontSize: 13, borderCollapse: "collapse" }}>
        <thead><tr style={{ textAlign: "left" }}><th>Роль</th><th>Ставка, ₽/час</th><th></th></tr></thead>
        <tbody>
          {roles.map((r) => {
            const existing = rateByRole.get(r.name.toLowerCase());
            return (
              <tr key={r.id} style={{ borderTop: "1px solid #e5e7eb" }}>
                <td>{r.name}</td>
                <td>
                  <input
                    type="number"
                    style={{ width: 100 }}
                    defaultValue={existing?.rate ?? ""}
                    onBlur={(e) => {
                      const rate = Number(e.target.value);
                      if (!rate || rate <= 0) return;
                      withBusy(async () => {
                        await api.setRoleRate(r.name.toLowerCase(), r.name, rate, "per_hour");
                        await reload();
                      });
                    }}
                  />
                </td>
                <td>{existing && <button disabled={busy} onClick={() => withBusy(async () => { await api.deleteRoleRate(r.name.toLowerCase()); await reload(); })}>✕</button>}</td>
              </tr>
            );
          })}
          {roles.length === 0 && <tr><td colSpan={3} className="muted" style={{ padding: 12 }}>В модели нет ролей.</td></tr>}
        </tbody>
      </table>

      <div className="toolbar" style={{ marginTop: 14 }}>
        <label className="field" style={{ margin: 0 }}>
          <span>Частота процесса (раз/мес)</span>
          <input type="number" style={{ width: 100 }} value={frequency} onChange={(e) => setFrequency(e.target.value)} />
        </label>
        <button
          disabled={busy}
          onClick={() =>
            withBusy(async () => {
              const value = frequency.trim() ? Number(frequency) : null;
              await api.setFrequency(session.id, value);
              const c = await api.getCost(session.id);
              setCost(c);
              setSensitivity(await api.getSensitivity(session.id));
            })
          }
        >
          Сохранить и пересчитать
        </button>
      </div>

      {cost && (
        <>
          <h4 style={{ marginTop: 20 }}>Трудозатраты по ролям на 1 экземпляр процесса</h4>
          <table className="mono" style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
            <thead><tr style={{ textAlign: "left" }}><th>Роль</th><th>Время обработки</th><th>Стоимость</th></tr></thead>
            <tbody>
              {cost.roles.map((r) => (
                <tr key={r.roleId} style={{ borderTop: "1px solid #e5e7eb" }}>
                  <td>{r.roleName}</td>
                  <td>{fmtMinutes(r.minutesPerInstance)}</td>
                  <td>{r.hasRate ? fmtMoney(r.costPerInstance) + " ₽" : <span className="muted">нет ставки</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {cost.missingRates.length > 0 && (
            <div className="validation-item warning" style={{ marginTop: 8 }}>
              Нет ставки для ролей: {cost.missingRates.join(", ")} — итоговая стоимость не может быть рассчитана полностью.
            </div>
          )}
          <div className="form-grid" style={{ marginTop: 10 }}>
            <div><span className="muted">Итого на 1 экземпляр</span><div>{cost.totalCostPerInstance !== null ? `${fmtMoney(cost.totalCostPerInstance)} ₽` : "—"}</div></div>
            <div><span className="muted">Частота, раз/мес</span><div>{cost.frequencyPerMonth ?? "—"}</div></div>
            <div><span className="muted">Итого за период (мес.)</span><div>{cost.totalCostPerMonth !== null ? `${fmtMoney(cost.totalCostPerMonth)} ₽` : "—"}</div></div>
          </div>
        </>
      )}

      <div className="toolbar" style={{ marginTop: 16 }}>
        <button disabled={busy} onClick={() => withBusy(async () => setSensitivity(await api.getSensitivity(session.id)))}>
          Анализ чувствительности (±20% частота/длительность)
        </button>
      </div>
      {sensitivity && (
        <table className="mono" style={{ width: "100%", fontSize: 13, marginTop: 10, borderCollapse: "collapse" }}>
          <thead><tr style={{ textAlign: "left" }}><th>Сценарий</th><th>Частота</th><th>Стоимость/мес.</th></tr></thead>
          <tbody>
            {sensitivity.map((s) => (
              <tr key={s.label} style={{ borderTop: "1px solid #e5e7eb" }}>
                <td>{s.label}</td>
                <td>{s.frequencyPerMonth ?? "—"}</td>
                <td>{s.totalCostPerMonth !== null ? `${fmtMoney(s.totalCostPerMonth)} ₽` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function AntipatternsTab({ findings }: { findings: AntipatternFinding[] | null }) {
  if (!findings) return <p className="muted">Загрузка…</p>;
  if (findings.length === 0) return <p className="muted" style={{ marginTop: 10 }}>Антипаттерны не обнаружены.</p>;
  return (
    <div style={{ marginTop: 10 }}>
      {findings.map((f) => (
        <div key={f.id} className="validation-item warning" style={{ marginBottom: 8 }}>
          <strong>{ANTIPATTERN_LABEL[f.rule] ?? f.label}</strong>
          <div style={{ fontSize: 13, marginTop: 4 }}>{f.explanation}</div>
          {f.quotes.length > 0 && (
            <div className="muted" style={{ fontSize: 12, marginTop: 4, fontStyle: "italic" }}>
              «{f.quotes[0].quote}»
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
