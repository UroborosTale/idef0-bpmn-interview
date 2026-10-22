import type { ProcessFlow, ProcessLogicModel, ProcessNode } from "../../types";
import type { Artifact } from "@shared/bpmnArtifacts";
import { eventSpec, scaleGlyphs, triggerGlyph, triggerSummary, type TriggerType } from "@shared/events";
import { LOOP_LABELS, type LoopKind } from "@shared/loops";
import { styleKindOf, styleOf, type ResolvedStyle, type StyledModel } from "@shared/shapeStyles";
import { TASK_ICON_PAD, taskIcon } from "@shared/taskIcons";

/** Подсказка к значку типа задачи. */
const TASK_TYPE_TITLES: Record<string, string> = { user: "Пользовательская задача", service: "Сервисная задача", manual: "Ручная задача", send: "Отправка сообщения", receive: "Получение сообщения", script: "Сценарий", business_rule: "Бизнес-правило" };
import { MARKER_R, markerCenters, type TriggerMarker } from "@shared/bpmnTriggers";
import { labelSide } from "@shared/bpmnLabels";
import { LANE_X, LABEL_W, LABEL_CHARS, LABEL_LINES, flowLabelPoint, laneCount, laneHeights, laneTop, waypoints, wrapText, type Box, type EndKinds, type Pt } from "./geometry";

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
  const p = { stroke: INK, strokeWidth: 3.2, fill: "none", strokeLinecap: "round" as const };
  switch (subtype) {
    case "parallel":
      return <path d={`M${cx - 9} ${cy} H${cx + 9} M${cx} ${cy - 9} V${cy + 9}`} {...p} />;
    case "inclusive":
      return <circle cx={cx} cy={cy} r={9} stroke={INK} strokeWidth={2.5} fill="none" />;
    case "complex":
      return <path d={`M${cx - 9} ${cy} H${cx + 9} M${cx} ${cy - 9} V${cy + 9} M${cx - 6.5} ${cy - 6.5} L${cx + 6.5} ${cy + 6.5} M${cx + 6.5} ${cy - 6.5} L${cx - 6.5} ${cy + 6.5}`} {...p} strokeWidth={2.2} />;
    case "event_based_start":
      return (
        <g stroke={INK} strokeWidth={1.2} fill="none">
          <circle cx={cx} cy={cy} r={10} />
          <path d={[0, 1, 2, 3, 4].map((i) => `${i === 0 ? "M" : "L"}${cx + 5.5 * Math.sin((i * 2 * Math.PI) / 5)} ${cy - 5.5 * Math.cos((i * 2 * Math.PI) / 5)}`).join(" ") + " Z"} />
        </g>
      );
    case "parallel_event_based":
      return (
        <g stroke={INK} strokeWidth={1.2} fill="none">
          <circle cx={cx} cy={cy} r={10} />
          <path d={`M${cx - 6} ${cy} H${cx + 6} M${cx} ${cy - 6} V${cy + 6}`} strokeWidth={2} />
        </g>
      );
    case "event_based":
      return (
        <g stroke={INK} strokeWidth={1.2} fill="none">
          <circle cx={cx} cy={cy} r={10} />
          <circle cx={cx} cy={cy} r={7.5} />
        </g>
      );
    default:
      return <path d={`M${cx - 8} ${cy - 8} L${cx + 8} ${cy + 8} M${cx + 8} ${cy - 8} L${cx - 8} ${cy + 8}`} {...p} />;
  }
}

/** Оформление шага из модели (shape_styles) с учётом вида; для вида без оформления (не шаг) — undefined. */
export function nodeStyle(m: StyledModel | undefined, node: ProcessNode, boundary = false): ResolvedStyle | undefined {
  const kind = styleKindOf(node, boundary);
  return kind ? styleOf(m, kind) : undefined;
}

