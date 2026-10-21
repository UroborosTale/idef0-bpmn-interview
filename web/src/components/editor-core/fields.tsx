import { useEffect, useId, useRef, useState } from "react";
import type { View } from "./hooks";

/** Поле, которое фиксирует значение по паузе в наборе, потере фокуса или Enter — одна правка = один шаг undo. */
export function CommitInput({ value, onCommit, placeholder, multiline, required, rows }: { value: string; onCommit: (v: string) => void; placeholder?: string; multiline?: boolean; required?: boolean; rows?: number }) {
  const [v, setV] = useState(value);
  const vRef = useRef(v);
  vRef.current = v;
  const valueRef = useRef(value);
  valueRef.current = value;
  const doneRef = useRef(onCommit);
  doneRef.current = onCommit;
  const focused = useRef(false);
  const timer = useRef<number | null>(null);

  // значение из модели приходит после сохранения: пока поле в фокусе, не затираем набранное
  useEffect(() => {
    if (!focused.current) setV(value);
  }, [value]);
  useEffect(() => () => clearTimer(timer), []);

  /** Зафиксировать набранное: без паузы и без потери фокуса правка считалась бы несохранённой. */
  const commit = (raw?: string) => {
    clearTimer(timer);
    const next = raw ?? vRef.current;
    if (required && !next.trim()) {
      setV(valueRef.current); // пустое значение не принимается — возвращаем прежнее
      return;
    }
    if (next !== valueRef.current) doneRef.current(next);
  };
  /** Набор: правка попадает в модель через короткую паузу, чтобы не плодить шаги undo на каждую букву. */
  const change = (next: string) => {
    setV(next);
    clearTimer(timer);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      commit(next);
    }, 400);
  };
  const blur = () => {
    focused.current = false;
    commit();
  };
  if (multiline) {
    return (
      <textarea
        rows={rows ?? 3}
        value={v}
        placeholder={placeholder}
        onChange={(e) => change(e.target.value)}
        onFocus={() => (focused.current = true)}
        onBlur={blur}
        onKeyDown={(e) => {
          // Ctrl+S сохраняет модель вместе с набранным — поле фиксируется до обработчика студии
          if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === "s" || e.code === "KeyS")) commit();
        }}
      />
    );
  }
  return (
    <input
      value={v}
      placeholder={placeholder}
      onChange={(e) => change(e.target.value)}
      onFocus={() => (focused.current = true)}
      onBlur={blur}
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === "s" || e.code === "KeyS")) commit();
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          clearTimer(timer);
          setV(valueRef.current);
        }
      }}
    />
  );
}

/** Снять отложенную фиксацию поля (общая для обоих видов ввода). */
function clearTimer(ref: { current: number | null }) {
  if (ref.current !== null) {
    window.clearTimeout(ref.current);
    ref.current = null;
  }
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
  left,
  right,
}: {
  name: string;
  box: { x: number; y: number; w: number; h: number };
  view: View;
  onCommit: (value: string) => void;
  onDone: () => void;
  /** Пустое значение тоже сохраняется (условие ветки можно стереть); по умолчанию пустой ввод отменяет правку. */
  allowEmpty?: boolean;
  placeholder?: string;
  /** Границы дорожки в координатах модели: поле не выходит за них (D9). */
  left?: number;
  right?: number;
}) {
  const desired = Math.max(150, box.w * view.k);
  const lo = left === undefined ? -Infinity : view.tx + left * view.k + 4;
  const hi = right === undefined ? Infinity : view.tx + right * view.k - 4;
  const width = Number.isFinite(lo) || Number.isFinite(hi) ? Math.max(80, Math.min(desired, hi - lo)) : desired;
  const centre = view.tx + (box.x + box.w / 2) * view.k;
  const clamped = Math.min(Math.max(centre, lo + width / 2), hi - width / 2);
  return (
    <input
      className="bpe-rename"
      autoFocus
      defaultValue={name}
      placeholder={placeholder}
      onFocus={(e) => e.currentTarget.select()}
      style={{
        left: clamped,
        top: view.ty + (box.y + box.h / 2) * view.k,
        width,
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
