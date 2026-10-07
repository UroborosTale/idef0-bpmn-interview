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
  onActual,
  dirty,
  busy,
  hint,
  onSave,
  extra,
  compact = false,
}: {
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  zoom: number;
  onZoomOut: () => void;
  onZoomIn: () => void;
  onFit: () => void;
  /** Масштаб 100% — для чтения подписей на большой диаграмме. */
  onActual?: () => void;
  dirty: boolean;
  busy: boolean;
  hint: string | null;
  onSave: () => void;
  extra?: ReactNode;
  /** В окне студии история и сохранение — на общей панели студии, здесь остаются только масштаб и кнопки редактора. */
  compact?: boolean;
}) {
  return (
    <div className="bpe-toolbar">
      {!compact && (
        <>
          <button onClick={onUndo} disabled={!canUndo} title="Отменить (Ctrl+Z)">
            ↶ Отменить
          </button>
          <button onClick={onRedo} disabled={!canRedo} title="Повторить (Ctrl+Y)">
            ↷ Повторить
          </button>
          <span className="bpe-sep" />
        </>
      )}
      <button onClick={onZoomOut}>−</button>
      <span className="muted" style={{ minWidth: 42, textAlign: "center" }}>
        {Math.round(zoom * 100)}%
      </span>
      <button onClick={onZoomIn}>+</button>
      <button onClick={onFit}>Вписать</button>
      {onActual && (
        <button onClick={onActual} title="Масштаб 100%">
          100%
        </button>
      )}
      {extra && <span className="bpe-sep" />}
      {extra}
      <div className="spacer" />
      {hint && <span className="bpe-hint">{hint}</span>}
      {!compact && dirty && <span className="bpe-dirty">● Есть несохранённые изменения</span>}
      {!compact && (
        <button className="primary" disabled={!dirty || busy} onClick={onSave} title="Сохранить (Ctrl+S)">
          {busy ? "Сохранение…" : "Сохранить"}
        </button>
      )}
    </div>
  );
}