/** Подпись фигуры: под ней, а если до линии дорожки места нет — над ней (above). left — подпись левее оси (по правому краю): у фигуры вниз уходит или снизу входит стрелка, и она не должна идти через текст. */
function Label({ box, text, above = false, left = false, color = INK, size = 11 }: { box: Box; text: string; above?: boolean; left?: boolean; color?: string; size?: number }) {
  const lines = wrapText(text, LABEL_CHARS, LABEL_LINES);
  const cx = box.x + box.w / 2;
  const lh = Math.round((size * 13) / 11);
  const x = left ? cx - 8 : cx;
  const y = above ? box.y - 6 - (lines.length - 1) * lh : box.y + box.h + 14;
  const labelW = Math.max(1, ...lines.map((l) => l.length)) * 5.8 + 4;
  const labelH = lines.length * lh + 2;
  const boxX = left ? x - labelW : x - labelW / 2;
  const boxY = y - 10;
  return (
    <g pointerEvents="none">
      <rect x={boxX} y={boxY} width={labelW} height={labelH} fill="#fff" opacity={0.92} pointerEvents="none" />
      <text x={x} y={y} textAnchor={left ? "end" : "middle"} fontSize={size} fill={color} pointerEvents="none">
        {lines.map((l, i) => (
          <tspan key={i} x={x} dy={i === 0 ? 0 : lh}>
            {l}
          </tspan>
        ))}
      </text>
    </g>
  );
}

