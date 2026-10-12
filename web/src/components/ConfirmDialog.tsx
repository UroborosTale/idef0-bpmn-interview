import { useEffect, useRef } from "react";

/** Модальное подтверждение вместо window.confirm. Esc — отмена, Enter — подтвердить; фокус сразу на безопасной кнопке «Отмена». */
export default function ConfirmDialog({
  title,
  text,
  confirmLabel,
  danger,
  onConfirm,
  onClose,
}: {
  title: string;
  text: React.ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => cancel.current?.focus(), []);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()} onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <h3>{title}</h3>
        <div className="modal-text">{text}</div>
        <div className="modal-actions">
          <button ref={cancel} onClick={onClose}>
            Отмена
          </button>
          <button className={danger ? "primary danger-fill" : "primary"} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
