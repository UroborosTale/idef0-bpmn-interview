import { useState } from "react";
import { api, type BpmnReconcileChanges, type DrawioReconcileChange } from "../api/client";
import type { SessionRecord } from "../types";

/** ФТ-М9.4: приём правок из внешних редакторов (bpmn.io/Camunda Modeler, draw.io) обратно в PLM. */
export default function DiagramReimportPanel({ session, onChanged }: { session: SessionRecord; onChanged: () => void }) {
  const [bpmnXml, setBpmnXml] = useState("");
  const [bpmnChanges, setBpmnChanges] = useState<BpmnReconcileChanges | null>(null);
  const [drawioXml, setDrawioXml] = useState("");
  const [drawioChanges, setDrawioChanges] = useState<DrawioReconcileChange[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function onFile(setter: (v: string) => void) {
    return (f: File) => {
      const reader = new FileReader();
      reader.onload = () => setter(String(reader.result ?? ""));
      reader.readAsText(f, "utf-8");
    };
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
        <h4 style={{ margin: 0 }}>Приём правок из внешних редакторов</h4>
      </div>
      <p className="muted" style={{ fontSize: 12 }}>
        Экспортируйте текущую модель в bpmn.io/Camunda Modeler (
        <a href={api.exportUrl(session.id, "bpmn")} target="_blank" rel="noreferrer">скачать .bpmn</a>) или draw.io (
        <a href={api.exportUrl(session.id, "idef0.drawio")} target="_blank" rel="noreferrer">скачать .drawio</a>), внесите правки во внешнем
        редакторе и загрузите изменённый файл ниже — переименованные элементы обновятся, новые появятся как гипотезы, а отсутствующие в
        файле элементы модели будут только отмечены (не удалены).
      </p>
      {error && <div className="validation-item error">{error}</div>}

      <h4 style={{ marginTop: 16 }}>Правки из BPMN-редактора</h4>
      <input type="file" accept=".bpmn,.xml,text/xml" onChange={(e) => e.target.files?.[0] && onFile(setBpmnXml)(e.target.files[0])} />
      <textarea
        style={{ width: "100%", height: 90, marginTop: 6, fontFamily: "monospace", fontSize: 11 }}
        placeholder="Вставьте изменённый BPMN XML…"
        value={bpmnXml}
        onChange={(e) => setBpmnXml(e.target.value)}
      />
      <div className="toolbar" style={{ marginTop: 6 }}>
        <button
          disabled={!bpmnXml.trim() || busy}
          onClick={() =>
            withBusy(async () => {
              const r = await api.reimportBpmn(session.id, bpmnXml);
              setBpmnChanges(r.changes);
              onChanged();
            })
          }
        >
          Загрузить правки BPMN
        </button>
      </div>
      {bpmnChanges && (
        <div className="validation-item" style={{ marginTop: 8, fontSize: 12 }}>
          Переименовано: {bpmnChanges.renamed.length}; добавлено новых (как гипотезы): {bpmnChanges.added.length}; отсутствует в файле: {bpmnChanges.missing.length}
          {bpmnChanges.renamed.length > 0 && (
            <ul style={{ margin: "4px 0 0 18px" }}>
              {bpmnChanges.renamed.map((r, i) => <li key={i}>«{r.from}» → «{r.to}»</li>)}
            </ul>
          )}
        </div>
      )}

      <h4 style={{ marginTop: 20 }}>Правки названий из draw.io (IDEF0)</h4>
      <input type="file" accept=".drawio,.xml,text/xml" onChange={(e) => e.target.files?.[0] && onFile(setDrawioXml)(e.target.files[0])} />
      <textarea
        style={{ width: "100%", height: 90, marginTop: 6, fontFamily: "monospace", fontSize: 11 }}
        placeholder="Вставьте изменённый draw.io XML…"
        value={drawioXml}
        onChange={(e) => setDrawioXml(e.target.value)}
      />
      <div className="toolbar" style={{ marginTop: 6 }}>
        <button
          disabled={!drawioXml.trim() || busy}
          onClick={() =>
            withBusy(async () => {
              const r = await api.reimportDrawioIdef0(session.id, drawioXml);
              setDrawioChanges(r.changes);
              onChanged();
            })
          }
        >
          Загрузить правки draw.io
        </button>
      </div>
      {drawioChanges && (
        <div className="validation-item" style={{ marginTop: 8, fontSize: 12 }}>
          Переименовано: {drawioChanges.length}
          {drawioChanges.length > 0 && (
            <ul style={{ margin: "4px 0 0 18px" }}>
              {drawioChanges.map((r, i) => <li key={i}>«{r.from}» → «{r.to}»</li>)}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
