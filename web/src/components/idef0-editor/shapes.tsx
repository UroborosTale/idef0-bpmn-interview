import { type ResolvedStyle } from "@shared/shapeStyles";
import { FREE_END, tunnelArcs } from "@shared/idef0Layout";
import { wrapText } from "../bpmn-editor/geometry";
import { labelSpec, type Arrow, type FunctionBlock } from "./geometry";

/** Рамка листа (клетки, контур, штамп NODE / TITLE / NO.) — общая с редактором BPMN. */
export { FrameLayer } from "../editor-core/sheetFrame";

const INK = "#000000";
/** Цвет стрелок IDEF0 в Business Studio. */
const ARROW = "#4677bf";
const ACCENT = "#4338ca";

export function Idef0Defs() {
  return (
    <defs>
      <marker id="i0-arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
        <path d="M0,0 L0,6 L9,3 z" fill={ARROW} />
      </marker>
      <marker id="i0-arrow-sel" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
        <path d="M0,0 L0,6 L9,3 z" fill={ACCENT} />
      </marker>
    </defs>
  );
}

export function BlockShape({ fn, selected, hot, style, showCode = true }: { fn: FunctionBlock; selected: boolean; hot: boolean; style?: ResolvedStyle; showCode?: boolean }) {
  const { x, y, w, h } = fn.box;
  const lines = wrapText(fn.node.name || "", 22, 3);
  const stroke = selected ? ACCENT : hot ? "#16a34a" : style?.line ?? INK;
  const size = style?.font_size ?? 12;
  const lh = Math.round((size * 7) / 6);
  const top = y + h / 2 - 6 - ((lines.length - 1) * lh) / 2;
  return (
    <g data-fn-id={fn.node.id} style={{ cursor: "move" }}>
      <rect x={x} y={y} width={w} height={h} fill={style?.fill ?? "#e8eef7"} stroke={stroke} strokeWidth={selected || hot ? 2.6 : 1.6} strokeDasharray={fn.node.status === "hypothesis" ? "6 4" : undefined} />
      <text textAnchor="middle" fontSize={size} fontFamily="Arial, sans-serif" fill={style?.text ?? INK} pointerEvents="none">
        {lines.map((l, i) => (
          <tspan key={i} x={x + w / 2} y={top + i * lh + 4}>
            {l}
          </tspan>
        ))}
      </text>
      {showCode && (
        <text x={x + 6} y={y + h - 6} fontSize={10} fontFamily="Arial, sans-serif" fill="#4b5563" pointerEvents="none">
          {fn.code}
        </text>
      )}
      {fn.hasChildren && (
        // отметка «есть декомпозиция»: клик открывает диаграмму вложенных функций
        <g data-open={fn.node.id} style={{ cursor: "pointer" }}>
          <rect x={x + w - 22} y={y + h - 22} width={16} height={16} fill="#fff" stroke={INK} />
          <path d={`M${x + w - 18},${y + h - 14} H${x + w - 10} M${x + w - 14},${y + h - 18} V${y + h - 10}`} stroke={INK} strokeWidth={1.4} pointerEvents="none" />
        </g>
      )}
    </g>
  );
}

/** Кратчайший отрезок, на котором показывается ручка сдвига (короче — ручку не поставить). */
const MIN_SEG = 28;
const BASE_HANDLE = 5; // половина стороны квадратной ручки на экране, px (в единицах диаграммы пересчитывается по масштабу)

/**
 * Ручки выбранной стрелки: ● конец у блока (на другой блок — перенести стрелку, вдоль стороны — сдвинуть), ◆ свободный конец внешней
 * стрелки, ▮ отрезок (сдвиг поперёк), ■ излом, ◇ подпись. Какое действие — в атрибуте data-ah: «вид|номер».
 */
