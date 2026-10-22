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
  onZoomTo,
  onFitWidth,
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
  /** Выбор масштаба списком, как в Business Studio (U2). */
  onZoomTo?: (zoom: number) => void;
  /** «Ширина»: вписать диаграмму по ширине холста. */
  onFitWidth?: () => void;
  dirty: boolean;
  busy: boolean;
  hint: string | null;
  onSave: () => void;
  extra?: ReactNode;
  /** В окне студии история и сохранение — на общей панели студии, здесь остаются только масштаб и кнопки редактора. */
  compact?: boolean;
}) {
  const percent = Math.round(zoom * 100);
  const presets = [400, 200, 150, 100, 75, 50];
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
      {(onZoomTo || onFitWidth) && (
        <select
          aria-label="Масштаб"
          className="bpe-zoom-select"
          value={presets.includes(percent) ? String(percent) : "current"}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "fit") onFit();
            else if (v === "width") onFitWidth?.();
            else if (v !== "current") onZoomTo?.(Number(v) / 100);
          }}
        >
          {!presets.includes(percent) && (
            <option value="current" hidden>
              {percent}%
            </option>
          )}
          {presets.map((p) => (
            <option key={p} value={p}>
              {p}%
            </option>
          ))}
          <option value="width">Ширина</option>
          <option value="fit">Страница</option>
        </select>
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
