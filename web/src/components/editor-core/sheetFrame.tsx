import { FRAME_GRID, FRAME_MIN_H, FRAME_MIN_W, SHEET_FORMATS, frameShown, gridShown, sheetFormatOf, type FrameGeometry, type IdefFrame } from "@shared/idef0Frame";
import type { FramePatch } from "./sheet-ops";

/**
 * Рамка листа диаграммы (общая для редакторов IDEF0 и BPMN): слой рисования, меню «Лист» и расчёт перетаскивания.
 * Геометрия и настройки — `shared/idef0Frame.ts`; она же рисует SVG-выгрузки, поэтому на экране и в файле лист совпадает.
 */

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, Math.max(1, n - 1)) + "…" : s);

/** Края и углы листа: id, курсор, доля положения по x и y (0 — левый/верхний, 1 — правый/нижний, 0.5 — вдоль края). */
const EDGES: [string, string, number, number][] = [
  ["n", "ns-resize", 0.5, 0],
  ["s", "ns-resize", 0.5, 1],
  ["w", "ew-resize", 0, 0.5],
  ["e", "ew-resize", 1, 0.5],
  ["nw", "nwse-resize", 0, 0],
  ["ne", "nesw-resize", 1, 0],
  ["sw", "nesw-resize", 0, 1],
  ["se", "nwse-resize", 1, 1],
];

/**
 * Рамка листа: клетчатое поле, контур, штамп (NODE / TITLE / NO.). Надписи штампа правятся двойным щелчком, лист растягивают за
 * край или угол и двигают за штамп. layers: "back" — только белая подложка (под дорожками BPMN), "front" — сетка, контур, штамп и
 * ручки поверх дорожек, но под фигурами; по умолчанию — всё сразу (IDEF0, где дорожек нет).
 */
export function FrameLayer({ geo, grid, layers = "all" }: { geo: FrameGeometry; grid: boolean; layers?: "all" | "back" | "front" }) {
  const { sheet, footer } = geo;
  const back = layers !== "front";
  const front = layers !== "back";
  return (
    <g data-frame={front ? "" : undefined} data-frame-back={layers === "back" ? "" : undefined}>
      {back && <rect x={sheet.x} y={sheet.y} width={sheet.w} height={sheet.h} fill="#fff" pointerEvents="none" />}
      {front && (
        <>
          {grid && (
            <g data-frame-grid pointerEvents="none">
              {geo.gridXs.map((l) => (
                <line key={`x${l.at}`} x1={l.at} y1={sheet.y} x2={l.at} y2={footer.y} stroke={l.major ? "#cfd4dc" : "#e3e6eb"} strokeWidth={0.7} />
              ))}
              {geo.gridYs.map((l) => (
                <line key={`y${l.at}`} x1={sheet.x} y1={l.at} x2={sheet.x + sheet.w} y2={l.at} stroke={l.major ? "#cfd4dc" : "#e3e6eb"} strokeWidth={0.7} />
              ))}
            </g>
          )}
          <rect x={footer.x} y={footer.y} width={footer.w} height={footer.h} fill="#e8eef9" stroke="#1f2937" strokeWidth={1} pointerEvents="none" />
          {geo.dividers.map((x) => (
            <line key={x} x1={x} y1={footer.y} x2={x} y2={footer.y + footer.h} stroke="#1f2937" strokeWidth={1} pointerEvents="none" />
          ))}
          <rect x={sheet.x} y={sheet.y} width={sheet.w} height={sheet.h} fill="none" stroke="#1f2937" strokeWidth={1.2} pointerEvents="none" />
          {/* лист двигают за штамп, а растягивают за любой край и угол */}
          <rect data-frame-move x={footer.x} y={footer.y} width={footer.w} height={footer.h} fill="transparent" style={{ cursor: "move" }}>
            <title>Потяните штамп, чтобы подвинуть лист</title>
          </rect>
          {EDGES.map(([id, cursor, fx, fy]) => (
            <rect
              key={id}
              data-frame-resize={id}
              x={fx === 0.5 ? sheet.x + 6 : sheet.x + fx * sheet.w - 5}
              y={fy === 0.5 ? sheet.y + 6 : sheet.y + fy * sheet.h - 5}
              width={fx === 0.5 ? sheet.w - 12 : 10}
              height={fy === 0.5 ? sheet.h - 12 : 10}
              fill={id.length === 2 ? "#94a3b8" : "transparent"}
              opacity={id.length === 2 ? 0.55 : 1}
              style={{ cursor }}
            >
              <title>Потяните, чтобы изменить размер листа</title>
            </rect>
          ))}
          {geo.cells.map((c) => (
            <g key={c.field} data-frame-field={c.field} style={{ cursor: "text" }}>
              <title>Двойной щелчок — изменить надпись</title>
              <rect x={c.x} y={c.y} width={c.w} height={c.h} fill="transparent" />
              <text x={c.tx} y={c.y + c.h / 2 + 5} textAnchor={c.anchor} fontSize={15} fontFamily="Arial, sans-serif" fill="#111827" pointerEvents="none">
                {clip(c.text, Math.floor(c.w / 8))}
              </text>
            </g>
          ))}
        </>
      )}
    </g>
  );
}