export function ArrowHandles({ arrow, labelAt, k }: { arrow: Arrow; labelAt: { x: number; y: number } | null; /** Масштаб диаграммы: ручки сохраняют размер на экране, но не больше трёх крат и не меньше 70%. */ k: number }) {
  const u = Math.min(3, Math.max(0.7, 1 / k));
  const HANDLE = BASE_HANDLE * u;
  const pts = arrow.points;
  const free = FREE_END[arrow.kind];
  const freeIdx = free === "start" ? 0 : free === "end" ? pts.length - 1 : -1;
  const linked = arrow.kind === "link" || arrow.kind === "controlLink";
  const blockIdx = arrow.kind === "output" ? 0 : pts.length - 1;
  const stroke = ACCENT;
  const out: React.ReactNode[] = [];

  // отрезки (у внешней стрелки — кроме того, что упирается в свободный конец: им управляет сам конец)
  if (pts.length > 2) {
    for (let i = 0; i + 1 < pts.length; i++) {
      if (free !== undefined && (i === freeIdx || i + 1 === freeIdx)) continue;
      const [a, b] = [pts[i], pts[i + 1]];
      const horizontal = Math.abs(a[1] - b[1]) < 0.5;
      if (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) < MIN_SEG) continue;
      const [mx, my] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      out.push(
        <rect key={`s${i}`} data-ah={`seg|${i}`} x={mx - (horizontal ? HANDLE * 1.3 : HANDLE / 1.6)} y={my - (horizontal ? HANDLE / 1.6 : HANDLE * 1.3)} width={horizontal ? HANDLE * 2.6 : HANDLE / 0.8} height={horizontal ? HANDLE / 0.8 : HANDLE * 2.6} rx={2} fill="#fff" stroke={stroke} strokeWidth={1.4 * u} style={{ cursor: horizontal ? "ns-resize" : "ew-resize" }}>
          <title>Потяните отрезок поперёк</title>
        </rect>
      );
    }
    for (let i = 1; i + 1 < pts.length; i++) {
      out.push(
        <rect key={`c${i}`} data-ah={`corner|${i}`} x={pts[i][0] - HANDLE} y={pts[i][1] - HANDLE} width={HANDLE * 2} height={HANDLE * 2} fill={stroke} stroke="#fff" strokeWidth={u} style={{ cursor: "move" }}>
          <title>Потяните излом; двойной щелчок — убрать</title>
        </rect>
      );
    }
  }

  if (linked) {
    out.push(
      <circle key="eP" data-ah="end|producer" cx={pts[0][0]} cy={pts[0][1]} r={HANDLE + 1.5 * u} fill="#fff" stroke={stroke} strokeWidth={2 * u} style={{ cursor: "grab" }}>
        <title>Источник: потяните вдоль стороны или на другую функцию</title>
      </circle>
    );
  }
  out.push(
    <circle key="eB" data-ah="end|block" cx={pts[blockIdx][0]} cy={pts[blockIdx][1]} r={HANDLE + 1.5 * u} fill="#fff" stroke={stroke} strokeWidth={2 * u} style={{ cursor: "grab" }}>
      <title>{linked ? "Получатель" : "Конец у блока"}: потяните вдоль стороны или на другую функцию (верхняя часть блока — управление)</title>
    </circle>
  );
  if (freeIdx >= 0) {
    const [fx, fy] = pts[freeIdx];
    out.push(
      <path key="eF" data-ah="end|free" d={`M${fx},${fy - HANDLE - 2 * u} L${fx + HANDLE + 2 * u},${fy} L${fx},${fy + HANDLE + 2 * u} L${fx - HANDLE - 2 * u},${fy} Z`} fill="#fff" stroke={stroke} strokeWidth={2 * u} style={{ cursor: "move" }}>
        <title>Свободный конец: потяните, куда нужно</title>
      </path>
    );
  }
  if (labelAt && arrow.label) {
    out.push(
      <path key="lab" data-ah="label|" d={`M${labelAt.x},${labelAt.y - 18 * u} l${4 * u},${4 * u} l${-4 * u},${4 * u} l${-4 * u},${-4 * u} Z`} fill="#fff" stroke={stroke} strokeWidth={1.4 * u} style={{ cursor: "move" }}>
        <title>Потяните подпись</title>
      </path>
    );
  }
  return <g data-arrow-handles>{out}</g>;
}

export function ArrowShape({ arrow, selected, showLabel = true }: { arrow: Arrow; selected: boolean; showLabel?: boolean }) {
  const d = arrow.points.map((p, i) => `${i === 0 ? "M" : "L"}${p[0]},${p[1]}`).join(" ");
  const color = selected ? ACCENT : ARROW;
  const lab = labelSpec(arrow);
  return (
    <g data-arrow-key={arrow.key} style={{ cursor: "pointer" }}>
      <path d={d} fill="none" stroke="transparent" strokeWidth={14} />
      <path d={d} fill="none" stroke={color} strokeWidth={selected ? 2.4 : 1.4} markerEnd={selected ? "url(#i0-arrow-sel)" : "url(#i0-arrow)"} />
      {tunnelArcs(arrow).map((arc, i) => (
        <path key={`t${i}`} data-tunnel d={`M${arc.from[0]},${arc.from[1]} Q${arc.ctl[0]},${arc.ctl[1]} ${arc.to[0]},${arc.to[1]}`} fill="none" stroke={color} strokeWidth={1.4} pointerEvents="none" />
      ))}
      {showLabel && (
        <text x={lab.x} y={lab.y} textAnchor={lab.anchor} fontSize={10.5} fontFamily="Arial, sans-serif" fill={selected ? ACCENT : "#374151"} fontWeight={selected ? 600 : 400} pointerEvents="none">
          {lab.text}
        </text>
      )}
    </g>
  );
}
