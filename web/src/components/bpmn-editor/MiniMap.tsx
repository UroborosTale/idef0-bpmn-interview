import type { Box } from "./geometry";

const W = 190;
const MAX_H = 110;
const MIN_H = 50;

export interface MiniMapNode {
  id: string;
  box: Box;
  type: string;
  selected: boolean;
}

/**
 * Миникарта диаграммы: все фигуры уменьшенно и рамка видимой части холста. Щелчок и перетаскивание по карте
 * перемещают видимую часть (точка под курсором становится центром холста).
 */
export default function MiniMap({
  nodes,
  world,
  view,
  size,
  onCenter,
  stamp,
}: {
  nodes: MiniMapNode[];
  /** Размер мира (диаграмма вместе с дорожками), px. */
  world: { w: number; h: number };
  view: { k: number; tx: number; ty: number };
  /** Размер видимой области холста, px. */
  size: { w: number; h: number };
  onCenter: (wx: number, wy: number) => void;
  /** Штамп листа в мировых координатах: миникарта не должна его закрывать (как в Business Studio). */
  stamp?: Box;
}) {
  const maxX = Math.max(world.w, ...nodes.map((n) => n.box.x + n.box.w), 1);
  const maxY = Math.max(world.h, ...nodes.map((n) => n.box.y + n.box.h), 1);
  const s = W / maxX;
  const H = Math.min(MAX_H, Math.max(MIN_H, maxY * s));
  const sc = Math.min(s, H / maxY);

  // положение по умолчанию — правый нижний угол холста (right: 10, bottom: 28 в CSS); если туда попадает
  // штамп листа, поднимаем карту над ним, чтобы правый край штампа оставался виден
  let style: React.CSSProperties | undefined;
  if (stamp) {
    const r = { x: stamp.x * view.k + view.tx, y: stamp.y * view.k + view.ty, w: stamp.w * view.k, h: stamp.h * view.k };
    const x0 = size.w - 10 - W;
    const y0 = size.h - 28 - H;
    if (x0 < r.x + r.w && r.x < x0 + W && y0 < r.y + r.h && r.y < y0 + H) {
      style = { bottom: Math.min(Math.max(28, size.h - r.y + 8), Math.max(28, size.h - H - 4)) };
    }
  }

  const at = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    onCenter((e.clientX - r.left) / sc, (e.clientY - r.top) / sc);
  };
  const vp = { x: -view.tx / view.k, y: -view.ty / view.k, w: size.w / view.k, h: size.h / view.k };

  return (
    <div className="bpe-minimap" data-minimap aria-label="Миникарта" style={style}>
      <svg
        width={W}
        height={H}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          at(e);
        }}
        onPointerMove={(e) => e.buttons === 1 && at(e)}
      >
        {nodes.map((n) => (
          <rect
            key={n.id}
            x={n.box.x * sc}
            y={n.box.y * sc}
            width={Math.max(2, n.box.w * sc)}
            height={Math.max(2, n.box.h * sc)}
            rx={n.type === "event" ? 99 : 1}
            className={`mm-node mm-${n.type}${n.selected ? " mm-sel" : ""}`}
          />
        ))}
        <rect data-minimap-view x={vp.x * sc} y={vp.y * sc} width={Math.max(4, vp.w * sc)} height={Math.max(4, vp.h * sc)} className="mm-view" />
      </svg>
    </div>
  );
}
