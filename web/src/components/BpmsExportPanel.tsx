import { useState } from "react";
import { api, type CompletenessReport } from "../api/client";
import type { SessionRecord } from "../types";

/** ФТ-М1.4: экспорт конфигурации в BPMS (Camunda исполняемый BPMN, ELMA365 общий JSON) + отчёт о неполноте. */
export default function BpmsExportPanel({ session }: { session: SessionRecord }) {
  const [target, setTarget] = useState<"camunda" | "elma365">("camunda");
  const [report, setReport] = useState<CompletenessReport | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <div>
      <div className="toolbar">
        <h4 style={{ margin: 0 }}>Экспорт в BPMS</h4>
      </div>
      <p className="muted" style={{ fontSize: 12 }}>
        Camunda — полноценный исполняемый BPMN с расширениями camunda: (исполнители-группы из ролей, черновики форм из входных данных,
        таймеры из сроков, условия ветвлений как заглушки для доработки). ELMA365 — публичный формат импорта процессов в этом окружении
        не задокументирован, поэтому выгружается общий JSON, требующий сопоставления полей вручную.
      </p>

      <div className="toolbar" style={{ marginTop: 10 }}>
        <a href={api.bpmsCamundaUrl(session.id)} target="_blank" rel="noreferrer"><button className="primary">Camunda: .bpmn</button></a>
        <a href={api.bpmsElma365Url(session.id)} target="_blank" rel="noreferrer"><button>ELMA365: .json</button></a>
        <select value={target} onChange={(e) => setTarget(e.target.value as "camunda" | "elma365")}>
          <option value="camunda">Отчёт для Camunda</option>
          <option value="elma365">Отчёт для ELMA365</option>
        </select>
        <button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              setReport(await api.getBpmsCompletenessReport(session.id, target));
            } finally {
              setBusy(false);
            }
          }}
        >
          Отчёт о неполноте
        </button>
      </div>

      {report && (
        <div style={{ marginTop: 14 }}>
          <div className="form-grid">
            <div><span className="muted">Всего задач</span><div>{report.stats.totalTasks}</div></div>
            <div><span className="muted">Без исполнителя</span><div>{report.stats.tasksWithoutAssignee}</div></div>
            <div><span className="muted">Развилок с заглушками условий</span><div>{report.stats.gatewaysWithConditionStubs}</div></div>
          </div>
          {report.notes.length === 0 ? (
            <p className="muted" style={{ marginTop: 10 }}>Замечаний нет.</p>
          ) : (
            <ul style={{ fontSize: 13, marginTop: 10 }}>
              {report.notes.map((n, i) => <li key={i}>{n}</li>)}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
