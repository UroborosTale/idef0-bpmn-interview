import { useEffect, useState } from "react";
import { postToShell } from "../../desktop";

/** Фигуры палитры (как в редакторе Business Studio): вид совпадает с мастерами «Фигур документа» в выгрузке Visio. */
export const PALETTE: { kind: string; title: string }[] = [
  { kind: "task", title: "Задача" },
  { kind: "subprocess", title: "Подпроцесс" },
  { kind: "event:start", title: "Начальное событие" },
  { kind: "event:intermediate", title: "Промежуточное событие" },
  { kind: "event:end", title: "Конечное событие" },
  { kind: "gateway:exclusive", title: "Шлюз «или» (исключающий)" },
  { kind: "gateway:parallel", title: "Шлюз «и» (параллельный)" },
  { kind: "gateway:inclusive", title: "Шлюз «или» (включающий)" },
  { kind: "gateway:event_based", title: "Шлюз по событиям" },
];

/** Типы событий, которые можно выбрать у каждого вида события (как в палитре Business Studio). */
export const EVENT_TYPES: Record<string, { type: string; title: string }[]> = {
  start: [{ type: "", title: "Без типа" }, { type: "message", title: "Сообщение" }, { type: "timer", title: "Таймер" }, { type: "conditional", title: "Условие" }, { type: "signal", title: "Сигнал" }],
  intermediate: [{ type: "", title: "Без типа" }, { type: "message", title: "Сообщение" }, { type: "timer", title: "Таймер" }, { type: "conditional", title: "Условие" }, { type: "signal", title: "Сигнал" }, { type: "escalation", title: "Эскалация" }],
  end: [{ type: "", title: "Без типа" }, { type: "message", title: "Сообщение" }, { type: "error", title: "Ошибка" }, { type: "escalation", title: "Эскалация" }, { type: "signal", title: "Сигнал" }],
};

const INK = "#000";

function Glyph({ kind }: { kind: string }) {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" stroke={INK} strokeWidth="1.2" strokeLinejoin="round">
      {kind === "task" && <rect x="2.5" y="5" width="19" height="14" rx="3" fill="#e8eef7" />}
      {kind === "subprocess" && (
        <>
          <rect x="2.5" y="5" width="19" height="14" rx="3" fill="#e8eef7" />
          <rect x="9.5" y="12.5" width="5" height="5" fill="#fff" />
          <path d="M10.5 15h3M12 13.5v3" />
        </>
      )}
      {kind === "event:start" && <circle cx="12" cy="12" r="8.5" fill="#99ff66" />}
      {kind === "event:intermediate" && (
        <>
          <circle cx="12" cy="12" r="8.5" fill="#ff9933" />
          <circle cx="12" cy="12" r="6" fill="none" />
        </>
      )}
      {kind === "event:end" && <circle cx="12" cy="12" r="8.5" fill="#ff8262" strokeWidth="2.6" />}
      {kind === "gateway:exclusive" && (
        <>
          <path d="M12 2.5 21.5 12 12 21.5 2.5 12z" fill="#ffff99" />
          <path d="m8.5 8.5 7 7M15.5 8.5l-7 7" strokeWidth="2" />
        </>
      )}
      {kind === "gateway:inclusive" && (
        <>
          <path d="M12 2.5 21.5 12 12 21.5 2.5 12z" fill="#ffff99" />
          <circle cx="12" cy="12" r="4.5" fill="none" strokeWidth="2" />
        </>
      )}
      {kind === "gateway:event_based" && (
        <>
          <path d="M12 2.5 21.5 12 12 21.5 2.5 12z" fill="#ffff99" />
          <circle cx="12" cy="12" r="5.5" fill="none" />
          <path d="m12 8.8 3 2.2-1.2 3.5h-3.6L9 11z" fill="none" />
        </>
      )}
      {kind === "connector" && <path d="M5 4v8h14v8" fill="none" strokeWidth="1.4" stroke="#4677bf" />}
      {kind === "gateway:parallel" && (
        <>
          <path d="M12 2.5 21.5 12 12 21.5 2.5 12z" fill="#ffff99" />
          <path d="M12 7v10M7 12h10" strokeWidth="2" />
        </>
      )}
    </svg>
  );
}

