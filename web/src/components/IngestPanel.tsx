import { useRef, useState } from "react";

export default function IngestPanel({
  onIngestText,
  onUploadFile,
  onRun,
  busy,
  hasFragments,
}: {
  onIngestText: (text: string, append: boolean, anonymize: boolean) => Promise<void>;
  onUploadFile: (file: File, append: boolean, anonymize: boolean) => Promise<void>;
  onRun: () => Promise<void>;
  busy: boolean;
  hasFragments: boolean;
}) {
  const [text, setText] = useState("");
  const [append, setAppend] = useState(false);
  const [anonymize, setAnonymize] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <h4 style={{ marginTop: 0 }}>Загрузка текста интервью</h4>
      <textarea
        rows={8}
        placeholder="Вставьте текст интервью (диалог «вопрос–ответ» или сплошной рассказ владельца процесса)…"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="toolbar" style={{ marginTop: 8 }}>
        <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12 }}>
          <input type="checkbox" checked={append} onChange={(e) => setAppend(e.target.checked)} />
          Добавить к уже загруженному (объединить несколько интервью)
        </label>
        <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12 }}>
          <input type="checkbox" checked={anonymize} onChange={(e) => setAnonymize(e.target.checked)} />
          Обезличить ФИО перед отправкой в LLM
        </label>
      </div>
      <div className="toolbar">
        <button
          className="primary"
          disabled={busy || !text.trim()}
          onClick={async () => {
            await onIngestText(text, append, anonymize);
            setText("");
          }}
        >
          Загрузить текст
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".txt,.md,.docx,.pdf"
          style={{ width: "auto" }}
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (file) await onUploadFile(file, append, anonymize);
            if (fileRef.current) fileRef.current.value = "";
          }}
        />
        <div className="spacer" />
        <button className="primary" disabled={busy || !hasFragments} onClick={onRun}>
          {busy ? "Обработка…" : "Построить модель"}
        </button>
      </div>
      <p className="muted" style={{ fontSize: 12 }}>Форматы файлов: .txt, .md, .docx, .pdf (текстовый слой).</p>
    </div>
  );
}
