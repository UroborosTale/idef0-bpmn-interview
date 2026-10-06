import { useState } from "react";
import { api } from "../api/client";
import type { SessionRecord } from "../types";

/** ФТ-М1.2: должностные инструкции по ролям процесса — предпросмотр и экспорт. */
export default function JobDescriptionsPanel({ session }: { session: SessionRecord }) {
  const model = session.model!;
  const [previewRoleId, setPreviewRoleId] = useState<string | null>(null);
  const [previewHtml, setPreviewHtml] = useState<string>("");

  return (
    <div>
      <div className="toolbar">
        <h4 style={{ margin: 0 }}>Должностные инструкции</h4>
      </div>
      <p className="muted" style={{ fontSize: 12 }}>
        Формируются автоматически из матрицы RACI и задач модели: обязанности (R/A), взаимодействие (C/I), используемые документы.
        Если роль связана со штатной должностью (справочники → должности), в шапке указывается название должности.
      </p>

      {model.roles.length === 0 ? (
        <p className="muted">В модели нет ролей.</p>
      ) : (
        <table className="mono" style={{ width: "100%", fontSize: 13, marginTop: 10, borderCollapse: "collapse" }}>
          <thead><tr style={{ textAlign: "left" }}><th>Роль</th><th></th></tr></thead>
          <tbody>
            {model.roles.map((r) => (
              <tr key={r.id} style={{ borderTop: "1px solid #e5e7eb" }}>
                <td>{r.name}</td>
                <td>
                  <button
                    onClick={async () => {
                      const html = await fetch(api.jobDescriptionPreviewUrl(session.id, r.id)).then((res) => res.text());
                      setPreviewHtml(html);
                      setPreviewRoleId(r.id);
                    }}
                  >
                    Предпросмотр
                  </button>{" "}
                  <a href={api.jobDescriptionExportHtmlUrl(session.id, r.id)} target="_blank" rel="noreferrer"><button>.html</button></a>{" "}
                  <a href={api.jobDescriptionExportDocxUrl(session.id, r.id)} target="_blank" rel="noreferrer"><button>.docx</button></a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {previewRoleId && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }} onClick={() => setPreviewRoleId(null)}>
          <div className="card" style={{ width: 640, maxHeight: "85vh", overflow: "auto", background: "#fff" }} onClick={(e) => e.stopPropagation()}>
            <div className="toolbar">
              <div className="spacer" />
              <button onClick={() => setPreviewRoleId(null)}>✕</button>
            </div>
            <iframe title="job-description-preview" srcDoc={previewHtml} style={{ width: "100%", height: "70vh", border: "none" }} />
          </div>
        </div>
      )}
    </div>
  );
}
