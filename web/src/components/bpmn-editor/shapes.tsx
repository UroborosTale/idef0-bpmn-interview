import type { ProcessFlow, ProcessLogicModel, ProcessNode } from "../../types";
import { LANE_H, LANE_X, LABEL_W, labelPoint, laneCount, laneTop, waypoints, wrapText, type Box } from "./geometry";

const INK = "#1e293b";
const ACCENT = "#4338ca";

function EventGlyph({ cx, cy, subtype }: { cx: number; cy: number; subtype?: string }) {
  switch (subtype) {
    case "timer":
      return (
        <g stroke={INK} strokeWidth={1.2} fill="none">
          <circle cx={cx} cy={cy} r={9} />
          <path d={`M${cx} ${cy - 6} V${cy} L${cx + 4} ${cy + 3}`} />
        </g>
      );
    case "message":
      return (
        <g stroke={INK} strokeWidth={1.2} fill="none">
          <rect x={cx - 8} y={cy - 5.5} width={16} height={11} />
          <path d={`M${cx - 8} ${cy - 5.5} L${cx} ${cy + 1} L${cx + 8} ${cy - 5.5}`} />
        </g>
      );
    case "signal":
      return <path d={`M${cx} ${cy - 8} L${cx + 8} ${cy + 6} H${cx - 8} Z`} stroke={INK} strokeWidth={1.2} fill="none" />;
    case "error":
      return <path d={`M${cx - 4} ${cy + 8} L${cx - 2} ${cy - 1} L${cx + 3} ${cy + 2} L${cx + 5} ${cy - 8} L${cx + 2} ${cy - 1} L${cx - 3} ${cy - 3} Z`} stroke={INK} strokeWidth={1.2} fill="none" />;
    default:
      return null;
  }
}

function GatewayGlyph({ cx, cy, subtype }: { cx: number; cy: number; subtype?: string }) {
  const p = { stroke: INK, strokeWidth: 3, fill: "none", strokeLinecap: "round" as const };
  switch (subtype) {
    case "parallel":
      return <path d={`M${cx - 9} ${cy} H${cx + 9} M${cx} ${cy - 9} V${cy + 9}`} {...p} />;
    case "inclusive":
      return <circle cx={cx} cy={cy} r={9} stroke={INK} strokeWidth={2.5} fill="none" />;
    case "event_based":
      return (
        <g stroke={INK} strokeWidth={1.2} fill="none">
          <circle cx={cx} cy={cy} r={10} />
          <circle cx={cx} cy={cy} r={7.5} />
        </g>
      );
    default:
      return <path d={`M${cx - 7} ${cy - 7} L${cx + 7} ${cy + 7} M${cx + 7} ${cy - 7} L${cx - 7} ${cy + 7}`} {...p} />;
  }
}

function Label({ cx, y, text }: { cx: number; y: number; text: string }) {
  const lines = wrapText(text, 20, 3);
  return (
    <text x={cx} y={y} textAnchor="middle" fontSize={11} fill={INK} pointerEvents="none">
      {lines.map((l, i) => (
        <tspan key={i} x={cx} dy={i === 0 ? 0 : 13}>
          {l}
        </tspan>
      ))}
    </text>
  );
}

export function NodeShape({ node, box, selected, hot }: { node: ProcessNode; box: Box; selected: boolean; hot: boolean }) {
  const { x, y, w, h } = box;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const stroke = selected ? ACCENT : hot ? "#16a34a" : INK;
  const sw = selected || hot ? 2.5 : 1.5;
  const dash = node.status === "hypothesis" ? "5 3" : undefined;
  const common = { stroke, strokeWidth: sw, strokeDasharray: dash };

  let body: JSX.Element;
  if (node.type === "event") {
    const isEnd = node.subtype === "end";
    const isStart = node.subtype === "start";
    body = (
      <g>
        <circle cx={cx} cy={cy} r={w / 2} fill={isStart ? "#f0fdf4" : isEnd ? "#fef2f2" : "#fff"} {...common} strokeWidth={isEnd ? sw + 2 : sw} />
        {!isStart && !isEnd && <circle cx={cx} cy={cy} r={w / 2 - 4} fill="none" stroke={stroke} strokeWidth={1} />}
        <EventGlyph cx={cx} cy={cy} subtype={node.subtype} />
        <Label cx={cx} y={y + h + 14} text={node.name} />
      </g>
    );
  } else if (node.type === "gateway") {
    body = (
      <g>
        <path d={`M${cx} ${y} L${x + w} ${cy} L${cx} ${y + h} L${x} ${cy} Z`} fill="#fff" {...common} strokeLinejoin="round" />
        <GatewayGlyph cx={cx} cy={cy} subtype={node.subtype} />
        <Label cx={cx} y={y + h + 14} text={node.name} />
      </g>
    );
  } else {
    const lines = wrapText(node.name || "", 15, 4);
    const top = cy - ((lines.length - 1) * 14) / 2 + 4;
    body = (
      <g>
        <rect x={x} y={y} width={w} height={h} rx={10} fill="#fff" {...common} />
        {node.type === "subprocess" && (
          <g stroke={INK} strokeWidth={1.2} fill="#fff">
            <rect x={cx - 7} y={y + h - 16} width={14} height={14} />
            <path d={`M${cx - 4} ${y + h - 9} H${cx + 4} M${cx} ${y + h - 13} V${y + h - 5}`} fill="none" />
          </g>
        )}
        {node.type === "task" && node.subtype && (
          <text x={x + 8} y={y + 14} fontSize={9} fill="#64748b" pointerEvents="none">
            {{ user: "Польз.", service: "Сервис", manual: "Ручн.", send: "Отпр.", receive: "Получ.", script: "Скрипт" }[node.subtype] ?? ""}
          </text>
        )}
        <text textAnchor="middle" fontSize={12} fill={INK} pointerEvents="none">
          {lines.map((l, i) => (
            <tspan key={i} x={cx} y={top + i * 14}>
              {l}
            </tspan>
          ))}
        </text>
      </g>
    );
  }

  return (
    <g data-node-id={node.id} style={{ cursor: "move" }}>
      {/* прозрачная подложка: область нажатия шире фигуры */}
      <rect x={x - 4} y={y - 4} width={w + 8} height={h + 8} fill="transparent" />
      {body}
    </g>
  );
}