export function NodeShape({ node, box, selected, hot, boundary = false, labelLeft = false, hasMarkers = false, style, showLabel = true, code, laneBand }: { style?: ResolvedStyle; showLabel?: boolean; code?: string; node: ProcessNode; box: Box; selected: boolean; hot: boolean; boundary?: boolean; labelLeft?: boolean; hasMarkers?: boolean; laneBand?: { top: number; bottom: number } | null }) {
  const { x, y, w, h } = box;
  const cx = x + w / 2;
  const cy = y + h / 2;
  // подпись события или шлюза остаётся в своей дорожке: у фигуры внизу дорожки она уходит наверх
  const above = (node.type === "event" || node.type === "gateway") && labelSide(box, node.name, laneBand) === "above";
  const stroke = selected ? ACCENT : hot ? "#16a34a" : style?.line ?? INK;
  const ink = style?.text ?? INK;
  const size = style?.font_size;
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
        <circle cx={cx} cy={cy} r={w / 2} fill={style?.fill ?? (isStart ? "#99ff66" : isEnd ? "#ff8262" : "#ff9933")} {...common} strokeWidth={isEnd ? sw + 2 : sw} strokeDasharray={boundary && node.interrupting === false ? "4 3" : dash} />
        {!isStart && !isEnd && <circle cx={cx} cy={cy} r={w / 2 - 4} fill="none" stroke={stroke} strokeWidth={1} strokeDasharray={boundary && node.interrupting === false ? "3 2" : undefined} />}
        <EventGlyph cx={cx} cy={cy} trigger={spec.trigger} throwing={spec.throwing} />
        {showLabel && <Label box={box} text={node.name} above={above} left={labelLeft} color={ink} size={size} />}
      </g>
    );
  } else if (node.type === "gateway") {
    body = (
      <g>
        <path d={`M${cx} ${y} L${x + w} ${cy} L${cx} ${y + h} L${x} ${cy} Z`} fill={style?.fill ?? "#ffff99"} {...common} strokeLinejoin="round" />
        <GatewayGlyph cx={cx} cy={cy} subtype={node.subtype} />
        {showLabel && <Label box={box} text={node.name} above={above} left={labelLeft} color={ink} size={size} />}
      </g>
    );
  } else {
    // B4: название целиком — переносим без многоточия и уменьшаем шрифт, пока текст не поместится в фигуру
    let textSize = size ?? 12;
    let lines: string[] = [];
    let lh = 0;
    for (; textSize >= 8; textSize--) {
      const maxChars = Math.max(10, Math.floor((w - 22) / (textSize * 0.52)));
      lines = wrapText(node.name || "", maxChars, 99);
      lh = Math.round((textSize * 7) / 6);
      if (lines.length * lh <= h - 12) break;
    }
    if (textSize < 8) textSize = 8;
    if (lines.length === 0) lines = [""];
    const top = cy - ((lines.length - 1) * lh) / 2 + 4;
    body = (
      <g>
        <rect x={x} y={y} width={w} height={h} rx={10} fill={style?.fill ?? "#e8eef7"} {...common} />
        {node.type === "subprocess" && (
          <g stroke={INK} strokeWidth={1.2} fill="#fff">
            <rect x={cx - 7} y={y + h - 16} width={14} height={14} />
            <path d={`M${cx - 4} ${y + h - 9} H${cx + 4} M${cx} ${y + h - 13} V${y + h - 5}`} fill="none" />
          </g>
        )}
        {(node.type === "task" || node.type === "subprocess") && node.loop && <LoopMark loop={node.loop} cx={cx - (node.type === "subprocess" ? 24 : 0)} cy={y + h - 10} />}
        {code && (
          <text x={x + w - 6} y={y + 13} textAnchor="end" fontSize={9} fill="#64748b" pointerEvents="none" data-step-code>
            {code}
          </text>
        )}
        {node.type === "task" && node.subtype && (
          <g transform={`translate(${x + (hasMarkers ? 24 : TASK_ICON_PAD)} ${y + TASK_ICON_PAD})`} fill="none" stroke={INK} strokeWidth={1} strokeLinecap="round" strokeLinejoin="round" pointerEvents="none" data-task-icon={node.subtype}>
            <title>{TASK_TYPE_TITLES[node.subtype] ?? ""}</title>
            {taskIcon(node.subtype).map((p, i) =>
              p.kind === "ellipse" ? <ellipse key={i} cx={p.cx} cy={p.cy} rx={p.rx} ry={p.ry} /> : <path key={i} d={`M${p.pts.map(([px, py]) => `${px} ${py}`).join(" L")}${p.closed ? " Z" : ""}`} />
            )}
          </g>
        )}
        <text textAnchor="middle" fontSize={textSize} fill={ink} pointerEvents="none">
          {lines.map((l, i) => (
            <tspan key={i} x={cx} y={top + i * lh}>
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
            <circle cx={cx} cy={cy} r={MARKER_R} fill={mk.start ? "#99ff66" : "#ff9933"} stroke={stroke} strokeWidth={selected ? 2.2 : 1.3} />
            {!mk.start && <circle cx={cx} cy={cy} r={MARKER_R - 2.5} fill="none" stroke={stroke} strokeWidth={1} />}
            <EventGlyph cx={cx} cy={cy} trigger={mk.spec.trigger} throwing={false} k={0.55} />
          </g>
        );
      })}
    </g>
  );
}
/** Маркер цикличности внизу блока: круговая стрелка (цикл), три вертикальные (параллельно) или горизонтальные черты (по очереди). */
function LoopMark({ loop, cx, cy }: { loop: LoopKind; cx: number; cy: number }) {
  const title = <title>{LOOP_LABELS[loop]}</title>;
  if (loop === "parallel") return <path d={[-4, 0, 4].map((dx) => `M${cx + dx} ${cy - 5} V${cy + 5}`).join(" ")} stroke={INK} strokeWidth={1.4} fill="none">{title}</path>;
  if (loop === "sequential") return <path d={[-4, 0, 4].map((dy) => `M${cx - 5} ${cy + dy} H${cx + 5}`).join(" ")} stroke={INK} strokeWidth={1.4} fill="none">{title}</path>;
  const r = 5;
  const at = (deg: number) => [cx + r * Math.cos((deg * Math.PI) / 180), cy + r * Math.sin((deg * Math.PI) / 180)];
  const [sx, sy] = at(120);
  const [ex, ey] = at(400);
  return (
    <path d={`M${sx} ${sy} A${r} ${r} 0 1 1 ${ex} ${ey} M${ex - 3} ${ey - 3} L${ex} ${ey} L${ex + 3} ${ey - 3}`} stroke={INK} strokeWidth={1.3} fill="none">
      {title}
    </path>
  );
}

