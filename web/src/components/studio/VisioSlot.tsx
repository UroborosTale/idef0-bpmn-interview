import { useEffect, useRef } from "react";
import { postToShell, type VisioDiagram } from "../../desktop";

/**
 * Место холста диаграммы в настольном приложении: оболочка кладёт окно Visio ровно на эту область.
 * Положение и размер (в CSS-пикселях окна) отправляются оболочке при каждом изменении; при уходе со вкладки Visio прячется.
 */
export default function VisioSlot({ sessionId, updatedAt, diagram }: { sessionId: string; updatedAt: string; diagram: VisioDiagram }) {
  const ref = useRef<HTMLDivElement>(null);
  const diagramKey = JSON.stringify(diagram);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let last = "";
    const send = (visible = true) => {
      const r = el.getBoundingClientRect();
      const rect = { x: r.left, y: r.top, w: r.width, h: r.height };
      const msg = JSON.stringify({ visible, rect });
      if (visible && msg === last) return;
      last = msg;
      postToShell({ t: "slot", visible, session: sessionId, updatedAt, diagram, rect });
    };
    send();
    // положение меняется и без изменения размера (ширина навигатора, высота ленты) — сверяем по таймеру
    const timer = window.setInterval(() => send(), 200);
    return () => {
      window.clearInterval(timer);
      send(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, updatedAt, diagramKey]);

  return (
    <div ref={ref} className="visio-slot" data-visio-slot>
      Visio открывается на этом месте…
    </div>
  );
}
