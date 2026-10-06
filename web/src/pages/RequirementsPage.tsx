import { useEffect, useState } from "react";
import { api, type RequirementRow, type RequirementAuditCoverage } from "../api/client";

/** ФТ-М6.1: реестр требований (стандарты, НПА, внутренние стандарты). */
export default function RequirementsPage() {
  const [rows, setRows] = useState<RequirementRow[]>([]);
  const [sourceFilter, setSourceFilter] = useState("");
  const [q, setQ] = useState("");
  const [code, setCode] = useState("");
  const [title, setTitle] = useState("");
  const [source, setSource] = useState("internal");
  const [coverageFor, setCoverageFor] = useState<string | null>(null);
  const [coverage, setCoverage] = useState<RequirementAuditCoverage | null>(null);

  async function reload() {
    setRows(await api.listRequirements({ source: sourceFilter || undefined, q: q || undefined }));
  }

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceFilter, q]);

  const sources = Array.from(new Set(rows.map((r) => r.source)));

  return (
    <div className="card" style={{ margin: 16 }}>
      <div className="toolbar">
        <h2 style={{ margin: 0 }}>Реестр требований</h2>
      </div>
      <p className="muted" style={{ fontSize: 12 }}>
        Требования стандартов, нормативных актов и внутренних документов — коды и краткие собственные формулировки
        (не дословный текст стандартов — во избежание нарушения лицензионных ограничений). Предзаполнено кратким каталогом ISO 9001:2015, п. 4.4.
      </p>

      <div className="toolbar" style={{ marginTop: 10 }}>
        <input placeholder="Поиск по коду/названию" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)}>
          <option value="">Все источники</option>
          {sources.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      <div className="chat-input-row" style={{ marginTop: 10 }}>
        <input placeholder="Код (напр. ISO9001-4.4.1.a)" value={code} onChange={(e) => setCode(e.target.value)} />
        <input placeholder="Краткая формулировка (своими словами)" value={title} onChange={(e) => setTitle(e.target.value)} style={{ flex: 1 }} />
        <input placeholder="Источник" value={source} onChange={(e) => setSource(e.target.value)} style={{ width: 120 }} />
        <button
          disabled={!code.trim() || !title.trim()}
          onClick={async () => {
            await api.createRequirement({ code: code.trim(), title: title.trim(), source: source.trim() || "internal" });
            setCode("");
            setTitle("");
            reload();
          }}
        >
          Добавить
        </button>
      </div>

      <table className="mono" style={{ width: "100%", fontSize: 13, marginTop: 12, borderCollapse: "collapse" }}>
        <thead><tr style={{ textAlign: "left" }}><th>Код</th><th>Формулировка</th><th>Источник</th><th></th><th></th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} style={{ borderTop: "1px solid #e5e7eb" }}>
              <td style={{ whiteSpace: "nowrap" }}>{r.code}</td>
              <td>{r.title}</td>
              <td>{r.source}</td>
              <td>
                <button
                  onClick={async () => {
                    if (coverageFor === r.id) {
                      setCoverageFor(null);
                      setCoverage(null);
                      return;
                    }
                    setCoverageFor(r.id);
                    setCoverage(await api.getRequirementAuditCoverage(r.id));
                  }}
                >
                  {coverageFor === r.id ? "Скрыть покрытие" : "Пакет к аудиту"}
                </button>
              </td>
              <td><button onClick={async () => { await api.deleteRequirement(r.id); reload(); }}>✕</button></td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={5} className="muted" style={{ padding: 12 }}>Ничего не найдено.</td></tr>}
        </tbody>
      </table>

      {coverage && (
        <div className="card" style={{ marginTop: 16 }}>
          <h4 style={{ margin: 0 }}>Покрытие требования «{coverage.requirement.code}» по процессам</h4>
          <p className="muted" style={{ fontSize: 12 }}>
            Покрыто процессами: {coverage.coveredByProcessCount} из {coverage.totalProcessCount} (с построенной моделью).
          </p>
          {coverage.coverage.length === 0 ? (
            <p className="muted">Ни одна сессия не связывает элементы модели с этим требованием.</p>
          ) : (
            <table style={{ width: "100%", fontSize: 13, marginTop: 8, borderCollapse: "collapse" }}>
              <thead><tr style={{ textAlign: "left" }}><th>Процесс</th><th>Статус</th><th>Связанные элементы</th></tr></thead>
              <tbody>
                {coverage.coverage.map((c) => (
                  <tr key={c.sessionId} style={{ borderTop: "1px solid #e5e7eb" }}>
                    <td>{c.processName}</td>
                    <td>{c.status}</td>
                    <td>
                      {c.elements.map((e) => (
                        <span key={e.elementId} className="badge" style={{ marginRight: 6 }}>
                          {e.name} ({e.coverage === "full" ? "полное" : "частичное"})
                        </span>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
