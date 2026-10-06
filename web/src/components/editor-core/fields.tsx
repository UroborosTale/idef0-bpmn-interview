import { useEffect, useState } from "react";
import type { View } from "./hooks";

/** Поле, которое фиксирует значение по потере фокуса/Enter — одна правка = один шаг undo. */
export function CommitInput({ value, onCommit, placeholder, multiline }: { value: string; onCommit: (v: string) => void; placeholder?: string; multiline?: boolean }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const commit = () => {
    if (v !== value) onCommit(v);
  };
  if (multiline) {
    return <textarea rows={3} value={v} placeholder={placeholder} onChange={(e) => setV(e.target.value)} onBlur={commit} />;
  }
  return (
    <input
      value={v}
      placeholder={placeholder}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") setV(value);
      }}
    />
  );
}

/** Плашка о восстановленном (или устаревшем) черновике. */
export function DraftBanner({
  restored,
  stale,
  onDiscard,
  onDismiss,
  onRestoreStale,
}: {
  restored: boolean;
  stale: boolean;
  onDiscard: () => void;
  onDismiss: () => void;
  onRestoreStale?: () => void;
}) {
  if (!restored && !stale) return null;
  return (
    <div className="bpe-banner">
      {restored
        ? "Восстановлены несохранённые правки с прошлого раза."
        : "Есть несохранённый черновик, сделанный до того, как модель изменилась в другом месте (другая вкладка, Visio, повторная обработка)."}
      <span className="spacer" />
      {restored && <button onClick={onDiscard}>Отбросить правки</button>}
      {stale && onRestoreStale && (
        <button onClick={onRestoreStale} title="Черновик заменит текущую модель в редакторе; изменения, сделанные в другом месте, будут потеряны при сохранении">
          Применить черновик
        </button>
      )}
      <button onClick={onDismiss}>{stale ? "Отбросить черновик" : "Скрыть"}</button>
    </div>
  );
}

export const Field =({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="bpe-field">
    <label>{label}</label>
    {children}
  </div>
);

/** Поле переименования поверх холста, по центру фигуры (box — в мировых координатах). */
export function RenameOverlay({
  name,
  box,
  view,
  onCommit,
  onDone,
}: {
  name: string;
  box: { x: number; y: number; w: number; h: number };
  view: View;
  onCommit: (value: string) => void;
  onDone: () => void;
}) {
  return (
    <input
      className="bpe-rename"
      autoFocus
      defaultValue={name}
      onFocus={(e) => e.currentTarget.select()}
      style={{
        left: view.tx + (box.x + box.w / 2) * view.k,
        top: view.ty + (box.y + box.h / 2) * view.k,
        width: Math.max(150, box.w * view.k),
      }}
      onBlur={(e) => {
        const v = e.currentTarget.value.trim();
        if (v && v !== name) onCommit(v);
        onDone();
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          e.currentTarget.value = name;
          e.currentTarget.blur();
        }
      }}
    />
  );
}
