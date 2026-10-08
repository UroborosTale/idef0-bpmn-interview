import type { ProcessFlow, ProcessLogicModel, ProcessNode } from "../../types";
import type { Artifact } from "@shared/bpmnArtifacts";
import { eventSpec, scaleGlyphs, triggerGlyph, triggerSummary, type TriggerType } from "@shared/events";
import { MARKER_R, markerCenters, type TriggerMarker } from "@shared/bpmnTriggers";
import { LANE_H, LANE_X, LABEL_W, flowLabelPoint, laneCount, laneTop, waypoints, wrapText, type Box, type EndKinds, type Pt } from "./geometry";

const INK = "#1e293b";
const ACCENT = "#4338ca";

/** Значок триггера события; у выбрасывающих событий (throwing) он залит, у ждущих — только контур. */
function EventGlyph({ cx, cy, trigger, throwing, k = 1 }: { cx: number; cy: number; trigger: TriggerType; throwing: boolean; k?: number }) {
  const glyphs = k === 1 ? triggerGlyph(trigger, throwing) : scaleGlyphs(triggerGlyph(trigger, throwing), k);
  if (glyphs.length === 0) return null;
  return (
    <g data-trigger={trigger} data-throwing={throwing || undefined} strokeLinejoin="round" pointerEvents="none">
      {glyphs.map((g, i) => {
        const fill = g.filled ? INK : "none";
        const stroke = g.kind === "poly" && g.light ? "#fff" : INK;
        if (g.kind === "circle") return <circle key={i} cx={cx} cy={cy} r={g.r} fill={fill} stroke={stroke} strokeWidth={1.2} />;
        const d = g.pts.map(([x, y], k) => `${k === 0 ? "M" : "L"}${cx + x} ${cy + y}`).join(" ") + (g.closed ? " Z" : "");
        return <path key={i} d={d} fill={fill} stroke={stroke} strokeWidth={1.2} />;
      })}
    </g>
  );
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

/** Подпись под фигурой; left — подпись левее оси (по правому краю): у фигуры вниз уходит или снизу входит стрелка, и она не должна идти через текст. */
function Label({ cx, y, text, left = false }: { cx: number; y: number; text: string; left?: boolean }) {
  const lines = wrapText(text, 20, 3);
  const x = left ? cx - 8 : cx;
  return (
    <text x={x} y={y} textAnchor={left ? "end" : "middle"} fontSize={11} fill={INK} pointerEvents="none">
      {lines.map((l, i) => (
        <tspan key={i} x={x} dy={i === 0 ? 0 : 13}>
          {l}
        </tspan>
      ))}
    </text>
  );
}

export function NodeShape({ node, box, selected, hot, boundary = false, labelLeft = false, hasMarkers = false }: { node: ProcessNode; box: Box; selected: boolean; hot: boolean; boundary?: boolean; labelLeft?: boolean; hasMarkers?: boolean }) {
  const { x, y, w, h } = box;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const stroke = selected ? ACCENT : hot ? "#16a34a" : INK;
  const sw = selected || hot ? 2.5 : 1.5;
  const dash = node.status === "hypothesis" ? "5 3" : undefined;
  const common = { stroke, strokeWidth: sw, strokeDasharray: dash };

  let body: JSX.Element;
  if (node.type === "event") {
    const spec = eventSpec(node, boundary);
    const isEnd = spec.position === "end";
    const isStart = spec.position === "start";
    body = (
      <g data-event-position={spec.position}>
        <title>{`${spec.trigger === "none" ? "Событие" : triggerSummary(spec)}${spec.position === "intermediate" ? (spec.throwing ? " (выбрасывает)" : " (ждёт)") : ""}`}</title>
        <circle cx={cx} cy={cy} r={w / 2} fill={isStart ? "#f0fdf4" : isEnd ? "#fef2f2" : "#fff"} {...common} strokeWidth={isEnd ? sw + 2 : sw} strokeDasharray={boundary && node.interrupting === false ? "4 3" : dash} />
        {!isStart && !isEnd && <circle cx={cx} cy={cy} r={w / 2 - 4} fill="none" stroke={stroke} strokeWidth={1} strokeDasharray={boundary && node.interrupting === false ? "3 2" : undefined} />}
        <EventGlyph cx={cx} cy={cy} trigger={spec.trigger} throwing={spec.throwing} />
        <Label cx={cx} y={y + h + 14} text={node.name} left={labelLeft} />
      </g>
    );
  } else if (node.type === "gateway") {
    body = (
      <g>
        <path d={`M${cx} ${y} L${x + w} ${cy} L${cx} ${y + h} L${x} ${cy} Z`} fill="#fff" {...common} strokeLinejoin="round" />
        <GatewayGlyph cx={cx} cy={cy} subtype={node.subtype} />
        <Label cx={cx} y={y + h + 14} text={node.name} left={labelLeft} />
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
          <text x={x + (hasMarkers ? 20 : 8)} y={y + 14} fontSize={9} fill="#64748b" pointerEvents="none">
            {{ user: "Польз.", service: "Сервис", manual: "Ручн.", send: "Отпр.", receive: "Получ.", script: "Скрипт", business_rule: "Правила" }[node.subtype] ?? ""}
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

/**
 * Триггеры блока действия: ожидающие события (сообщение, таймер, условие, сигнал), прикреплённые к блоку значками на его границе.
 * Отдельной фигуры и стрелки «событие → блок» нет; щелчок по значку выбирает событие (его свойства — в панели).
 */
export function TriggerMarkers({ box, markers, selectedId }: { box: Box; markers: TriggerMarker[]; selectedId?: string | null }) {
  const centers = markerCenters(box, markers.length);
  return (
    <g>
      {markers.map((mk, i) => {
        const [cx, cy] = centers[i];
        const selected = selectedId === mk.eventId;
        const stroke = selected ? ACCENT : INK;
        return (
          <g key={mk.eventId} data-marker={mk.eventId} style={{ cursor: "pointer" }}>
            <title>{`${mk.name} — ${triggerSummary(mk.spec)}${mk.start ? " (запускает блок)" : " (блок ждёт)"}`}</title>
            <circle cx={cx} cy={cy} r={MARKER_R + 3} fill="transparent" />
            <circle cx={cx} cy={cy} r={MARKER_R} fill={mk.start ? "#f0fdf4" : "#fff"} stroke={stroke} strokeWidth={selected ? 2.2 : 1.3} />
            {!mk.start && <circle cx={cx} cy={cy} r={MARKER_R - 2.5} fill="none" stroke={stroke} strokeWidth={1} />}
            <EventGlyph cx={cx} cy={cy} trigger={mk.spec.trigger} throwing={false} k={0.55} />
          </g>
        );
      })}
    </g>
  );
}
/** Стрелка последовательности; points — готовый маршрут всей диаграммы (routeFlows), иначе маршрут между двумя фигурами. */
export function FlowShape({ flow, points, from, to, obstacles = [], selected, kinds }: { flow: ProcessFlow; points?: Pt[]; from?: Box; to?: Box; obstacles?: Box[]; selected: boolean; kinds?: EndKinds }) {
  const pts = points ?? waypoints(from!, to!, obstacles, kinds);
  const d = pts.map(([px, py], i) => `${i === 0 ? "M" : "L"}${px} ${py}`).join(" ");
  const color = selected ? ACCENT : INK;
  const label = flowLabelPoint(pts);
  const cond = flow.condition?.trim();
  return (
    <g data-flow-id={flow.id} style={{ cursor: "pointer" }}>
      <path d={d} fill="none" stroke="transparent" strokeWidth={14} />
      <path d={d} fill="none" stroke={color} strokeWidth={selected ? 2.5 : 1.5} markerEnd={selected ? "url(#bpe-arrow-sel)" : "url(#bpe-arrow)"} />
      {cond && (
        <g pointerEvents="none">
          <rect x={label.anchor === "middle" ? label.x - cond.length * 3 - 4 : label.x - 3} y={label.y - 11} width={cond.length * 6 + 8} height={15} rx={3} fill="#fff" opacity={0.92} />
          <text x={label.x} y={label.y} textAnchor={label.anchor} fontSize={10.5} fill={color}>
            {cond.length > 28 ? cond.slice(0, 27) + "…" : cond}
          </text>
        </g>
      )}
    </g>
  );
}

const GREY = "#64748b";

/** Документ (вход или выход задачи) или хранилище данных (информационная система) со связью-ассоциацией с задачей. */
export function ArtifactShape({ artifact: a }: { artifact: Artifact }) {
  const { x, y, w, h } = a.box;
  const d = a.edge.map(([px, py], i) => `${i === 0 ? "M" : "L"}${px} ${py}`).join(" ");
  const arrow = a.kind === "store" ? undefined : "url(#bpe-arrow-thin)";
  return (
    <g data-artifact={a.nodeId} data-artifact-kind={a.kind} style={{ cursor: "pointer" }}>
      <title>{`${a.kind === "input" ? "Входной документ" : a.kind === "output" ? "Выходной документ" : "Хранилище данных"}: ${a.name}`}</title>
      <path d={d} fill="none" stroke={GREY} strokeWidth={1} strokeDasharray="2 2" markerEnd={arrow} />
      {a.kind === "store" ? (
        <g fill="#fff" stroke={INK} strokeWidth={1.1}>
          <path d={`M${x} ${y + 5} V${y + h - 5} A${w / 2} 4 0 0 0 ${x + w} ${y + h - 5} V${y + 5}`} />
          <ellipse cx={x + w / 2} cy={y + 5} rx={w / 2} ry={4} />
          <path d={`M${x} ${y + 10} A${w / 2} 4 0 0 0 ${x + w} ${y + 10}`} fill="none" />
        </g>
      ) : (
        <g fill="#fff" stroke={INK} strokeWidth={1.1}>
          <path d={`M${x} ${y} H${x + w - 7} L${x + w} ${y + 7} V${y + h} H${x} Z`} />
          <path d={`M${x + w - 7} ${y} V${y + 7} H${x + w}`} fill="none" />
        </g>
      )}
      <text x={x + w / 2} y={y - 3} textAnchor="middle" fontSize={8} fill={GREY} pointerEvents="none">
        {a.name.length > 14 ? a.name.slice(0, 13) + "…" : a.name}
      </text>
    </g>
  );
}

/** Свёрнутый внешний пул — другой процесс или внешний участник; потоки сообщений ведут к нему от шагов. */
export function PoolShape({ pool, box }: { pool: { id: string; name: string; code?: string | null }; box: Box }) {
  const text = `${pool.code ? `${pool.code} ` : ""}${pool.name}`;
  const lines = wrapText(text, 26, 2);
  return (
    <g data-pool-id={pool.id}>
      <title>{text}</title>
      <rect x={box.x} y={box.y} width={box.w} height={box.h} fill="#f8fafc" stroke={INK} strokeWidth={1.5} />
      <rect x={box.x} y={box.y} width={22} height={box.h} fill="#e2e8f0" stroke={INK} strokeWidth={1.5} />
      <text textAnchor="middle" fontSize={10.5} fill={INK} pointerEvents="none">
        {lines.map((l, i) => (
          <tspan key={i} x={box.x + 22 + (box.w - 22) / 2} y={box.y + box.h / 2 + 4 - ((lines.length - 1) * 6.5) + i * 13}>
            {l}
          </tspan>
        ))}
      </text>
    </g>
  );
}

/** Поток сообщений: пунктирная линия, кружок у отправителя и открытая стрелка у получателя. */
export function MessageShape({ points, label }: { points: [number, number][]; label?: string | null }) {
  const d = points.map(([px, py], i) => `${i === 0 ? "M" : "L"}${px} ${py}`).join(" ");
  const [sx, sy] = points[0];
  const i = Math.floor((points.length - 1) / 2);
  const mx = (points[i][0] + points[i + 1][0]) / 2;
  const my = (points[i][1] + points[i + 1][1]) / 2;
  return (
    <g>
      <path d={d} fill="none" stroke={INK} strokeWidth={1.3} strokeDasharray="6 4" markerEnd="url(#bpe-arrow-open)" />
      <circle cx={sx} cy={sy} r={3.5} fill="#fff" stroke={INK} strokeWidth={1.2} />
      {label && (
        <text x={mx + 5} y={my - 3} fontSize={9.5} fill={INK} pointerEvents="none">
          {label.length > 28 ? label.slice(0, 27) + "…" : label}
        </text>
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
      <marker id="bpe-arrow-thin" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
        <path d="M1 1 L9 5 L1 9" fill="none" stroke={GREY} strokeWidth="1.4" />
      </marker>
      <marker id="bpe-arrow-open" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto">
        <path d="M1 1 L9 5 L1 9" fill="none" stroke={INK} strokeWidth="1.4" />
      </marker>
      <marker id="bpe-arrow-sel" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
        <path d="M0 0 L10 5 L0 10 z" fill={ACCENT} />
      </marker>
    </defs>
  );
}