/** Стрелка последовательности; points — готовый маршрут всей диаграммы (routeFlows), иначе маршрут между двумя фигурами. */
export function FlowShape({ flow, points, from, to, obstacles = [], selected, kinds, showLabel = true }: { flow: ProcessFlow; points?: Pt[]; from?: Box; to?: Box; obstacles?: Box[]; selected: boolean; kinds?: EndKinds; showLabel?: boolean }) {
  const pts = points ?? waypoints(from!, to!, obstacles, kinds);
  const d = pts.map(([px, py], i) => `${i === 0 ? "M" : "L"}${px} ${py}`).join(" ");
  const color = selected ? ACCENT : INK;
  const label = flowLabelPoint(pts);
  const cond = flow.condition?.trim();
  return (
    <g data-flow-id={flow.id} style={{ cursor: "pointer" }}>
      <path d={d} fill="none" stroke="transparent" strokeWidth={14} />
      <path d={d} fill="none" stroke={color} strokeWidth={selected ? 2.5 : 1.5} markerEnd={selected ? "url(#bpe-arrow-sel)" : "url(#bpe-arrow)"} />
      {flow.is_default && pts.length > 1 && <DefaultSlash from={pts[0]} to={pts[1]} color={color} />}
      {cond && showLabel && (
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

/** Косая черта у начала стрелки ветки «по умолчанию». */
function DefaultSlash({ from, to, color }: { from: Pt; to: Pt; color: string }) {
  const len = Math.hypot(to[0] - from[0], to[1] - from[1]) || 1;
  const [tx, ty] = [(to[0] - from[0]) / len, (to[1] - from[1]) / len];
  const d = Math.min(14, len / 2);
  const [px, py] = [from[0] + tx * d, from[1] + ty * d];
  const [nx, ny] = [-ty, tx];
  return <path d={`M${px - nx * 5 - tx * 3} ${py - ny * 5 - ty * 3} L${px + nx * 5 + tx * 3} ${py + ny * 5 + ty * 3}`} stroke={color} strokeWidth={1.6} pointerEvents="none" />;
}

const GREY = "#64748b";

/** Документ (вход или выход задачи) или хранилище данных (информационная система) со связью-ассоциацией с задачей. */
export function ArtifactShape({ artifact: a, selected }: { artifact: Artifact; selected?: boolean }) {
  const { x, y, w, h } = a.box;
  const edges = a.links?.length ? a.links.map((l) => l.edge) : [a.edge];
  const d = (pts: [number, number][]) => pts.map(([px, py], i) => `${i === 0 ? "M" : "L"}${px} ${py}`).join(" ");
  const lines = wrapText(a.name, 18, 2);
  const labelW = Math.max(20, Math.max(...lines.map((l) => l.length)) * 5.6 + 6);
  const labelH = lines.length * 12 + 2;
  const lx = x + w + 3;
  const ly = y + h / 2 - labelH / 2 + 10;
  const arrow = a.kind === "store" ? undefined : "url(#bpe-arrow-thin)";
  return (
    <g data-artifact={a.nodeId} data-artifact-kind={a.kind} data-artifact-entity={a.entityId} style={{ cursor: "move" }}>
      <title>{`${a.kind === "input" ? "Входной документ" : a.kind === "output" ? "Выходной документ" : "Хранилище данных"}: ${a.name}`}</title>
      <path d={d(edges[0])} fill="none" stroke={GREY} strokeWidth={1} strokeDasharray="2 2" markerEnd={arrow} />
      {edges.slice(1).map((pts, i) => (
        <path key={`e${i}`} d={d(pts)} fill="none" stroke={GREY} strokeWidth={1} strokeDasharray="2 2" markerEnd={arrow} pointerEvents="none" />
      ))}
      {selected && <rect x={x - 3} y={y - 3} width={w + 6} height={h + 6} rx={3} fill="none" stroke="#2563eb" strokeWidth={1.5} strokeDasharray="3 2" pointerEvents="none" />}
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
      <rect x={lx - 2} y={ly - 11} width={labelW} height={labelH} rx={2} fill="#fff" opacity={0.92} pointerEvents="none" />
      <text x={lx} y={ly} textAnchor="start" fontSize={10} fill={GREY} pointerEvents="none">
        {lines.map((l, i) => (
          <tspan key={i} x={lx} dy={i === 0 ? 0 : 12}>
            {l}
          </tspan>
        ))}
      </text>
    </g>
  );
}

/** Свёрнутый внешний пул — другой процесс или внешний участник; потоки сообщений ведут к нему от шагов. */
export function PoolShape({ pool, box, selected }: { pool: { id: string; name: string; code?: string | null }; box: Box; selected?: boolean }) {
  const text = `${pool.code ? `${pool.code} ` : ""}${pool.name}`;
  const lines = wrapText(text, 26, 2);
  return (
    <g data-pool-id={pool.id} style={{ cursor: "pointer" }}>
      <title>{text}</title>
      <rect x={box.x} y={box.y} width={box.w} height={box.h} fill="#f8fafc" stroke={selected ? "#2563eb" : INK} strokeWidth={selected ? 2.5 : 1.5} />
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
export function MessageShape({ id, points, label, selected }: { id?: string; points: [number, number][]; label?: string | null; selected?: boolean }) {
  const d = points.map(([px, py], i) => `${i === 0 ? "M" : "L"}${px} ${py}`).join(" ");
  const [sx, sy] = points[0];
  const i = Math.floor((points.length - 1) / 2);
  const mx = (points[i][0] + points[i + 1][0]) / 2;
  const my = (points[i][1] + points[i + 1][1]) / 2;
  return (
    <g data-message-id={id} style={id ? { cursor: "pointer" } : undefined}>
      {id && <path d={d} fill="none" stroke="transparent" strokeWidth={12} />}
      <path d={d} fill="none" stroke={selected ? "#2563eb" : INK} strokeWidth={selected ? 2 : 1.3} strokeDasharray="6 4" markerEnd="url(#bpe-arrow-open)" />
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

/** Подпись дорожки: одна строка крупно, если помещается; иначе две строки мельче, с переносом по слову и многоточием. */
function laneLabelLines(name: string, laneH: number): { text: string; size: number }[] {
  if (name.length <= laneH / 8) return [{ text: name, size: 15 }];
  const perLine = Math.max(4, Math.floor(laneH / 6.8));
  const lines: string[] = [];
  let rest = name.trim();
  while (rest && lines.length < 3) {
    if (rest.length <= perLine) {
      lines.push(rest);
      rest = "";
      break;
    }
    const space = rest.lastIndexOf(" ", perLine);
    const cut = space >= Math.ceil(perLine / 2) ? space : perLine;
    lines.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) lines[lines.length - 1] = lines[lines.length - 1].slice(0, Math.max(1, perLine - 1)).trimEnd() + "…";
  return lines.map((text) => ({ text, size: lines.length > 2 ? 10.5 : 11.5 }));
}

/** Фон дорожек с подписями; lanes кликабельны только если передан data-атрибут (в редакторе). */
export function LanesLayer({ model, width, hotLane, selectedLaneId, title }: { model: ProcessLogicModel; width: number; hotLane?: number | null; selectedLaneId?: string | null; title?: string }) {
  const heights = laneHeights(model);
  return (
    <>
      {title && (
        <g data-pool-title>
          <rect x={LANE_X} y={10} width={Math.max(0, width - LANE_X)} height={30} fill="#e8eef7" stroke="#000" strokeWidth={1} />
          <text x={LANE_X + 8} y={30} fontSize={14} fontFamily="Arial, sans-serif" fill="#111827" pointerEvents="none">
            {title}
          </text>
        </g>
      )}
      {Array.from({ length: laneCount(model) }, (_, i) => {
        const id = model.roles[i]?.id ?? UNASSIGNED_LANE;
        const name = model.roles[i]?.name ?? "Без исполнителя";
        const top = laneTop(model, i);
        const laneH = heights[i];
        const lines = laneLabelLines(name, laneH);
        return (
          <g key={id}>
            <rect x={LANE_X} y={top} width={width - LANE_X} height={laneH} fill={hotLane === i ? "#eef2ff" : "#fff"} stroke="#000" strokeWidth={1} />
            <g data-lane-id={id} style={{ cursor: "pointer" }}>
              <rect x={LANE_X} y={top} width={LABEL_W} height={laneH} fill={selectedLaneId === id ? "#c7d2fe" : "#e8eef7"} stroke="#000" strokeWidth={1} />
              {lines.map((line, li) => (
                <text
                  key={li}
                  transform={`translate(${LANE_X + LABEL_W / 2 + (lines.length === 1 ? 5 : lines.length === 2 ? (li === 0 ? 7 : -7) : (1 - li) * 12)} ${top + laneH / 2}) rotate(-90)`}
                  textAnchor="middle"
                  fontSize={line.size}
                  fill={li === 0 ? "#000000" : "#334155"}
                  pointerEvents="none"
                >
                  {line.text}
                </text>
              ))}
            </g>
          </g>
        );
      })}
      {/* правый край дорожек: отдельная линия, чтобы граница не пропадала, когда край совпадает с краем холста (D9) */}
      <line
        data-lane-right
        x1={width - 0.5}
        x2={width - 0.5}
        y1={laneTop(model, 0)}
        y2={laneTop(model, heights.length - 1) + heights[heights.length - 1]}
        stroke="#000"
        strokeWidth={1}
        pointerEvents="none"
      />
    </>
  );
}

/**
 * Ручки изменения высоты дорожек: полоса вдоль нижней границы каждой дорожки, её тянут вверх или вниз. Рисуется поверх фигур и
 * стрелок, чтобы к ручке можно было подобраться и там, где через границу проходит стрелка.
 */
export function LaneResizeHandles({ model, width, activeLane, stretching }: { model: ProcessLogicModel; width: number; activeLane?: number | null; stretching?: boolean }) {
  const heights = laneHeights(model);
  const bottom = laneTop(model, heights.length - 1) + heights[heights.length - 1];
  return (
    <g>
      {/* правый край дорожек: его тянут вправо, чтобы растянуть дорожки в сторону */}
      {stretching && <line x1={width} x2={width} y1={laneTop(model, 0)} y2={bottom} stroke="#4338ca" strokeWidth={2} strokeDasharray="6 4" pointerEvents="none" />}
      <rect data-lane-stretch x={width - 4} y={laneTop(model, 0)} width={8} height={Math.max(0, bottom - laneTop(model, 0))} fill="transparent" style={{ cursor: "ew-resize" }}>
        <title>Потяните правый край, чтобы изменить ширину дорожек</title>
      </rect>
      {heights.map((h, i) => {
        const y = laneTop(model, i) + h;
        return (
          <g key={`lane-resize-${i}`}>
            {activeLane === i && <line x1={LANE_X} x2={width} y1={y} y2={y} stroke="#4338ca" strokeWidth={2} strokeDasharray="6 4" pointerEvents="none" />}
            <rect data-lane-resize={i} x={LANE_X + LABEL_W} y={y - 4} width={Math.max(0, width - LANE_X - LABEL_W)} height={8} fill="transparent" style={{ cursor: "ns-resize" }}>
              <title>Потяните границу, чтобы изменить высоту дорожки</title>
            </rect>
          </g>
        );
      })}
    </g>
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
