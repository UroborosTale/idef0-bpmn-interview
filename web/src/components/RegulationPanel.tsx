import { useEffect, useState } from "react";
import { api, type RegulationStaleness } from "../api/client";
import type { SessionRecord } from "../types";

/** ФТ-М1.1: регламент/положение — предпросмотр, режим "только структура", экспорт .docx/.html, устаревшие абзацы. */
export default function RegulationPanel({ session }: { session: SessionRecord }) {
  const [structureOnly, setStructureOnly] = useState(false);
  const [staleness, setStaleness] = useState<RegulationStaleness | null>(null);
  const [busy, setBusy] = useState(false);

  async function reload() {
    setStaleness(await api.regulationStaleness(session.id));
  }

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id, session.updatedAt]);

  return (
    <div>
      <div className="toolbar">
        <h4 style={{ margin: 0 }}>Регламент / Положение о процессе</h4>
        <div className="spacer" />
        <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12 }}>
          <input type="checkbox" checked={structureOnly} onChange={(e) => setStructureOnly(e.target.checked)} />
          Только структура (без текста)
        </label>
        <a href={api.regulationExportDocxUrl(session.id, structureOnly)} target="_blank" rel="noreferrer"><button>Экспорт .docx</button></a>
        <a href={api.regulationExportHtmlUrl(session.id, structureOnly)} target="_blank" rel="noreferrer"><button>Экспорт .html</button></a>
        <button
          className="primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api.markRegulationGenerated(session.id);
              await reload();
            } finally {
              setBusy(false);
            }
          }}
        >
          Отметить как сгенерированный
        </button>
      </div>

      {staleness && staleness.generatedAtSeq === null && (
        <div className="validation-item warning" style={{ marginTop: 8 }}>
          Регламент ещё ни разу не был отмечен как сгенерированный — отслеживание устаревших абзацев начнётся после первой отметки.
        </div>
      )}
      {staleness && staleness.generatedAtSeq !== null && staleness.staleCount > 0 && (
        <div className="validation-item warning" style={{ marginTop: 8 }}>
          Модель изменилась с момента последней генерации: {staleness.staleCount} абзац(ев) устарели (выделены жёлтым ниже). Перегенерируйте документ и отметьте заново.
        </div>
      )}
      {staleness && staleness.generatedAtSeq !== null && staleness.staleCount === 0 && (
        <div className="validation-item" style={{ marginTop: 8 }}>Регламент актуален — модель не менялась с последней генерации.</div>
      )}

      <div className="card" style={{ marginTop: 12, padding: 0, overflow: "hidden" }}>
        <iframe
          title="Предпросмотр регламента"
          src={api.regulationPreviewUrl(session.id, structureOnly)}
          style={{ width: "100%", height: "calc(100vh - 340px)", border: "none", background: "#fff" }}
        />
      </div>
    </div>
  );
}
