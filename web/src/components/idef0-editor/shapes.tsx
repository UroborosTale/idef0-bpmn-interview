import { wrapText } from "../bpmn-editor/geometry";
import { labelSpec, type Arrow, type FunctionBlock } from "./geometry";

const INK = "#1f2937";
const ACCENT = "#4338ca";

export function Idef0Defs() {
  return (
    <defs>
      <marker id="i0-arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
        <path d="M0,0 L0,6 L9,3 z" fill={INK} />
      </marker>
      <marker id="i0-arrow-sel" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
        <path d="M0,0 L0,6 L9,3 z" fill={ACCENT} />
      </marker>
    </defs>
  );
}

export function BlockShape({ fn, selected, hot }: { fn: FunctionBlock; selected: boolean; hot: boolean }) {
  const { x, y, w, h } = fn.box;
  const lines = wrapText(fn.node.name || "", 22, 3);
  const top = y + h / 2 - 6 - ((lines.length - 1) * 14) / 2;
  const stroke = selected ? ACCENT : hot ? "#16a34a" : INK;
  return (
    <g data-fn-id={fn.node.id} style={{ cursor: "move" }}>
      <rect x={x} y={y} width={w} height={h} fill="#eef2ff" stroke={stroke} strokeWidth={selected || hot ? 2.6 : 1.6} strokeDasharray={fn.node.status === "hypothesis" ? "6 4" : undefined} />
      <text textAnchor="middle" fontSize={12} fontFamily="Arial, sans-serif" fill={INK} pointerEvents="none">
        {lines.map((l, i) => (
          <tspan key={i} x={x + w / 2} y={top + i * 14 + 4}>
            {l}
          </tspan>
        ))}
      </text>
      <text x={x + 6} y={y + h - 6} fontSize={10} fontFamily="Arial, sans-serif" fill="#4b5563" pointerEvents="none">
        {fn.code}
      </text>
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

export function ArrowShape({ arrow, selected }: { arrow: Arrow; selected: boolean }) {
  const d = arrow.points.map((p, i) => `${i === 0 ? "M" : "L"}${p[0]},${p[1]}`).join(" ");
  const color = selected ? ACCENT : INK;
  const lab = labelSpec(arrow);
  return (
    <g data-arrow-key={arrow.key} style={{ cursor: "pointer" }}>
      <path d={d} fill="none" stroke="transparent" strokeWidth={14} />
      <path d={d} fill="none" stroke={color} strokeWidth={selected ? 2.4 : 1.4} markerEnd={selected ? "url(#i0-arrow-sel)" : "url(#i0-arrow)"} />
      <text x={lab.x} y={lab.y} textAnchor={lab.anchor} fontSize={10.5} fontFamily="Arial, sans-serif" fill={selected ? ACCENT : "#374151"} fontWeight={selected ? 600 : 400} pointerEvents="none">
        {lab.text}
      </text>
    </g>
  );
}
