import { useEffect, useState } from "react";
import { api, type AgentConfigRow, type CorpusStats, type CorpusEntryRow, type EvalSummary, type LLMStatus } from "../api/client";

const PROVIDER_LABEL: Record<string, string> = { mock: "Офлайн (mock)", anthropic: "Anthropic", local: "Локальный (vLLM и т.п.)" };

/** ФТ-М9.1–М9.3: технологическое развитие — корпус, мультиагентная архитектура, локальная модель. */
export default function TechnologyPage() {
  const [tab, setTab] = useState<"corpus" | "agents" | "eval">("corpus");

  return (
    <div className="card" style={{ margin: 16 }}>
      <div className="toolbar">
        <h2 style={{ margin: 0 }}>Технологии</h2>
        <div className="spacer" />
        <button className={tab === "corpus" ? "active" : ""} onClick={() => setTab("corpus")}>Корпус</button>
        <button className={tab === "agents" ? "active" : ""} onClick={() => setTab("agents")}>Агенты</button>
        <button className={tab === "eval" ? "active" : ""} onClick={() => setTab("eval")}>Регрессия / провайдеры</button>
      </div>

      {tab === "corpus" && <CorpusTab />}
      {tab === "agents" && <AgentsTab />}
      {tab === "eval" && <EvalTab />}
    </div>
  );
}

