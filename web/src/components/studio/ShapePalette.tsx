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
];

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
      {PALETTE.map((p) => (
        <button
          key={p.kind}
          className={`palette-item ${drag?.kind === p.kind ? "dragging" : ""}`}
          title={`${p.title}: перетащите на диаграмму или щёлкните`}
          aria-label={p.title}
          onPointerDown={(e) => {
            e.preventDefault();
            setDrag({ kind: p.kind, x: e.clientX, y: e.clientY });
          }}
        >
          <Glyph kind={p.kind} />
        </button>
      ))}
    </div>
  );
}
