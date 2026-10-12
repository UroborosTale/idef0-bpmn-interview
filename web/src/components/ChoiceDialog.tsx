import { useEffect, useRef, useState } from "react";

export interface Choice {
  id: string;
  title: string;
  /** Вторая строка: синонимы, описание, где используется. */
  details?: string;
}

/**
 * Модальное окно выбора одного варианта из списка с поиском: слияние дублей, замена удаляемого объекта.
 * Esc — закрыть, Enter — подтвердить выбранное, щелчок по затемнению — закрыть. Вариантов может быть много — список прокручивается.
 */
export default function ChoiceDialog({
  title,
  description,
  choices,
  confirmLabel,
  danger,
  emptyText,
  preview,
  onConfirm,
  onClose,
}: {
  title: string;
  description?: React.ReactNode;
  choices: Choice[];
  confirmLabel: string;
  danger?: boolean;
  emptyText?: string;
  /** Что произойдёт при выбранном варианте — показывается под списком. */
  preview?: (choice: Choice) => React.ReactNode;
  onConfirm: (choice: Choice) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => search.current?.focus(), []);

  const q = query.trim().toLowerCase();
  const shown = q ? choices.filter((c) => `${c.title} ${c.details ?? ""}`.toLowerCase().includes(q)) : choices;
  const chosen = choices.find((c) => c.id === selected) ?? null;
  const confirm = () => chosen && onConfirm(chosen);

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
        if (e.key === "Enter" && chosen && !(e.target instanceof HTMLButtonElement)) confirm();
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <h3>{title}</h3>
        {description && <div className="modal-text">{description}</div>}
        {choices.length === 0 ? (
          <p className="muted">{emptyText ?? "Выбрать не из чего."}</p>
        ) : (
          <>
            <input ref={search} className="modal-search" placeholder="Поиск…" value={query} onChange={(e) => setQuery(e.target.value)} />
            <ul className="modal-list" role="listbox">
              {shown.length === 0 && <li className="muted">Ничего не найдено.</li>}
              {shown.map((c) => (
                <li key={c.id} role="option" aria-selected={c.id === selected} className={c.id === selected ? "selected" : ""} onClick={() => setSelected(c.id)} onDoubleClick={() => onConfirm(c)}>
                  <b>{c.title}</b>
                  {c.details && <div className="muted">{c.details}</div>}
                </li>
              ))}
            </ul>
            {chosen && preview && <div className="modal-preview">{preview(chosen)}</div>}
          </>
        )}
        <div className="modal-actions">
          <button onClick={onClose}>Отмена</button>
          <button className={danger ? "primary danger-fill" : "primary"} disabled={!chosen} onClick={confirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
