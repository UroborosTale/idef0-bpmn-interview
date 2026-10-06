import type { ReactNode } from "react";

/** Общая панель инструментов редакторов: история, масштаб, сохранение; extra — кнопки конкретного редактора. */
export default function EditorToolbar({
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  zoom,
  onZoomOut,
  onZoomIn,
  onFit,
  dirty,
  busy,
  hint,
  onSave,
  extra,
}: {
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  zoom: number;
  onZoomOut: () => void;
  onZoomIn: () => void;
  onFit: () => void;
  dirty: boolean;
  busy: boolean;
  hint: string | null;
  onSave: () => void;
  extra?: ReactNode;
}) {
  return (
    <div className="bpe-toolbar">
      <button onClick={onUndo} disabled={!canUndo} title="Отменить (Ctrl+Z)">
        ↶ Отменить
      </button>
      <button onClick={onRedo} disabled={!canRedo} title="Повторить (Ctrl+Y)">
        ↷ Повторить
      </button>
      <span className="bpe-sep" />
      <button onClick={onZoomOut}>−</button>
      <span className="muted" style={{ minWidth: 42, textAlign: "center" }}>
        {Math.round(zoom * 100)}%
      </span>
      <button onClick={onZoomIn}>+</button>
      <button onClick={onFit}>Вписать</button>
      {extra && <span className="bpe-sep" />}
      {extra}
      <div className="spacer" />
      {hint && <span className="bpe-hint">{hint}</span>}
      {dirty && <span className="bpe-dirty">● Есть несохранённые изменения</span>}
      <button className="primary" disabled={!dirty || busy} onClick={onSave} title="Сохранить (Ctrl+S)">
        {busy ? "Сохранение…" : "Сохранить"}
      </button>
    </div>
  );
}