/** Прямоугольник листа (поле без штампа). */
export interface SheetRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Жест над листом: за что взялись (move — штамп, иначе край или угол: n, s, e, w, ne, nw, se, sw) и каким был лист. */
export interface FrameDrag {
  edge: string;
  r0: SheetRect;
  x0: number;
  y0: number;
  moved: boolean;
}

/** Если щёлкнули по штампу, краю или углу листа — начало жеста, иначе null. */
export function startFrameDrag(target: Element, at: [number, number], geo: FrameGeometry): FrameDrag | null {
  const el = target.closest("[data-frame-resize], [data-frame-move], [data-frame-field]");
  if (!el) return null;
  return {
    edge: el.getAttribute("data-frame-resize") ?? "move",
    r0: { x: geo.sheet.x, y: geo.sheet.y, w: geo.sheet.w, h: geo.footer.y - geo.sheet.y },
    x0: at[0],
    y0: at[1],
    moved: false,
  };
}

/** Лист после сдвига указателя на (dx, dy): положение и размер кратны клетке, меньше минимума лист не делают; противоположная сторона стоит на месте. */
export function dragRect(d: Pick<FrameDrag, "edge" | "r0">, dx: number, dy: number): SheetRect {
  const grid = (v: number) => Math.round(v / FRAME_GRID) * FRAME_GRID;
  const { x, y, w, h } = d.r0;
  if (d.edge === "move") return { x: grid(x + dx), y: grid(y + dy), w, h };
  const r = { x, y, w, h };
  if (d.edge.includes("e")) r.w = Math.max(FRAME_MIN_W, grid(w + dx));
  if (d.edge.includes("s")) r.h = Math.max(FRAME_MIN_H, grid(h + dy));
  if (d.edge.includes("w")) {
    const nx = Math.min(grid(x + dx), x + w - FRAME_MIN_W);
    r.x = nx;
    r.w = x + w - nx;
  }
  if (d.edge.includes("n")) {
    const ny = Math.min(grid(y + dy), y + h - FRAME_MIN_H);
    r.y = ny;
    r.h = y + h - ny;
  }
  return r;
}

/** Меню «Лист» панели инструментов: рамка и сетка, формат (A4, A3, A2), поворот, авторазмер и предупреждение о фигурах вне листа. */
export function FrameMenu({ frame, geo, outside, onChange, shown }: { frame: IdefFrame | undefined; geo: FrameGeometry; outside: number; onChange: (patch: FramePatch) => void; /** Показана ли рамка; по умолчанию — правило IDEF0 (показана, пока не скрыли). */ shown?: boolean }) {
  const on = shown ?? frameShown(frame);
  const manual = frame?.w !== undefined;
  const format = frame?.w !== undefined && frame?.h !== undefined ? sheetFormatOf(frame.w, frame.h) : null;
  const rectNow = { x: geo.sheet.x, y: geo.sheet.y, w: geo.sheet.w, h: geo.footer.y - geo.sheet.y };
  return (
    <>
      <details className="bpe-menu">
        <summary title="Рамка листа: рамка и сетка, формат, поворот, авторазмер">Лист{outside > 0 ? " ⚠" : ""}</summary>
        <div className="bpe-menu-body">
          <button className={on ? "on" : ""} onClick={() => onChange({ show: !on })} title="Рамка листа со штампом: NODE, TITLE, NO. (надписи правятся двойным щелчком)">
            Рамка
          </button>
          <select
            aria-label="Формат листа"
            disabled={!on}
            value={format?.id ?? (manual ? "custom" : "auto")}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "auto") onChange({ rect: null });
              else {
                const f = SHEET_FORMATS.find((x) => x.id === v);
                if (!f) return;
                const portrait = !!format?.portrait;
                onChange({ rect: { x: rectNow.x, y: rectNow.y, w: portrait ? f.h : f.w, h: portrait ? f.w : f.h } });
              }
            }}
            title="Формат листа: A4, A3 или A2 (поле листа без штампа); «Авто» — лист по размеру диаграммы"
          >
            <option value="auto">Лист: авто</option>
            {manual && !format && <option value="custom">Лист: свой размер</option>}
            {SHEET_FORMATS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
                {format?.id === f.id ? (format.portrait ? " книжная" : " альбомная") : ""}
              </option>
            ))}
          </select>
          <button disabled={!on || !manual} onClick={() => onChange({ rect: { x: rectNow.x, y: rectNow.y, w: rectNow.h, h: rectNow.w } })} title="Повернуть лист: альбомная ↔ книжная">
            ⟳
          </button>
          <button disabled={!on || !manual} onClick={() => onChange({ rect: null })} title="Вернуть лист на всю диаграмму: размер и положение снова автоматические">
            Авторазмер
          </button>
          <button className={on && gridShown(frame) ? "on" : ""} disabled={!on} onClick={() => onChange({ grid: !gridShown(frame) })} title="Клетчатая разметка листа">
            Сетка
          </button>
        </div>
      </details>
      {outside > 0 && (
        <span className="bpe-warn" role="status" title="Часть фигур лежит за пределами листа: растяните или подвиньте лист, либо нажмите «Лист: авто»">
          ⚠ Вне листа: {outside}
        </span>
      )}
    </>
  );
}
