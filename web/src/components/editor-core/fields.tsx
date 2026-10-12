import { useEffect, useId, useRef, useState } from "react";
import type { View } from "./hooks";

/** Поле, которое фиксирует значение по потере фокуса/Enter — одна правка = один шаг undo. */
export function CommitInput({ value, onCommit, placeholder, multiline, required, rows }: { value: string; onCommit: (v: string) => void; placeholder?: string; multiline?: boolean; required?: boolean; rows?: number }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const commit = () => {
    if (required && !v.trim()) setV(value); // пустое значение не принимается — возвращаем прежнее
    else if (v !== value) onCommit(v);
  };
  if (multiline) {
    return <textarea rows={rows ?? 3} value={v} placeholder={placeholder} onChange={(e) => setV(e.target.value)} onBlur={commit} />;
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
        : "Есть несохранённый черновик, сделанный до того, как модель изменилась в другом месте (другая вкладка браузера, повторная обработка текста, откат версии)."}
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

/**
 * Поле панели: подпись связана с первым полем ввода внутри (для экранного диктора и для поиска по подписи),
 * а составные поля (списки чипов) получают role="group" с именем по подписи.
 */
export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const control = box.current?.querySelector<HTMLElement>("input, select, textarea");
    const lab = box.current?.querySelector("label");
    if (control && !control.id) control.id = `${id}-control`;
    // поле ввода есть — подпись связана с ним; иначе (чипы, списки) именем помечается вся группа
    const wrap = box.current;
    if (control) {
      lab?.setAttribute("for", control.id);
      wrap?.removeAttribute("role");
      wrap?.removeAttribute("aria-labelledby");
    } else {
      lab?.removeAttribute("for");
      wrap?.setAttribute("role", "group");
      wrap?.setAttribute("aria-labelledby", `${id}-label`);
    }
  });
  return (
    <div className="bpe-field" ref={box}>
      <label id={`${id}-label`}>{label}</label>
      {children}
    </div>
  );
}

/** Поле переименования поверх холста, по центру фигуры (box — в мировых координатах). */
export function RenameOverlay({
  name,
  box,
  view,
  onCommit,
  onDone,
  allowEmpty,
  placeholder,
}: {
  name: string;
  box: { x: number; y: number; w: number; h: number };
  view: View;
  onCommit: (value: string) => void;
  onDone: () => void;
  /** Пустое значение тоже сохраняется (условие ветки можно стереть); по умолчанию пустой ввод отменяет правку. */
  allowEmpty?: boolean;
  placeholder?: string;
}) {
  return (
    <input
      className="bpe-rename"
      autoFocus
      defaultValue={name}
      placeholder={placeholder}
      onFocus={(e) => e.currentTarget.select()}
      style={{
        left: view.tx + (box.x + box.w / 2) * view.k,
        top: view.ty + (box.y + box.h / 2) * view.k,
        width: Math.max(150, box.w * view.k),
      }}
      onBlur={(e) => {
        const v = e.currentTarget.value.trim();
        if ((v || allowEmpty) && v !== name) onCommit(v);
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