function CorpusTab() {
  const [stats, setStats] = useState<CorpusStats | null>(null);
  const [entries, setEntries] = useState<CorpusEntryRow[]>([]);

  useEffect(() => {
    api.getCorpusStats().then(setStats);
    api.listCorpus().then(setEntries);
  }, []);

  return (
    <div style={{ marginTop: 12 }}>
      <p className="muted" style={{ fontSize: 12 }}>
        Корпус пополняется автоматически парами «текст интервью — утверждённая модель» при утверждении версии (конфиденциальные процессы исключаются).
        Используется для подбора похожих примеров при извлечении (few-shot) и для регрессионной оценки качества.
      </p>
      {stats && (
        <>
          <div className="form-grid" style={{ marginTop: 10 }}>
            <div><span className="muted">Записей в корпусе</span><div style={{ fontSize: 22, fontWeight: 600 }}>{stats.count}</div></div>
            <div><span className="muted">Порог для дообучения</span><div>{stats.fineTuneThreshold}</div></div>
            <div><span className="muted">Готовность к дообучению</span><div>{stats.fineTuneReady ? "да" : "нет"}</div></div>
          </div>
          <div className="validation-item" style={{ marginTop: 10, fontSize: 12 }}>{stats.note}</div>
        </>
      )}

      <table className="mono" style={{ width: "100%", fontSize: 13, marginTop: 16, borderCollapse: "collapse" }}>
        <thead><tr style={{ textAlign: "left" }}><th>Процесс</th><th>Сессия</th><th>Дата</th></tr></thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.id} style={{ borderTop: "1px solid #e5e7eb" }}>
              <td>{e.processName}</td>
              <td className="muted">{e.sessionId}</td>
              <td>{new Date(e.createdAt).toLocaleString("ru-RU")}</td>
            </tr>
          ))}
          {entries.length === 0 && <tr><td colSpan={3} className="muted" style={{ padding: 12 }}>Корпус пуст — утвердите хотя бы одну версию модели.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function AgentsTab() {
  const [rows, setRows] = useState<AgentConfigRow[]>([]);

  async function reload() {
    setRows(await api.listAgentConfig());
  }
  useEffect(() => {
    reload();
  }, []);

  return (
    <div style={{ marginTop: 12 }}>
      <p className="muted" style={{ fontSize: 12 }}>
        Мультиагентный конвейер: Извлекатель → Сборщик → Критик → Интервьюер → Аналитик → Документалист. Для каждого агента можно назначить свою модель LLM
        (влияет на реальный вызов Anthropic-провайдера; офлайн-режим её не использует).
      </p>
      <table className="mono" style={{ width: "100%", fontSize: 13, marginTop: 10, borderCollapse: "collapse" }}>
        <thead><tr style={{ textAlign: "left" }}><th>Агент</th><th>Модель LLM</th><th></th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <AgentRow key={r.agentKey} row={r} onSaved={reload} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AgentRow({ row, onSaved }: { row: AgentConfigRow; onSaved: () => void }) {
  const [value, setValue] = useState(row.modelName);
  return (
    <tr style={{ borderTop: "1px solid #e5e7eb" }}>
      <td>{row.label}</td>
      <td><input value={value} onChange={(e) => setValue(e.target.value)} style={{ width: 220 }} /></td>
      <td>
        <button disabled={value === row.modelName} onClick={async () => { await api.setAgentModel(row.agentKey, value); onSaved(); }}>
          Сохранить
        </button>
      </td>
    </tr>
  );
}

function EvalTab() {
  const [status, setStatus] = useState<LLMStatus | null>(null);
  const [provider, setProvider] = useState<"mock" | "anthropic" | "openai-compat" | "local">("mock");
  const [result, setResult] = useState<EvalSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.getLlmStatus().then(setStatus);
  }, []);

  return (
    <div style={{ marginTop: 12 }}>
      <p className="muted" style={{ fontSize: 12 }}>
        Прогон эталонного набора текстов с известными ролями/действиями на выбранном провайдере — recall по ролям и действиям.
        Используется перед выкаткой нового варианта промпта или модели и для сравнения деградации качества локальной модели.
      </p>
      {status && (
        <div className="form-grid" style={{ marginTop: 10 }}>
          <div><span className="muted">Текущий провайдер</span><div>{PROVIDER_LABEL[status.name] ?? status.name} {status.live ? "" : "(офлайн)"}</div></div>
          <div><span className="muted">Локальный провайдер настроен</span><div>{status.localConfigured ? "да" : "нет"}</div></div>
        </div>
      )}

      <div className="toolbar" style={{ marginTop: 14 }}>
        <select value={provider} onChange={(e) => setProvider(e.target.value as any)}>
          <option value="mock">Офлайн (mock)</option>
          <option value="anthropic">Anthropic</option>
          <option value="openai-compat">Облако (OpenAI-совместимый)</option>
          <option value="local">Локальный</option>
        </select>
        <button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            setResult(null);
            try {
              setResult(await api.runEval(provider));
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          Запустить оценку
        </button>
      </div>

      {error && <div className="validation-item error" style={{ marginTop: 10 }}>{error}</div>}

      {result && (
        <>
          <div className="form-grid" style={{ marginTop: 14 }}>
            <div><span className="muted">Средний recall по ролям</span><div style={{ fontSize: 20, fontWeight: 600 }}>{(result.avgRoleRecall * 100).toFixed(0)}%</div></div>
            <div><span className="muted">Средний recall по действиям</span><div style={{ fontSize: 20, fontWeight: 600 }}>{(result.avgNodeRecall * 100).toFixed(0)}%</div></div>
          </div>
          <table className="mono" style={{ width: "100%", fontSize: 12, marginTop: 12, borderCollapse: "collapse" }}>
            <thead><tr style={{ textAlign: "left" }}><th>Кейс</th><th>Роли (найдено/ожидалось)</th><th>Действия (найдено/ожидалось)</th></tr></thead>
            <tbody>
              {result.cases.map((c) => (
                <tr key={c.caseId} style={{ borderTop: "1px solid #e5e7eb" }}>
                  <td>{c.caseId}{c.error ? <span className="muted"> ({c.error})</span> : ""}</td>
                  <td>{(c.roleRecall * 100).toFixed(0)}% — {c.foundRoles.join(", ") || "—"}</td>
                  <td>{(c.nodeRecall * 100).toFixed(0)}% — {c.foundNodes.join(", ") || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