/**
 * Палитра фигур слева от диаграммы. Фигуру тянут на диаграмму, как в Business Studio: нажать, перенести курсор на место Visio и
 * отпустить — оболочка создаёт фигуру в точке отпускания. Простой щелчок кладёт фигуру в центр видимой части страницы.
 */
export default function ShapePalette() {
  const [drag, setDrag] = useState<{ kind: string; x: number; y: number } | null>(null);
  // выбранный тип события у каждого вида и открытый список типов
  const [types, setTypes] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<string | null>(null);
  const [tool, setTool] = useState<"pointer" | "connector">("pointer");
  const pickTool = (t: "pointer" | "connector") => {
    setTool(t);
    postToShell({ t: "tool", tool: t });
  };

  useEffect(() => {
    if (!drag) return;
    const up = (e: PointerEvent) => {
      const moved = Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 6;
      postToShell({ t: "drop", kind: drag.kind, dragged: moved });
      setDrag(null);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setDrag(null);
    document.addEventListener("pointerup", up);
    document.addEventListener("keydown", esc);
    document.body.style.cursor = "copy";
    return () => {
      document.removeEventListener("pointerup", up);
      document.removeEventListener("keydown", esc);
      document.body.style.cursor = "";
    };
  }, [drag]);

  return (
    <div className="shape-palette" role="toolbar" aria-orientation="vertical" aria-label="Палитра фигур">
      <button className={`palette-item ${tool === "connector" ? "active" : ""}`} title="Соединительная линия: протяните от фигуры к фигуре (ещё раз — вернуться к указателю)" aria-label="Соединительная линия" aria-pressed={tool === "connector"} onClick={() => pickTool(tool === "connector" ? "pointer" : "connector")}>
        <Glyph kind="connector" />
      </button>
      {PALETTE.map((p) => {
        const pos = p.kind.startsWith("event:") ? p.kind.slice(6) : null;
        const type = pos ? types[pos] ?? "" : "";
        const kind = type ? `${p.kind}:${type}` : p.kind;
        const typeTitle = pos ? EVENT_TYPES[pos].find((t) => t.type === type)?.title : null;
        return (
          <div key={p.kind} className="palette-cell">
            <button
              className={`palette-item ${drag?.kind === kind ? "dragging" : ""}`}
              title={`${p.title}${typeTitle && type ? ` — ${typeTitle}` : ""}: перетащите на диаграмму или щёлкните`}
              aria-label={p.title}
              onPointerDown={(e) => {
                e.preventDefault();
                setOpen(null);
                setDrag({ kind, x: e.clientX, y: e.clientY });
              }}
            >
              <Glyph kind={p.kind} />
              {type && <span className="palette-badge">{typeTitle?.slice(0, 2)}</span>}
            </button>
            {pos && (
              <>
                <button className="palette-more" title={`Тип события: ${p.title.toLowerCase()}`} aria-label={`Тип: ${p.title}`} aria-expanded={open === pos} onClick={() => setOpen(open === pos ? null : pos)}>
                  ▸
                </button>
                {open === pos && (
                  <div className="palette-flyout" role="menu">
                    {EVENT_TYPES[pos].map((t) => (
                      <button
                        key={t.type}
                        role="menuitemradio"
                        aria-checked={t.type === type}
                        aria-label={t.title}
                        title={t.title}
                        className={t.type === type ? "on" : ""}
                        onClick={() => {
                          setTypes((x) => ({ ...x, [pos]: t.type }));
                          setOpen(null);
                        }}
                      >
                        {t.type ? t.title.slice(0, 2) : "∅"}
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