export function FlowShape({ flow, from, to, obstacles, selected }: { flow: ProcessFlow; from: Box; to: Box; obstacles: Box[]; selected: boolean }) {
  const pts = waypoints(from, to, obstacles);
  const d = pts.map(([px, py], i) => `${i === 0 ? "M" : "L"}${px} ${py}`).join(" ");
  const color = selected ? ACCENT : INK;
  const [lx, ly] = labelPoint(pts);
  const cond = flow.condition?.trim();
  return (
    <g data-flow-id={flow.id} style={{ cursor: "pointer" }}>
      <path d={d} fill="none" stroke="transparent" strokeWidth={14} />
      <path d={d} fill="none" stroke={color} strokeWidth={selected ? 2.5 : 1.5} markerEnd={selected ? "url(#bpe-arrow-sel)" : "url(#bpe-arrow)"} />
      {cond && (
        <g pointerEvents="none">
          <rect x={lx - cond.length * 3 - 4} y={ly - 17} width={cond.length * 6 + 8} height={15} rx={3} fill="#fff" opacity={0.92} />
          <text x={lx} y={ly - 6} textAnchor="middle" fontSize={10.5} fill={color}>
            {cond.length > 28 ? cond.slice(0, 27) + "…" : cond}
          </text>
        </g>
      )}
    </g>
  );
}

export const UNASSIGNED_LANE = "__unassigned__";

/** Фон дорожек с подписями; lanes кликабельны только если передан data-атрибут (в редакторе). */
export function LanesLayer({ model, width, hotLane, selectedLaneId }: { model: ProcessLogicModel; width: number; hotLane?: number | null; selectedLaneId?: string | null }) {
  return (
    <>
      {Array.from({ length: laneCount(model) }, (_, i) => {
        const id = model.roles[i]?.id ?? UNASSIGNED_LANE;
        const name = model.roles[i]?.name ?? "Без исполнителя";
        const top = laneTop(i);
        return (
          <g key={id}>
            <rect x={LANE_X} y={top} width={width - LANE_X} height={LANE_H} fill={hotLane === i ? "#eef2ff" : i % 2 ? "#f8fafc" : "#fff"} stroke="#cbd5e1" />
            <g data-lane-id={id} style={{ cursor: "pointer" }}>
              <rect x={LANE_X} y={top} width={LABEL_W} height={LANE_H} fill={selectedLaneId === id ? "#c7d2fe" : "#e2e8f0"} stroke="#cbd5e1" />
              <text
                transform={`translate(${LANE_X + LABEL_W / 2 + 4} ${top + LANE_H / 2}) rotate(-90)`}
                textAnchor="middle"
                fontSize={12}
                fontWeight={600}
                fill="#334155"
                pointerEvents="none"
              >
                {name.length > 20 ? name.slice(0, 19) + "…" : name}
              </text>
            </g>
          </g>
        );
      })}
    </>
  );
}

export function ArrowDefs() {
  return (
    <defs>
      <marker id="bpe-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
        <path d="M0 0 L10 5 L0 10 z" fill={INK} />
      </marker>
      <marker id="bpe-arrow-sel" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
        <path d="M0 0 L10 5 L0 10 z" fill={ACCENT} />
      </marker>
    </defs>
  );
}
