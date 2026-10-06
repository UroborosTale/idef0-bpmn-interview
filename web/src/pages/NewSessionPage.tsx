import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { SessionMeta } from "../types";

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(",")[1] ?? "");
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
function fileToText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = reject;
    reader.readAsText(file, "utf-8");
  });
}

export default function NewSessionPage({ onCreated }: { onCreated: (id: string) => void }) {
  const [mode, setMode] = useState<"A" | "B" | "diagram">("A");
  const [diagramFormat, setDiagramFormat] = useState<"bpmn" | "drawio" | "image">("bpmn");
  const [diagramFile, setDiagramFile] = useState<File | null>(null);
  const [processName, setProcessName] = useState("");
  const [owner, setOwner] = useState("");
  const [department, setDepartment] = useState("");
  const [modelType, setModelType] = useState<"AS-IS" | "TO-BE">("AS-IS");
  const [depth, setDepth] = useState(2);
  const [confidential, setConfidential] = useState(false);
  const [templates, setTemplates] = useState<{ id: string; name: string; hints: string[] }[]>([]);
  const [templateId, setTemplateId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.templates().then(setTemplates).catch(() => {});
  }, []);

  async function submit() {
    if (!processName.trim()) {
      setError("Укажите название процесса");
      return;
    }
    if (mode === "diagram" && !diagramFile) {
      setError("Выберите файл диаграммы");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const meta: SessionMeta = {
        processName: processName.trim(),
        owner: owner.trim() || undefined,
        department: department.trim() || undefined,
        modelType,
        decompositionDepth: depth,
        notations: ["IDEF0", "BPMN"],
        confidential,
      };
      if (mode === "diagram" && diagramFile) {
        const content = diagramFormat === "image" ? await fileToBase64(diagramFile) : await fileToText(diagramFile);
        const result = await api.importDiagramNew({ format: diagramFormat, content, mimeType: diagramFile.type || undefined, meta });
        onCreated(result.session.id);
        return;
      }
      const session = await api.createSession({ mode: mode as "A" | "B", meta });
      onCreated(session.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const selectedTemplate = templates.find((t) => t.id === templateId);

  return (
    <div>
      <h2>Новая сессия моделирования</h2>
      <div className="card form-grid">
        <div className="form-row">
          <label>Режим работы</label>
          <div style={{ display: "flex", gap: 12 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: mode === "A" ? 600 : 400 }}>
              <input type="radio" checked={mode === "A"} onChange={() => setMode("A")} /> Режим А — обработка готового текста интервью
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: mode === "B" ? 600 : 400 }}>
              <input type="radio" checked={mode === "B"} onChange={() => setMode("B")} /> Режим Б — интерактивное интервью
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: mode === "diagram" ? 600 : 400 }}>
              <input type="radio" checked={mode === "diagram"} onChange={() => setMode("diagram")} /> Режим В — импорт из готовой диаграммы
            </label>
          </div>
        </div>

        <div className="form-row">
          <label>Название процесса *</label>
          <input value={processName} onChange={(e) => setProcessName(e.target.value)} placeholder="например, Согласование заявки на закупку" />
        </div>

        <div className="two-col">
          <div className="form-row">
            <label>Владелец процесса</label>
            <input value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="ФИО или должность" />
          </div>
          <div className="form-row">
            <label>Подразделение</label>
            <input value={department} onChange={(e) => setDepartment(e.target.value)} />
          </div>
        </div>

        <div className="two-col">
          <div className="form-row">
            <label>Тип модели</label>
            <select value={modelType} onChange={(e) => setModelType(e.target.value as "AS-IS" | "TO-BE")}>
              <option value="AS-IS">AS-IS (как есть)</option>
              <option value="TO-BE">TO-BE (как должно быть)</option>
            </select>
          </div>
          <div className="form-row">
            <label>Глубина декомпозиции IDEF0</label>
            <input type="number" min={1} max={4} value={depth} onChange={(e) => setDepth(Number(e.target.value) || 2)} />
          </div>
        </div>

        <div className="form-row">
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 400 }}>
            <input type="checkbox" checked={confidential} onChange={(e) => setConfidential(e.target.checked)} />
            Конфиденциальный процесс
          </label>
          <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
            Обработка допускается только локальным провайдером (без передачи текста внешнему LLM). Если локальный провайдер не настроен, обработка будет отклонена.
          </div>
        </div>

        {mode === "diagram" && (
          <div className="form-row">
            <label>Формат диаграммы</label>
            <select value={diagramFormat} onChange={(e) => setDiagramFormat(e.target.value as "bpmn" | "drawio" | "image")}>
              <option value="bpmn">BPMN (.bpmn/.xml из bpmn.io, Camunda Modeler)</option>
              <option value="drawio">draw.io (.drawio/.xml)</option>
              <option value="image">Фото/скан схемы (изображение)</option>
            </select>
            <input
              type="file"
              accept={diagramFormat === "image" ? "image/*" : ".bpmn,.drawio,.xml,text/xml"}
              style={{ marginTop: 6 }}
              onChange={(e) => setDiagramFile(e.target.files?.[0] ?? null)}
            />
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              Структурированные форматы (.bpmn/.drawio) разбираются напрямую. Изображение распознаётся мультимодальной LLM — требует
              настроенного внешнего провайдера (недоступно в офлайн-режиме). Импорт .vsdx (Visio) не поддерживается.
            </div>
            {diagramFormat === "image" && <div className="validation-item" style={{ marginTop: 6, fontSize: 12 }}>В офлайн-режиме (без ANTHROPIC_API_KEY) распознавание изображений вернёт ошибку.</div>}
          </div>
        )}

        {mode === "B" && templates.length > 0 && (
          <div className="form-row">
            <label>Шаблон сценария интервью (необязательно)</label>
            <select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
              <option value="">— без шаблона —</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
            {selectedTemplate && (
              <ul className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                {selectedTemplate.hints.map((h, i) => <li key={i}>{h}</li>)}
              </ul>
            )}
          </div>
        )}

        {error && <div className="validation-item error">{error}</div>}

        <div>
          <button className="primary" onClick={submit} disabled={busy}>
            {busy ? "Создание…" : mode === "A" ? "Создать и загрузить текст" : mode === "B" ? "Создать и начать интервью" : "Распознать диаграмму и создать сессию"}
          </button>
        </div>
      </div>
    </div>
  );
}
