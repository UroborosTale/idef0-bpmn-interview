import JSZip from "jszip";
import type { ProcessLogicModel } from "../types/model.js";
import { generateBpmn, type BpmnDiagramData } from "../pipeline/bpmn.js";
import { arrowLabelPlacement, buildIdef0Diagrams, frameInfo, idef0Codes, type Idef0Block, type Idef0DiagramData } from "../pipeline/idef0.js";
import { BPMN_SHEET_MARGIN, bpmnFrameDefaults, bpmnFrameShown, bpmnSheetWorld, frameGeometry, frameShown, type FrameDefaults, type FrameGeometry, type IdefFrame, FRAME_FONT } from "../shared/idef0Frame.js";
import { tunnelArcs } from "../shared/idef0Layout.js";
import { isStructured, processCodeOf } from "../shared/codes.js";
import { LABEL_W, LANE_X } from "../shared/bpmnGeometry.js";
import { scaleGlyphs, triggerGlyph, type Glyph } from "../shared/events.js";
import { MARKER_R, markerCenters } from "../shared/bpmnTriggers.js";
import { visioFlowProps, visioShapeProps, type VisioPropOut } from "../shared/visioBpmn.js";
import { ownStyle, type StyleKind } from "../shared/shapeStyles.js";
import { TASK_ICON_PAD, taskIcon } from "../shared/taskIcons.js";

/**
 * Экспорт в Microsoft Visio (.vsdx): пакет OPC с XML страниц. Диаграммы строятся из тех же
 * структурированных данных, что и SVG/BPMN-XML: BPMN с дорожками, IDEF0 A-0, A0 и диаграммы
 * вложенных функций — по странице на каждую.
 *
 * Файл — среда редактирования: каждая фигура несёт пользовательские ячейки (User) с id элемента
 * модели, стрелки — настоящие соединители Visio, приклеенные к фигурам. После сохранения в Visio
 * vsdx-import.ts читает файл и возвращает правки в модель.
 */

export const PX = 1 / 96; // пиксель диаграммы → дюймы Visio
const NS = "http://schemas.microsoft.com/office/visio/2012/main";
const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const VISIO_REL = "http://schemas.microsoft.com/visio/2010/relationships";

/** Версия разметки файла: при несовместимом изменении тегов растёт, импорт отвергает чужие версии. */
export const VSDX_FORMAT = "1";

const num = (n: number) => String(Math.round(n * 1e5) / 1e5);
const esc = (s: string) =>
  s
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

type Pt = [number, number];
/** Часть геометрии в локальных пикселях фигуры (начало — левый верхний угол, y вниз). */
type GeomPart = { kind: "path"; pts: Pt[]; closed?: boolean } | { kind: "ellipse"; cx: number; cy: number; rx: number; ry: number };

/** Точка приклейки соединителя: координаты в локальных пикселях фигуры и направление выхода (y вниз). */
export interface Port {
  x: number;
  y: number;
  dx: number;
  dy: number;
}

interface Run {
  text: string;
  fontPx: number;
  color?: string;
  bold?: boolean;
}

interface Style {
  fill?: string | null; // null — без заливки
  line?: string | null; // null — без линии
  weightPt?: number;
  dash?: boolean;
  roundingPx?: number;
  endArrow?: boolean;
  /** Номера наконечников Visio для потоков сообщений: 20 — кружок, 14 — полый треугольник (перекрывают endArrow). */
  beginArrowId?: number;
  endArrowId?: number;
  /** Размер наконечника Visio: 0 — самый мелкий (стрелки IDEF0), по умолчанию 1. */
  arrowSize?: number;
  text?: string;
  runs?: Run[]; // несколько отрезков текста с разным оформлением (вместо text)
  fontPx?: number;
  bold?: boolean;
  color?: string;
  align?: "left" | "center" | "right";
  angle?: number; // радианы, против часовой
  noMargins?: boolean;
  /** Текст вне фигуры: блок шириной w под нижним краем с зазором gap (подписи событий и шлюзов). */
  textBelow?: { w: number; h: number; gap: number };
  /** Теги модели (ячейки User): pm_k — вид элемента, pm_id — id в модели, остальные — по виду. */
  tag?: Record<string, string>;
  /** Ключ для приклейки соединителей. */
  key?: string;
  ports?: Port[];
  /** Данные фигуры (раздел Property): свойства BPMN, как в трафарете Visio; в Visio видны в «Данных фигуры». */
  props?: VisioPropOut[];
}

interface Endpoint {
  key: string;
  port?: number;
}

const userRows = (rows: Record<string, string>) =>
  `<Section N="User">${Object.entries(rows)
    .map(([k, v]) => `<Row N="${k}"><Cell N="Value" V="${esc(v)}" U="STR"/></Row>`)
    .join("")}</Section>`;

/** Раздел Property: каждое свойство — список с текущим значением (Type = 1), как в трафарете «BPMN» Visio. */
const propRows = (props: VisioPropOut[] | undefined) =>
  props?.length
    ? `<Section N="Property">${props
        .map(
          (p) =>
            `<Row N="${p.name}"><Cell N="Value" V="${esc(p.value)}" U="STR"/><Cell N="Prompt" V=""/><Cell N="Label" V="${esc(p.label)}"/><Cell N="Format" V="${esc(p.list.join(";"))}"/><Cell N="SortKey" V=""/><Cell N="Type" V="1"/><Cell N="Invisible" V="0"/><Cell N="Verify" V="0"/><Cell N="DataLinked" V="0"/><Cell N="LangID" V="ru-RU"/><Cell N="Calendar" V="0"/></Row>`
        )
        .join("")}</Section>`
    : "";

export class Page {
  private shapes: string[] = [];
  private connects: string[] = [];
  private nextId = 1;
  private keys = new Map<string, number>();
  /** Фигура мастера трафарета: без служебных меток страницы (их унаследовал бы каждый экземпляр). */
  private master = false;
  constructor(readonly name: string, readonly widthPx: number, readonly heightPx: number, readonly meta: Record<string, string> = {}) {}

  /** Страница-заготовка для мастера: Visio не загружает фигуры мастера с id 1–4, поэтому нумерация с 5. */
  static forMaster(name: string, widthPx: number, heightPx: number): Page {
    const p = new Page(name, widthPx, heightPx);
    p.master = true;
    p.nextId = 5;
    return p;
  }

  /** Страница в дюймах с полем. */
  get widthIn() {
    return Math.max(1, this.widthPx * PX);
  }
  get heightIn() {
    return Math.max(1, this.heightPx * PX);
  }

  /** Id фигуры Visio по ключу; фигуру можно приклеить к соединителю ещё до того, как она нарисована. */
  idOf(key: string): number {
    let id = this.keys.get(key);
    if (id === undefined) {
      id = this.nextId++;
      this.keys.set(key, id);
    }
    return id;
  }

  private geometry(parts: GeomPart[], h: number, ix: number, noFill: boolean): string {
    const lx = (x: number) => num(x * PX);
    const ly = (y: number) => num((h - y) * PX);
    const rows: string[] = [];
    let r = 1;
    for (const p of parts) {
      if (p.kind === "ellipse") {
        rows.push(
          `<Row T="Ellipse" IX="${r++}"><Cell N="X" V="${lx(p.cx)}"/><Cell N="Y" V="${ly(p.cy)}"/><Cell N="A" V="${lx(p.cx + p.rx)}"/><Cell N="B" V="${ly(p.cy)}"/><Cell N="C" V="${lx(p.cx)}"/><Cell N="D" V="${ly(p.cy - p.ry)}"/></Row>`
        );
        continue;
      }
      const pts = p.closed ? [...p.pts, p.pts[0]] : p.pts;
      pts.forEach(([x, y], i) => {
        rows.push(`<Row T="${i === 0 ? "MoveTo" : "LineTo"}" IX="${r++}"><Cell N="X" V="${lx(x)}"/><Cell N="Y" V="${ly(y)}"/></Row>`);
      });
    }
    return `<Section N="Geometry" IX="${ix}"><Cell N="NoFill" V="${noFill ? 1 : 0}"/><Cell N="NoLine" V="0"/><Cell N="NoShow" V="0"/><Cell N="NoSnap" V="0"/><Cell N="NoQuickDrag" V="0"/>${rows.join("")}</Section>`;
  }

  /** Оформление текста: ячейки Character/Paragraph для одного или нескольких отрезков. */
  private textSections(style: Style): { xml: string; text: string } {
    const runs: Run[] = style.runs ?? (style.text ? [{ text: style.text, fontPx: style.fontPx ?? 12, color: style.color, bold: style.bold }] : []);
    if (runs.length === 0) return { xml: "", text: "" };
    const chars = runs
      .map((r, i) => `<Row IX="${i}"><Cell N="Size" V="${num((r.fontPx * 0.75) / 72)}"/><Cell N="Color" V="${r.color ?? "#000000"}"/><Cell N="Style" V="${r.bold ? 1 : 0}"/></Row>`)
      .join("");
    const text = runs.length === 1 ? esc(runs[0].text) : runs.map((r, i) => `<cp IX="${i}"/>${esc(r.text)}`).join("");
    return {
      xml:
        `<Section N="Character">${chars}</Section>` +
        `<Section N="Paragraph"><Row IX="0"><Cell N="HorzAlign" V="${style.align === "left" ? 0 : style.align === "right" ? 2 : 1}"/></Row></Section>`,
      text,
    };
  }

  /** Фигура по bbox (x, y — левый верхний угол в px), основной контур и необязательные символы внутри. */
  add(box: { x: number; y: number; w: number; h: number }, main: GeomPart[], style: Style = {}, extra: GeomPart[] = []): number {
    const id = style.key ? this.idOf(style.key) : this.nextId++;
    const { x, y, w, h } = box;
    const W = w * PX;
    const H = h * PX;
    const pinX = (x + w / 2) * PX;
    const pinY = (this.heightPx - (y + h / 2)) * PX;
    const fill = style.fill === undefined ? "#ffffff" : style.fill;
    const line = style.line === undefined ? "#000000" : style.line;
    const cells: string[] = [
      `<Cell N="PinX" V="${num(pinX)}"/>`,
      `<Cell N="PinY" V="${num(pinY)}"/>`,
      `<Cell N="Width" V="${num(W)}"/>`,
      `<Cell N="Height" V="${num(H)}"/>`,
      `<Cell N="LocPinX" V="${num(W / 2)}" F="Width*0.5"/>`,
      `<Cell N="LocPinY" V="${num(H / 2)}" F="Height*0.5"/>`,
      `<Cell N="Angle" V="${num(style.angle ?? 0)}"/>`,
      `<Cell N="FillForegnd" V="${fill ?? "#ffffff"}"/>`,
      `<Cell N="FillPattern" V="${fill ? 1 : 0}"/>`,
      `<Cell N="LineColor" V="${line ?? "#000000"}"/>`,
      `<Cell N="LinePattern" V="${line ? (style.dash ? 2 : 1) : 0}"/>`,
      `<Cell N="LineWeight" V="${num((style.weightPt ?? 1.2) / 72)}"/>`,
      `<Cell N="Rounding" V="${num((style.roundingPx ?? 0) * PX)}"/>`,
    ];
    if (style.endArrow || style.endArrowId) cells.push(`<Cell N="EndArrow" V="${style.endArrowId ?? 13}"/>`, `<Cell N="EndArrowSize" V="${style.arrowSize ?? 1}"/>`);
    if (style.beginArrowId) cells.push(`<Cell N="BeginArrow" V="${style.beginArrowId}"/>`, `<Cell N="BeginArrowSize" V="${style.arrowSize ?? 1}"/>`);
    if (style.noMargins) cells.push(`<Cell N="LeftMargin" V="0"/>`, `<Cell N="RightMargin" V="0"/>`, `<Cell N="TopMargin" V="0"/>`, `<Cell N="BottomMargin" V="0"/>`);
    if (style.textBelow) {
      // блок текста под фигурой, выровненный по верху: так подпись остаётся частью фигуры и двигается вместе с ней
      const t = style.textBelow;
      cells.push(
        `<Cell N="VerticalAlign" V="0"/>`,
        `<Cell N="TxtPinX" V="${num(W / 2)}" F="Width*0.5"/>`,
        `<Cell N="TxtPinY" V="${num(-(t.gap + t.h / 2) * PX)}"/>`,
        `<Cell N="TxtWidth" V="${num(t.w * PX)}"/>`,
        `<Cell N="TxtHeight" V="${num(t.h * PX)}"/>`,
        `<Cell N="TxtLocPinX" V="${num((t.w / 2) * PX)}" F="TxtWidth*0.5"/>`,
        `<Cell N="TxtLocPinY" V="${num((t.h / 2) * PX)}" F="TxtHeight*0.5"/>`
      );
    }

    const { xml: textXml, text } = this.textSections(style);
    const tag: Record<string, string> = this.master ? { ...style.tag } : { pm_k: "deco", ...style.tag, pm_sid: String(id) };
    const connection = style.ports?.length
      ? `<Section N="Connection">${style.ports
          .map(
            (p, i) =>
              `<Row T="Connection" IX="${i}"><Cell N="X" V="${num(p.x * PX)}" F="Width*${num(p.x / w)}"/><Cell N="Y" V="${num((h - p.y) * PX)}" F="Height*${num((h - p.y) / h)}"/><Cell N="DirX" V="${p.dx}"/><Cell N="DirY" V="${-p.dy}"/><Cell N="Type" V="0"/><Cell N="AutoGen" V="0"/></Row>`
          )
          .join("")}</Section>`
      : "";

    const geom = this.geometry(main, h, 0, main.every((g) => g.kind === "path" && !g.closed) || style.fill === null) + (extra.length ? this.geometry(extra, h, 1, true) : "");
    this.shapes.push(
      `<Shape ID="${id}" NameU="Shape.${id}" Type="Shape" LineStyle="0" FillStyle="0" TextStyle="0">${cells.join("")}${connection}${propRows(style.props)}${userRows(tag)}${textXml}${geom}${text ? `<Text>${text}</Text>` : ""}</Shape>`
    );
    return id;
  }

  rect(x: number, y: number, w: number, h: number, style: Style = {}, extra: GeomPart[] = []) {
    return this.add({ x, y, w, h }, [{ kind: "path", pts: [[0, 0], [w, 0], [w, h], [0, h]], closed: true }], style, extra);
  }
  ellipse(x: number, y: number, w: number, h: number, style: Style = {}, extra: GeomPart[] = []) {
    return this.add({ x, y, w, h }, [{ kind: "ellipse", cx: w / 2, cy: h / 2, rx: w / 2, ry: h / 2 }], style, extra);
  }
  diamond(x: number, y: number, w: number, h: number, style: Style = {}, extra: GeomPart[] = []) {
    return this.add({ x, y, w, h }, [{ kind: "path", pts: [[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]], closed: true }], style, extra);
  }
  /** Ломаная без привязки к фигурам (оформление); при endArrow на конце рисуется стрелка. */
  polyline(points: Pt[], style: Style = {}) {
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    const [minX, minY] = [Math.min(...xs), Math.min(...ys)];
    const [maxX, maxY] = [Math.max(...xs), Math.max(...ys)];
    const local = points.map(([px, py]) => [px - minX, py - minY] as Pt);
    return this.add({ x: minX, y: minY, w: maxX - minX, h: maxY - minY }, [{ kind: "path", pts: local }], { fill: null, ...style });
  }
  /** Только текст (без контура и заливки); anchor задаёт, к какому краю прижат текст. */
  label(text: string, at: { x: number; y: number; anchor?: "start" | "middle" | "end"; w?: number; h?: number }, style: Style = {}) {
    const w = at.w ?? Math.max(24, text.length * (style.fontPx ?? 11) * 0.58);
    const h = at.h ?? (style.fontPx ?? 11) * 1.5;
    const x = at.anchor === "end" ? at.x - w : at.anchor === "middle" || at.anchor === undefined ? at.x - w / 2 : at.x;
    const align = at.anchor === "end" ? "right" : at.anchor === "start" ? "left" : "center";
    return this.rect(x, at.y, w, h, { fill: null, line: null, noMargins: true, align, text, ...style });
  }

  /**
   * Соединитель Visio (одномерная фигура): начало и конец приклеиваются к фигурам страницы, поэтому при
   * переносе фигуры в Visio стрелка следует за ней. Нарисованный путь points совпадает с раскладкой генератора;
   * при переносе фигур Visio перестроит его собственной маршрутизацией.
   */
  connector(opts: { points: Pt[]; from?: Endpoint; to?: Endpoint; tag?: Record<string, string>; text?: string; textAt?: Pt; fontPx?: number; weightPt?: number; dash?: boolean; props?: VisioPropOut[]; color?: string; arrowSize?: number }): number {
    const id = this.nextId++;
    const H = this.heightPx;
    const [bx, by] = opts.points[0];
    const [ex, ey] = opts.points[opts.points.length - 1];
    const BX = bx * PX;
    const BY = (H - by) * PX;
    const EX = ex * PX;
    const EY = (H - ey) * PX;
    const w = EX - BX;
    const h = EY - BY;
    const local = opts.points.map(([x, y]) => [(x - bx) * PX, (by - y) * PX] as Pt);
    const glueF = (own: "Beg" | "End", other: "Beg" | "End") => `_WALKGLUE(${own}Trigger,${other}Trigger,WalkPreference)`;
    const fromId = opts.from ? this.idOf(opts.from.key) : null;
    const toId = opts.to ? this.idOf(opts.to.key) : null;

    const fontPx = opts.fontPx ?? 10.5;
    const text = opts.text ? esc(opts.text) : "";
    // рамка текста: по самой длинной строке (с запасом на прописные буквы и цифры, иначе «ELMA365» ломается) и по числу строк
    const textLines = (opts.text ?? "").split("\n");
    const txtW = Math.max(0.5, (Math.max(...textLines.map((l) => l.length)) * fontPx * 0.72 + 8) * PX);
    const txtH = textLines.length * fontPx * 1.4 * PX + 2 * PX;
    // положение подписи — в координатах соединителя (начало — точка Begin)
    const ctrlX = opts.textAt ? (opts.textAt[0] - bx) * PX : w / 2;
    const ctrlY = opts.textAt ? (by - opts.textAt[1]) * PX : h / 2;
    const cells = [
      `<Cell N="PinX" V="${num((BX + EX) / 2)}" F="GUARD((BeginX+EndX)/2)"/>`,
      `<Cell N="PinY" V="${num((BY + EY) / 2)}" F="GUARD((BeginY+EndY)/2)"/>`,
      `<Cell N="Width" V="${num(w)}" F="GUARD(EndX-BeginX)"/>`,
      `<Cell N="Height" V="${num(h)}" F="GUARD(EndY-BeginY)"/>`,
      `<Cell N="LocPinX" V="${num(w / 2)}" F="GUARD(Width*0.5)"/>`,
      `<Cell N="LocPinY" V="${num(h / 2)}" F="GUARD(Height*0.5)"/>`,
      `<Cell N="Angle" V="0" F="GUARD(0DA)"/>`,
      `<Cell N="FlipX" V="0" F="GUARD(FALSE)"/>`,
      `<Cell N="FlipY" V="0" F="GUARD(FALSE)"/>`,
      `<Cell N="ResizeMode" V="0"/>`,
      `<Cell N="BeginX" V="${num(BX)}"${fromId ? ` F="${glueF("Beg", "End")}"` : ""}/>`,
      `<Cell N="BeginY" V="${num(BY)}"${fromId ? ` F="${glueF("Beg", "End")}"` : ""}/>`,
      `<Cell N="EndX" V="${num(EX)}"${toId ? ` F="${glueF("End", "Beg")}"` : ""}/>`,
      `<Cell N="EndY" V="${num(EY)}"${toId ? ` F="${glueF("End", "Beg")}"` : ""}/>`,
      `<Cell N="BegTrigger" V="2"${fromId ? ` F="_XFTRIGGER(Sheet.${fromId}!EventXFMod)"` : ""}/>`,
      `<Cell N="EndTrigger" V="2"${toId ? ` F="_XFTRIGGER(Sheet.${toId}!EventXFMod)"` : ""}/>`,
      `<Cell N="TxtPinX" V="${num(ctrlX)}" F="SETATREF(Controls.TextPosition)"/>`,
      `<Cell N="TxtPinY" V="${num(ctrlY)}" F="SETATREF(Controls.TextPosition.Y)"/>`,
      `<Cell N="TxtWidth" V="${num(txtW)}"/>`,
      `<Cell N="TxtHeight" V="${num(txtH)}"/>`,
      `<Cell N="TxtLocPinX" V="${num(txtW / 2)}" F="TxtWidth*0.5"/>`,
      `<Cell N="TxtLocPinY" V="${num(txtH / 2)}" F="TxtHeight*0.5"/>`,
      `<Cell N="TxtAngle" V="0"/>`,
      `<Cell N="LockHeight" V="1"/>`,
      `<Cell N="LockCalcWH" V="1"/>`,
      `<Cell N="NoAlignBox" V="1"/>`,
      `<Cell N="DynFeedback" V="2"/>`,
      `<Cell N="GlueType" V="2"/>`,
      `<Cell N="ObjType" V="2"/>`,
      `<Cell N="NoLiveDynamics" V="1"/>`,
      `<Cell N="ShapeSplittable" V="1"/>`,
      `<Cell N="LineColor" V="${opts.color ?? "#000000"}"/>`,
      `<Cell N="LinePattern" V="${opts.dash ? 2 : 1}"/>`,
      `<Cell N="LineWeight" V="${num((opts.weightPt ?? 0.9) / 72)}"/>`,
      `<Cell N="EndArrow" V="13"/>`,
      `<Cell N="EndArrowSize" V="${opts.arrowSize ?? 1}"/>`,
      `<Cell N="TextBkgnd" V="#ffffff"/>`,
      `<Cell N="TextBkgndTrans" V="0"/>`,
    ];
    const control = `<Section N="Control"><Row N="TextPosition"><Cell N="X" V="${num(ctrlX)}"/><Cell N="Y" V="${num(ctrlY)}"/><Cell N="XDyn" V="${num(ctrlX)}" F="Controls.TextPosition"/><Cell N="YDyn" V="${num(ctrlY)}" F="Controls.TextPosition.Y"/><Cell N="XCon" V="0"/><Cell N="YCon" V="0"/><Cell N="CanGlue" V="0"/></Row></Section>`;
    const tag: Record<string, string> = { ...opts.tag, pm_sid: String(id) };
    const chars = text ? `<Section N="Character"><Row IX="0"><Cell N="Size" V="${num((fontPx * 0.75) / 72)}"/><Cell N="Color" V="#000000"/></Row></Section>` : "";
    const geomRows = local
      .map(([x, y], i) => `<Row T="${i === 0 ? "MoveTo" : "LineTo"}" IX="${i + 1}"><Cell N="X" V="${num(x)}"/><Cell N="Y" V="${num(y)}"/></Row>`)
      .join("");
    const geom = `<Section N="Geometry" IX="0"><Cell N="NoFill" V="1"/><Cell N="NoLine" V="0"/><Cell N="NoShow" V="0"/><Cell N="NoSnap" V="0"/><Cell N="NoQuickDrag" V="0"/>${geomRows}</Section>`;
    this.shapes.push(
      `<Shape ID="${id}" NameU="Connector.${id}" Type="Shape" LineStyle="0" FillStyle="0" TextStyle="0">${cells.join("")}${control}${propRows(opts.props)}${userRows(tag)}${chars}${geom}${text ? `<Text>${text}</Text>` : ""}</Shape>`
    );

    const glue = (from: "BeginX" | "EndX", part: number, ep: Endpoint | undefined, sheet: number | null) => {
      if (!ep || sheet === null) return;
      const target = ep.port === undefined ? `ToCell="PinX" ToPart="3"` : `ToCell="Connections.X${ep.port + 1}" ToPart="${100 + ep.port}"`;
      this.connects.push(`<Connect FromSheet="${id}" FromCell="${from}" FromPart="${part}" ToSheet="${sheet}" ${target}/>`);
    };
    glue("BeginX", 9, opts.from, fromId);
    glue("EndX", 12, opts.to, toId);
    return id;
  }

  contentXml(): string {
    const connects = this.connects.length ? `<Connects>${this.connects.join("")}</Connects>` : "";
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<PageContents xmlns="${NS}" xmlns:r="${NS_R}" xml:space="preserve"><Shapes>${this.shapes.join("")}</Shapes>${connects}</PageContents>`;
  }

  /** Содержимое мастера трафарета: та же разметка фигур, другой корневой элемент. */
  masterContentXml(): string {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<MasterContents xmlns="${NS}" xmlns:r="${NS_R}" xml:space="preserve"><Shapes>${this.shapes.join("")}</Shapes></MasterContents>`;
  }
}

// --- трафарет документа ---

/**
 * Мастера «Фигур документа» (трафарет внутри файла): перетащенная из него фигура несёт ячейку pm_m с типом
 * элемента, и при чтении правок становится шагом, событием, шлюзом или функцией IDEF0 нужного вида.
 */
export interface StencilMaster {
  nameU: string;
  prompt: string;
  page: Page;
}

export function stencilMasters(): StencilMaster[] {
  const mk = (nameU: string, kind: string, prompt: string, w: number, h: number, draw: (p: Page, tag: Record<string, string>) => void): StencilMaster => {
    const page = Page.forMaster(nameU, w, h);
    draw(page, { pm_m: kind });
    return { nameU, prompt, page };
  };
  const subMarker = (w: number, h: number): GeomPart[] => [
    { kind: "path", pts: [[w / 2 - 7, h - 17], [w / 2 + 7, h - 17], [w / 2 + 7, h - 3], [w / 2 - 7, h - 3]], closed: true },
    { kind: "path", pts: [[w / 2 - 4, h - 10], [w / 2 + 4, h - 10]] },
    { kind: "path", pts: [[w / 2, h - 14], [w / 2, h - 6]] },
  ];
  const below = (w: number) => ({ w, h: 30, gap: 3 });
  return [
    mk("Задача", "task", "Шаг процесса BPMN", 150, 90, (p, tag) => p.rect(0, 0, 150, 90, { fill: "#e8eef7", weightPt: 1.3, roundingPx: 10, fontPx: 12, tag })),
    mk("Подпроцесс", "subprocess", "Свёрнутый подпроцесс BPMN", 160, 90, (p, tag) => p.rect(0, 0, 160, 90, { fill: "#e8eef7", weightPt: 1.3, roundingPx: 10, fontPx: 12, tag }, subMarker(160, 90))),
    mk("Шлюз «или»", "gateway:exclusive", "Исключающий шлюз: выбор одной ветви", 50, 50, (p, tag) => p.diamond(0, 0, 50, 50, { fill: "#ffff99", weightPt: 1.3, fontPx: 11, textBelow: below(130), tag }, gatewayGlyph("exclusive", 50, 50))),
    mk("Шлюз «и»", "gateway:parallel", "Параллельный шлюз: все ветви одновременно", 50, 50, (p, tag) => p.diamond(0, 0, 50, 50, { fill: "#ffff99", weightPt: 1.3, fontPx: 11, textBelow: below(130), tag }, gatewayGlyph("parallel", 50, 50))),
    mk("Начальное событие", "event:start", "Начало процесса", 36, 36, (p, tag) => p.ellipse(0, 0, 36, 36, { fill: "#99ff66", weightPt: 1.3, fontPx: 11, textBelow: below(120), tag })),
    mk("Промежуточное событие", "event:intermediate", "Событие внутри процесса", 36, 36, (p, tag) => p.ellipse(0, 0, 36, 36, { fill: "#ff9933", weightPt: 1.3, fontPx: 11, textBelow: below(120), tag }, [{ kind: "ellipse", cx: 18, cy: 18, rx: 14, ry: 14 }])),
    mk("Конечное событие", "event:end", "Завершение процесса", 36, 36, (p, tag) => p.ellipse(0, 0, 36, 36, { fill: "#ff8262", weightPt: 3.2, fontPx: 11, textBelow: below(120), tag })),
    mk("Функция IDEF0", "fn", "Функциональный блок IDEF0", 170, 90, (p, tag) => p.rect(0, 0, 170, 90, { fill: "#e8eef7", weightPt: 1.4, fontPx: 12, tag })),
  ];
}

const guid = (i: number) => `{5A1D0000-0000-4000-8000-${(i + 1).toString(16).padStart(12, "0")}}`;

function mastersXml(masters: StencilMaster[]): string {
  const items = masters
    .map(
      (m, i) =>
        `<Master ID="${i + 1}" NameU="${esc(m.nameU)}" IsCustomNameU="1" Name="${esc(m.nameU)}" IsCustomName="1" Prompt="${esc(m.prompt)}" IconSize="1" AlignName="2" MatchByName="0" IconUpdate="1" UniqueID="${guid(i)}" BaseID="${guid(i + 100)}" PatternFlags="0" Hidden="0" MasterType="0"><PageSheet LineStyle="0" FillStyle="0" TextStyle="0"><Cell N="PageWidth" V="${num(m.page.widthIn)}"/><Cell N="PageHeight" V="${num(m.page.heightIn)}"/><Cell N="PageScale" V="1"/><Cell N="DrawingScale" V="1"/><Cell N="DrawingSizeType" V="4"/><Cell N="DrawingScaleType" V="0"/></PageSheet><Rel r:id="rId${i + 1}"/></Master>`
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Masters xmlns="${NS}" xmlns:r="${NS_R}" xml:space="preserve">${items}</Masters>`;
}

// --- IDEF0 ---

const blockKey = (nodeId: string) => `fn:${nodeId}`;

/** Точки приклейки блока: по одной на каждый конец стрелки, лежащий на его границе. */
function blockPorts(b: Idef0Block, d: Idef0DiagramData): { ports: Port[]; indexOf: (p: Pt) => number } {
  const ports: Port[] = [];
  const index = new Map<string, number>();
  const add = (p: Pt) => {
    const k = `${p[0]},${p[1]}`;
    if (index.has(k)) return;
    const [lx, ly] = [p[0] - b.x, p[1] - b.y];
    const dir = lx <= 0.5 ? { dx: -1, dy: 0 } : lx >= b.w - 0.5 ? { dx: 1, dy: 0 } : ly <= 0.5 ? { dx: 0, dy: -1 } : { dx: 0, dy: 1 };
    index.set(k, ports.length);
    ports.push({ x: lx, y: ly, ...dir });
  };
  for (const a of d.arrows) {
    if (a.startNode === b.nodeId) add(a.points[0]);
    if (a.endNode === b.nodeId) add(a.points[a.points.length - 1]);
  }
  return { ports, indexOf: (p) => index.get(`${p[0]},${p[1]}`) ?? 0 };
}

/** Лист со штампом (shared/idef0Frame.ts) для страницы Visio: лист в отрицательных координатах Visio не показывает, такой лист не рисуется. */
function sheetOnPage(world: { w: number; h: number }, settings: IdefFrame | undefined, defaults: FrameDefaults): FrameGeometry | null {
  const g = frameGeometry(world, settings, defaults);
  return g.sheet.x >= 0 && g.sheet.y >= 0 ? g : null;
}

/** Размер страницы: диаграмма и лист, где бы он ни стоял. */
const pageSize = (w: number, h: number, geo: FrameGeometry | null): [number, number] => (geo ? [Math.max(w, geo.sheet.x + geo.sheet.w), Math.max(h, geo.sheet.y + geo.sheet.h)] : [w, h]);

/** Рамка и штамп — оформление (pm_k = deco): при чтении правок из Visio они пропускаются. Сетка в Visio не выгружается. */
function drawSheet(page: Page, geo: FrameGeometry, kind: "idef0" | "bpmn", key: string) {
  page.rect(geo.footer.x, geo.footer.y, geo.footer.w, geo.footer.h, { fill: "#e8eef7", weightPt: 0.75 });
  // рамка листа помечена: размер и положение, заданные в Visio (тянут за углы и стороны), при приёме правок становятся листом модели
  page.rect(geo.sheet.x, geo.sheet.y, geo.sheet.w, geo.sheet.h, { fill: null, weightPt: 0.75, tag: { pm_k: "sheet", pm_fd: kind, pm_fk: key, pm_sr: [geo.sheet.x, geo.sheet.y, geo.sheet.w, geo.sheet.h].map((v) => Math.round(v)).join(",") } });
  for (const x of geo.dividers) page.polyline([[x, geo.footer.y], [x, geo.footer.y + geo.footer.h]], { weightPt: 0.75 });
  for (const c of geo.cells) page.label(c.text, { x: c.anchor === "middle" ? c.x + c.w / 2 : c.x + 3, y: c.y - 1, anchor: c.anchor, w: Math.max(20, c.w - 4) }, { fontPx: FRAME_FONT, color: "#000000" });
}

/** Ширина рамки подписи стрелки по самой длинной строке (кегль 10,5; прописные и цифры шире строчных). */
const labelBoxW = (text: string): number => Math.max(24, Math.max(...text.split("\n").map((l) => l.length)) * 10.5 * 0.72 + 8);

function idef0Page(d: Idef0DiagramData, name: string, model: ProcessLogicModel, kind: "context" | "root" | "child", parentNodeId?: string): Page {
  const editable = d.code !== "A-0";
  const fi = frameInfo(d, model, kind, parentNodeId);
  const settings = model.idef0_frames?.[fi.key];
  const geo = frameShown(settings) ? sheetOnPage({ w: d.width, h: d.height }, settings, fi.defaults) : null;
  const [pw, ph] = pageSize(d.width, d.height, geo);
  const page = new Page(name, pw, ph, { pm_page: `idef0:${d.code}`, ...(parentNodeId ? { pm_parent: parentNodeId } : {}), ...(editable ? {} : { pm_ro: "1" }), ...(kind === "context" ? { pm_ctx: "1" } : {}) });
  if (geo) drawSheet(page, geo, "idef0", fi.key);
  else page.label(d.title, { x: 16, y: 8, anchor: "start", w: Math.max(300, d.title.length * 9) }, { fontPx: 15, bold: true });

  const portsOf = new Map<string, ReturnType<typeof blockPorts>>();
  for (const b of d.blocks) {
    const big = b.w >= 200;
    const pp = editable ? blockPorts(b, d) : { ports: [], indexOf: () => 0 };
    portsOf.set(b.nodeId, pp);
    // у блока подпись «код название», как в Business Studio; полное название хранится в метке pm_n
    const own = ownStyle(model, "idef0_block");
    const runs: Run[] = [{ text: editable ? `${b.code} ${b.name}` : b.name, fontPx: own.font_size ?? (big ? 13 : 12), ...(own.text ? { color: own.text } : {}) }];
    page.rect(b.x, b.y, b.w, b.h, { fill: own.fill ?? "#e8eef7", ...(own.line ? { line: own.line } : {}), weightPt: 1, runs, key: blockKey(b.nodeId), ports: pp.ports, tag: editable ? { pm_k: "fn", pm_id: b.nodeId, pm_n: b.name, pm_x: String(Math.round(b.x)), pm_y: String(Math.round(b.y)) } : undefined });
    if (!editable) page.label(b.code, { x: b.x + 6, y: b.y + b.h - 18, anchor: "start", w: 60 }, { fontPx: 10, color: "#4b5563" });
  }

  for (const a of d.arrows) {
    const lab = arrowLabelPlacement(a);
    if (!a.ref || (!a.startNode && !a.endNode)) {
      // стрелки контекстной диаграммы — только оформление
      page.polyline(a.points, { endArrow: true, weightPt: 0.75, line: "#4677bf", arrowSize: 0 });
      if (lab) page.label(lab.text, { x: lab.x, y: lab.y - 12, anchor: lab.anchor, w: labelBoxW(lab.text), h: lab.text.split("\n").length * 14.5 }, { fontPx: 10.5, color: "#000000" });
      continue;
    }
    const first = a.points[0];
    const last = a.points[a.points.length - 1];
    const from = a.startNode ? { key: blockKey(a.startNode), port: portsOf.get(a.startNode)?.indexOf(first) } : undefined;
    const to = a.endNode ? { key: blockKey(a.endNode), port: portsOf.get(a.endNode)?.indexOf(last) } : undefined;
    let textAt: Pt | undefined;
    if (lab) {
      const w = labelBoxW(lab.text);
      const cx = lab.anchor === "end" ? lab.x - w / 2 : lab.anchor === "start" ? lab.x + w / 2 : lab.x;
      textAt = [cx, lab.y - 12 + (lab.text.split("\n").length * 14.5) / 2];
    }
    page.connector({
      points: a.points,
      from,
      to,
      text: lab?.text,
      textAt,
      tag: { pm_k: "arrow", pm_id: a.ref.entityId, pm_a: `${a.ref.kind}|${a.ref.nodeId}|${a.ref.entityId}`, pm_n: a.label ?? "" },
      weightPt: 0.75,
      color: "#4677bf",
      arrowSize: 0,
    });
    // скобки туннеля — оформление: ломаные по дуге, при чтении правок игнорируются
    for (const arc of tunnelArcs({ kind: a.ref.kind, points: a.points, tunnelUp: a.tunnelUp, tunnelDown: a.tunnelDown })) {
      const pts: Pt[] = [0, 0.25, 0.5, 0.75, 1].map((u) => [(1 - u) ** 2 * arc.from[0] + 2 * (1 - u) * u * arc.ctl[0] + u ** 2 * arc.to[0], (1 - u) ** 2 * arc.from[1] + 2 * (1 - u) * u * arc.ctl[1] + u ** 2 * arc.to[1]]);
      page.polyline(pts, { weightPt: 0.9, line: "#4677bf" });
    }
  }
  if (editable) page.meta.pm_manifest = JSON.stringify({ fn: d.blocks.map((b) => b.nodeId), ar: d.arrows.flatMap((a) => (a.ref ? [`${a.ref.kind}|${a.ref.nodeId}|${a.ref.entityId}`] : [])) });
  d.footer.forEach((line, i) => line && page.label(line, { x: 16, y: d.height - 34 + i * 18, anchor: "start", w: Math.max(300, line.length * 7) }, { fontPx: 11, color: "#374151" }));
  return page;
}

// --- BPMN ---

type Shape = BpmnDiagramData["shapes"][number];

/** Незалитые части значка триггера (контуры); залитые рисуются отдельными фигурами — см. drawEventFilled. */
function eventGlyph(glyphs: Glyph[], w: number, h: number): GeomPart[] {
  const [cx, cy] = [w / 2, h / 2];
  const parts: GeomPart[] = [];
  for (const g of glyphs) {
    if (g.kind === "circle" && !g.filled) parts.push({ kind: "ellipse", cx, cy, rx: g.r, ry: g.r });
    else if (g.kind === "poly" && !g.filled && !g.light) parts.push({ kind: "path", pts: g.pts.map(([x, y]) => [cx + x, cy + y] as Pt), closed: g.closed });
  }
  return parts;
}

/** Залитые части значка (выбрасывающее событие, терминатор) — чёрные фигуры поверх события; белые линии (сгиб конверта) — поверх них. */
function drawEventFilled(page: Page, glyphs: Glyph[], x: number, y: number, w: number, h: number) {
  const [cx, cy] = [x + w / 2, y + h / 2];
  for (const g of glyphs) {
    if (g.kind === "circle" && g.filled) page.ellipse(cx - g.r, cy - g.r, g.r * 2, g.r * 2, { fill: "#1f2937", line: "#1f2937", weightPt: 0.5 });
    else if (g.kind === "poly" && g.filled) {
      const xs = g.pts.map((p) => p[0]);
      const ys = g.pts.map((p) => p[1]);
      const [x0, y0] = [Math.min(...xs), Math.min(...ys)];
      page.add({ x: cx + x0, y: cy + y0, w: Math.max(...xs) - x0, h: Math.max(...ys) - y0 }, [{ kind: "path", pts: g.pts.map(([px, py]) => [px - x0, py - y0] as Pt), closed: true }], { fill: "#1f2937", line: "#1f2937", weightPt: 0.5 });
    } else if (g.kind === "poly" && g.light) page.polyline(g.pts.map(([px, py]) => [cx + px, cy + py] as Pt), { weightPt: 0.8, line: "#ffffff" });
  }
}
function gatewayGlyph(subtype: string | undefined, w: number, h: number): GeomPart[] {
  const [cx, cy] = [w / 2, h / 2];
  switch (subtype) {
    case "parallel":
      return [
        { kind: "path", pts: [[cx - 9, cy], [cx + 9, cy]] },
        { kind: "path", pts: [[cx, cy - 9], [cx, cy + 9]] },
      ];
    case "inclusive":
      return [{ kind: "ellipse", cx, cy, rx: 9, ry: 9 }];
    case "event_based":
      return [
        { kind: "ellipse", cx, cy, rx: 10, ry: 10 },
        { kind: "ellipse", cx, cy, rx: 7.5, ry: 7.5 },
      ];
    default:
      return [
        { kind: "path", pts: [[cx - 7, cy - 7], [cx + 7, cy + 7]] },
        { kind: "path", pts: [[cx + 7, cy - 7], [cx - 7, cy + 7]] },
      ];
  }
}

/**
 * Страница BPMN; scope — операция диаграммы (null — общая схема процесса). Лист (model.bpmn_frames) по умолчанию выключен;
 * автоматический лист накрывает пул целиком с полем, как в редакторе, а заданный вручную стоит по своим координатам.
 */
/** Шрифт заголовка дорожки: 16 px (крупно, как в Business Studio), а длинное название уменьшается, чтобы уместиться по высоте дорожки (в две строки при 10,5 px). */
const laneLabelFont = (text: string, laneH: number): number => (text.length * 8.7 <= laneH - 10 ? 18 : text.length * 7.4 <= laneH - 10 ? 14 : 11);

/** Середина первого отрезка маршрута длиннее 40 px (иначе самого длинного): сюда ставится условие ветки. */
function flowLabelMid(points: Pt[]): Pt {
  let best: [Pt, Pt] | null = null;
  let bestLen = -1;
  for (let i = 0; i + 1 < points.length; i++) {
    const len = Math.abs(points[i + 1][0] - points[i][0]) + Math.abs(points[i + 1][1] - points[i][1]);
    if (len >= 40) { best = [points[i], points[i + 1]]; break; }
    if (len > bestLen) { best = [points[i], points[i + 1]]; bestLen = len; }
  }
  const [a, b] = best ?? [points[0], points[points.length - 1]];
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

function bpmnPage(d: BpmnDiagramData, name: string, model: ProcessLogicModel, scope: string | null, code: string): Page {
  const settings = model.bpmn_frames?.[scope ?? ""];
  const sheetName = scope ? model.nodes.find((n) => n.id === scope)?.name ?? "" : model.process.name;
  // «мир» как в редакторе: правый край пула и низ содержимого с полем 20 (d.width и d.height — с полем 40)
  const world = bpmnSheetWorld({ w: d.pool.x + d.pool.w, h: d.height - BPMN_SHEET_MARGIN / 2 });
  const geo = bpmnFrameShown(settings) ? sheetOnPage(world, settings, bpmnFrameDefaults(code, sheetName)) : null;
  const [pw, ph] = pageSize(d.width, d.height, geo);
  const page = new Page(name, pw, ph, { pm_page: "bpmn", ...(scope ? { pm_scope: scope } : {}) });
  // лист — под диаграммой: штамп и рамка рисуются первыми
  if (geo) drawSheet(page, geo, "bpmn", scope ?? "");
  // полоса заголовка над пулом: код и название диаграммы (оформление — при чтении правок пропускается)
  // полоса заголовка: название с кодом в одну строку и пустая узкая полоса под ним, как в Business Studio
  const bx0 = LANE_X; // пул начинается там же, где дорожки: узкой полосы с названием пула у Business Studio нет
  const bw0 = d.pool.w - (LANE_X - d.pool.x);
  page.rect(bx0, 1, bw0, 24, { fill: "#e8eef7", weightPt: 1, align: "left", text: `${code} ${sheetName}`.trim() || name, fontPx: 14, color: "#000000" });
  page.rect(bx0, 25, bw0, 12, { fill: "#e8eef7", weightPt: 1 });
  // пул и дорожки
  // как в Business Studio, контейнер кончается там же, где дорожки (документы и аннотации стоят ниже него)
  const lanesBottom = d.lanes.length ? Math.max(...d.lanes.map((l) => l.y + l.h)) : d.pool.y + d.pool.h;
  page.rect(bx0, d.pool.y, bw0, lanesBottom - d.pool.y, { fill: "#ffffff", weightPt: 1.4, tag: { pm_k: "pool" } });
  for (const l of d.lanes) {
    const laneId = l.roleId ?? "__unassigned__";
    page.rect(l.x, l.y, l.w, l.h, { fill: "#ffffff", line: "#000000", weightPt: 1, tag: { pm_k: "lane", pm_id: laneId } });
    // подпись дорожки вертикально, по центру полосы шириной 30; текст редактируется — так переименовывается роль
    page.add(
      { x: l.x + LABEL_W / 2 - l.h / 2, y: l.y + l.h / 2 - LABEL_W / 2, w: l.h, h: LABEL_W },
      [{ kind: "path", pts: [[0, 0], [l.h, 0], [l.h, LABEL_W], [0, LABEL_W]], closed: true }],
      { fill: "#e8eef7", line: null, text: l.name, fontPx: laneLabelFont(l.name, l.h), bold: false, angle: Math.PI / 2, tag: { pm_k: "lanelabel", pm_id: laneId, pm_n: l.name } }
    );
    page.polyline([[l.x + LABEL_W, l.y], [l.x + LABEL_W, l.y + l.h]], { weightPt: 1, line: "#94a3b8" });
  }
  for (const e of d.extras) {
    if (e.link) page.polyline(e.link, { weightPt: 0.8, line: "#64748b", dash: true });
    if (e.kind === "data") {
      page.rect(e.x, e.y, e.w, e.h, { fill: "#ffffff", weightPt: 1 });
      page.label(e.name, { x: e.x + e.w / 2, y: e.y - 14, w: 90 }, { fontPx: 9 });
    } else if (e.kind === "store") {
      // хранилище данных: цилиндр (корпус и две дуги крышки)
      const r = Math.min(4, e.h / 5);
      page.rect(e.x, e.y, e.w, e.h, { fill: "#ffffff", weightPt: 1, roundingPx: r }, [{ kind: "path", pts: [[0, r * 1.6], [e.w, r * 1.6]] }]);
      page.label(e.name, { x: e.x + e.w / 2, y: e.y - 14, w: 90 }, { fontPx: 9 });
    } else {
      // аннотация — скобка «[» с названием справа от неё; привязка к задаче — пунктиром (выше)
      page.add(
        { x: e.x, y: e.y, w: e.w, h: e.h },
        [{ kind: "path", pts: [[Math.min(10, e.w / 4), 0], [0, 0], [0, e.h], [Math.min(10, e.w / 4), e.h]] }],
        { fill: null, line: "#000000", weightPt: 0.75, text: e.name, fontPx: 11, align: "left" }
      );
    }
  }

  // свёрнутые внешние пулы и потоки сообщений
  drawPoolsAndMessages(page, d);

  // стрелки под фигурами: соединители, приклеенные к фигурам
  for (const edge of d.edges) {
    let textAt: Pt | undefined;
    if (edge.label) {
      // как в Business Studio: подпись по центру первого заметного отрезка, на белой подложке поверх линии
      textAt = flowLabelMid(edge.points);
    }
    page.connector({
      points: edge.points,
      from: { key: edge.from },
      to: { key: edge.to },
      text: edge.label,
      textAt,
      tag: edge.flowId ? { pm_k: "flow", pm_id: edge.flowId, pm_n: edge.label ?? "" } : { pm_k: "synthflow" },
      props: visioFlowProps(!!edge.label, edge.isDefault),
    });
  }

  for (const s of d.shapes) drawBpmnShape(page, s, model);
  // что было нарисовано: по этому списку импорт отличает удалённое в Visio от появившегося в модели позже
  page.meta.pm_manifest = JSON.stringify({ n: d.shapes.flatMap((s) => (s.nodeId ? [s.nodeId] : [])), f: d.edges.flatMap((e) => (e.flowId ? [e.flowId] : [])) });
  return page;
}

/**
 * Свёрнутые внешние пулы и потоки сообщений, как в Business Studio: у каждой задачи, связанной с пулом, пул стоит прямо под ней
 * (копия по числу задач), а потоки идут вертикально: от задачи вниз — с кружком у задачи и полым треугольником у пула, вверх к
 * задаче — наоборот. Пул без потоков к шагам рисуется один раз на своём месте.
 */
function drawPoolsAndMessages(page: Page, d: BpmnDiagramData) {
  const shapeById = new Map(d.shapes.map((s) => [s.id, s] as const));
  const draw = (q: { id: string; name: string }, box: { x: number; y: number; w: number; h: number }, first: boolean) =>
    page.rect(box.x, box.y, box.w, box.h, { fill: "#ffffff", weightPt: 0.75, text: q.name, fontPx: 12, bold: false, tag: { pm_k: first ? "extpool" : "extpool_copy", pm_id: q.id } });
  const unplaced = d.messages.filter((m) => !d.pools.some((q) => q.id === m.from || q.id === m.to));
  const flowLine = (points: Pt[], begin: boolean, label?: string) => {
    page.polyline(points, { weightPt: 0.75, line: "#000000", dash: true, ...(begin ? { beginArrowId: 20, endArrowId: 14 } : { endArrowId: 14 }), arrowSize: 1 });
    if (label) {
      const i = Math.floor((points.length - 1) / 2);
      page.label(label, { x: (points[i][0] + points[i + 1][0]) / 2 + 4, y: (points[i][1] + points[i + 1][1]) / 2 - 6, anchor: "start" }, { fontPx: 9 });
    }
  };
  for (const m of unplaced) flowLine(m.points, true, m.label);

  let right = -Infinity;
  const ordered = d.pools
    .flatMap((q) => {
      const msgs = d.messages.filter((m) => (m.from === q.id && shapeById.has(m.to)) || (m.to === q.id && shapeById.has(m.from)));
      const byShape = new Map<string, typeof msgs>();
      for (const m of msgs) {
        const sid = m.from === q.id ? m.to : m.from;
        byShape.set(sid, [...(byShape.get(sid) ?? []), m]);
      }
      if (byShape.size === 0) return [{ q, shape: null as null | { x: number; y: number; w: number; h: number }, msgs: [] as typeof msgs, first: true }];
      return [...byShape].map(([sid, list], i) => ({ q, shape: shapeById.get(sid)!, msgs: list, first: i === 0 }));
    })
    .sort((a, b) => (a.shape ? a.shape.x + a.shape.w / 2 : Infinity) - (b.shape ? b.shape.x + b.shape.w / 2 : Infinity));
  for (const it of ordered) {
    if (!it.shape) {
      draw(it.q, it.q, it.first);
      continue;
    }
    const w = Math.max(it.q.w, 190);
    const cx = it.shape.x + it.shape.w / 2;
    const x = Math.max(cx - w / 2, right + 24);
    right = x + w;
    const box = { x, y: it.q.y, w, h: it.q.h };
    draw(it.q, box, it.first);
    const outs = it.msgs.filter((m) => m.from !== it.q.id);
    const ins = it.msgs.filter((m) => m.from === it.q.id);
    const bottom = it.shape.y + it.shape.h;
    const place = (list: typeof outs, centre: number, outgoing: boolean) =>
      list.forEach((m, i) => {
        const px = Math.min(Math.max(centre + (i - (list.length - 1) / 2) * 16, box.x + 10), box.x + box.w - 10);
        const tx = Math.min(Math.max(px, it.shape!.x + 8), it.shape!.x + it.shape!.w - 8);
        const pts: Pt[] = Math.abs(tx - px) < 1 ? [[tx, bottom], [px, box.y]] : [[tx, bottom], [tx, (bottom + box.y) / 2], [px, (bottom + box.y) / 2], [px, box.y]];
        flowLine(outgoing ? pts : [...pts].reverse(), true, m.label);
      });
    place(outs, it.shape.x + it.shape.w * 0.3, true);
    place(ins, it.shape.x + it.shape.w * 0.7, false);
  }
}

function drawBpmnShape(page: Page, s: Shape, model: ProcessLogicModel, plain = false) {
  const { x, y, w, h } = s;
  // plain — фигура для палитры оболочки: без меток модели (метки ставит приём правок, когда фигура становится шагом)
  const tag: Record<string, string> = plain ? {} : s.nodeId ? { pm_k: "node", pm_id: s.nodeId, pm_n: s.name, pm_x: String(Math.round(x)), pm_y: String(Math.round(y)) } : { pm_k: "synth", pm_id: s.id };
  const props = visioShapeProps(s);
  // оформление вида из модели (shape_styles) ложится поверх значений выгрузки по умолчанию
  const pos = s.event?.position ?? (s.subtype === "start" ? "start" : s.subtype === "end" ? "end" : "intermediate");
  const styleKind: StyleKind = s.kind === "event" ? (pos === "start" ? "event_start" : pos === "end" ? "event_end" : "event_intermediate") : s.kind;
  const own = ownStyle(model, styleKind);
  const look: Style = { ...(own.fill ? { fill: own.fill } : {}), ...(own.line ? { line: own.line } : {}), ...(own.text ? { color: own.text } : {}), ...(own.font_size ? { fontPx: own.font_size } : {}) };
  if (s.kind === "event") {
    // параметры триггера (имя сообщения, ссылки, срок таймера, условие) в свойствах Visio не помещаются — они в метке фигуры
    const trigger = s.nodeId ? model.nodes.find((n) => n.id === s.nodeId)?.trigger : undefined;
    if (trigger && trigger.type !== "none") tag.pm_trg = JSON.stringify(trigger);
    const position = s.event?.position ?? (s.subtype === "start" ? "start" : s.subtype === "end" ? "end" : "intermediate");
    const isStart = position === "start";
    const isEnd = position === "end";
    const inner: GeomPart[] = isStart || isEnd ? [] : [{ kind: "ellipse", cx: w / 2, cy: h / 2, rx: w / 2 - 4, ry: h / 2 - 4 }];
    const glyphs = triggerGlyph(s.event?.trigger ?? "none", s.event?.throwing ?? false);
    page.ellipse(x, y, w, h, { fill: isStart ? "#99ff66" : isEnd ? "#ff8262" : "#ff9933", weightPt: isEnd ? 3.2 : 1.3, dash: position === "boundary" && s.interrupting === false, text: s.name, fontPx: 11, textBelow: { w: 120, h: 30, gap: 3 }, tag, key: s.id, props, ...look }, [...inner, ...eventGlyph(glyphs, w, h)]);
    drawEventFilled(page, glyphs, x, y, w, h);
  } else if (s.kind === "gateway") {
    page.diamond(x, y, w, h, { fill: "#ffff99", weightPt: 1.3, text: s.name, fontPx: 11, textBelow: { w: 130, h: 30, gap: 3 }, tag, key: s.id, props, ...look }, gatewayGlyph(s.subtype, w, h));
  } else {
    drawBlock(page, s, x, y, w, h, tag, props, look);
  }
}

/** Названия триггеров в именах фигур палитры (по ним импорт опознаёт тип); те же слова в оболочке (VisioPane.TriggerNames). */
const PALETTE_EVENTS: Record<string, string[]> = {
  start: ["none", "message", "timer", "conditional", "signal"],
  intermediate: ["none", "message", "timer", "conditional", "signal", "escalation"],
  end: ["none", "message", "error", "escalation", "signal"], // «завершение процесса» — залитый значок отдельной фигурой, в палитру не берётся
};

/**
 * Документ с готовыми событиями для палитры оболочки: по странице на каждое сочетание «положение:тип» (например «intermediate:timer»),
 * на странице одна фигура — та же, что рисует выгрузка (значок внутри круга). Оболочка копирует фигуру со страницы на диаграмму:
 * значок нарисован нашим кодом, а не вручную через COM.
 */
export async function buildEventShapesVsdx(): Promise<Buffer> {
  const pages: Page[] = [];
  const model = { nodes: [], roles: [], flows: [] } as unknown as ProcessLogicModel;
  for (const [position, triggers] of Object.entries(PALETTE_EVENTS)) {
    for (const trigger of triggers) {
      const page = new Page(`${position}:${trigger}`, 200, 120);
      const shape: Shape = { id: "e", kind: "event", subtype: position === "start" ? "start" : position === "end" ? "end" : "intermediate", event: { position: position as "start", trigger: trigger as never, throwing: false }, name: "", x: 20, y: 20, w: 36, h: 36 } as Shape;
      drawBpmnShape(page, shape, model, true);
      pages.push(page);
    }
  }
  return packVsdx(pages, {}, []);
}

/** Маркер цикличности внизу блока (локальные координаты, y вниз): круговая стрелка, три вертикальные или три горизонтальные черты. */
function loopGlyph(loop: string | undefined, w: number, h: number, withSubMarker: boolean): GeomPart[] {
  if (!loop) return [];
  const cx = w / 2 - (withSubMarker ? 24 : 0);
  const cy = h - 10;
  if (loop === "parallel") return [-4, 0, 4].map((dx) => ({ kind: "path" as const, pts: [[cx + dx, cy - 5], [cx + dx, cy + 5]] as Pt[] }));
  if (loop === "sequential") return [-4, 0, 4].map((dy) => ({ kind: "path" as const, pts: [[cx - 5, cy + dy], [cx + 5, cy + dy]] as Pt[] }));
  const r = 5;
  const at = (deg: number): Pt => [cx + r * Math.cos((deg * Math.PI) / 180), cy + r * Math.sin((deg * Math.PI) / 180)];
  const arc: Pt[] = [];
  for (let a = 120; a <= 400; a += 20) arc.push(at(a));
  const end = at(400);
  return [
    { kind: "path", pts: arc },
    { kind: "path", pts: [[end[0] - 3, end[1] - 3], end, [end[0] + 3, end[1] - 3]] },
  ];
}

/** Задача или подпроцесс; триггеры блока (ожидающие события) — значки на его границе, без отдельных фигур и стрелок. */
/** Значок типа задачи в левом верхнем углу блока (контуры из shared/taskIcons.ts). */
function taskIconParts(subtype: string | undefined): GeomPart[] {
  return taskIcon(subtype).map((p) =>
    p.kind === "ellipse" ? { kind: "ellipse" as const, cx: p.cx + TASK_ICON_PAD, cy: p.cy + TASK_ICON_PAD, rx: p.rx, ry: p.ry } : { kind: "path" as const, pts: p.pts.map(([x, y]) => [x + TASK_ICON_PAD, y + TASK_ICON_PAD] as Pt), ...(p.closed ? { closed: true } : {}) }
  );
}

function drawBlock(page: Page, s: Shape, x: number, y: number, w: number, h: number, tag: Record<string, string>, props: VisioPropOut[], look: Style) {
  {
    page.rect(x, y, w, h, { fill: "#e8eef7", weightPt: 1.3, roundingPx: 10, text: s.name, fontPx: 12, tag, key: s.id, props, ...look }, [
      ...(s.kind === "subprocess" ? [{ kind: "path" as const, pts: [[w / 2 - 7, h - 17], [w / 2 + 7, h - 17], [w / 2 + 7, h - 3], [w / 2 - 7, h - 3]] as Pt[], closed: true }, { kind: "path" as const, pts: [[w / 2 - 4, h - 10], [w / 2 + 4, h - 10]] as Pt[] }, { kind: "path" as const, pts: [[w / 2, h - 14], [w / 2, h - 6]] as Pt[] }] : []),
      ...loopGlyph(s.loop, w, h, s.kind === "subprocess"),
      ...(s.kind === "task" ? taskIconParts(s.subtype) : []),
    ]);
  }
  // триггеры блока: значок с кольцом (двойным у промежуточного события) на границе блока
  const markers = s.markers ?? [];
  markerCenters({ x, y, w, h }, markers.length).forEach(([cx, cy], i) => {
    const mk = markers[i];
    const d = MARKER_R * 2;
    const glyphs = scaleGlyphs(triggerGlyph(mk.trigger, false), 0.55);
    const ring: GeomPart[] = mk.start ? [] : [{ kind: "ellipse", cx: MARKER_R, cy: MARKER_R, rx: MARKER_R - 2.5, ry: MARKER_R - 2.5 }];
    page.ellipse(cx - MARKER_R, cy - MARKER_R, d, d, { fill: mk.start ? "#99ff66" : "#ff9933", weightPt: 0.9, tag: { pm_k: "trigger", pm_n: mk.name } }, [...ring, ...eventGlyph(glyphs, d, d)]);
  });
}

// --- пакет ---

function documentXml(meta: Record<string, string>): string {
  // Стиль «No Style» — запасные значения для ячеек, которые фигуры не переопределяют.
  // DocumentSheet хранит сведения о сессии: по ним импорт убеждается, что файл — из этого приложения.
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<VisioDocument xmlns="${NS}" xmlns:r="${NS_R}" xml:space="preserve">
<DocumentSettings TopPage="0" DefaultTextStyle="0" DefaultLineStyle="0" DefaultFillStyle="0" DefaultGuideStyle="0"/>
<Colors/>
<StyleSheets><StyleSheet ID="0" NameU="No Style" Name="No Style">
<Cell N="EnableLineProps" V="1"/><Cell N="EnableFillProps" V="1"/><Cell N="EnableTextProps" V="1"/><Cell N="HideForApply" V="0"/>
<Cell N="LineWeight" V="0.01388888888888889"/><Cell N="LineColor" V="#000000"/><Cell N="LinePattern" V="1"/><Cell N="Rounding" V="0"/>
<Cell N="BeginArrow" V="0"/><Cell N="EndArrow" V="0"/><Cell N="BeginArrowSize" V="2"/><Cell N="EndArrowSize" V="1"/>
<Cell N="FillForegnd" V="#ffffff"/><Cell N="FillBkgnd" V="#ffffff"/><Cell N="FillPattern" V="1"/>
<Cell N="LeftMargin" V="0.05555555555555555"/><Cell N="RightMargin" V="0.05555555555555555"/><Cell N="TopMargin" V="0.05555555555555555"/><Cell N="BottomMargin" V="0.05555555555555555"/>
<Cell N="VerticalAlign" V="1"/><Cell N="TextBkgnd" V="0"/>
<Section N="Character"><Row IX="0"><Cell N="Size" V="0.1666666666666667"/><Cell N="Color" V="#000000"/><Cell N="Style" V="0"/></Row></Section>
<Section N="Paragraph"><Row IX="0"><Cell N="HorzAlign" V="1"/></Row></Section>
</StyleSheet></StyleSheets>
<DocumentSheet NameU="TheDoc" Name="TheDoc" LineStyle="0" FillStyle="0" TextStyle="0">${userRows({ pm_fmt: VSDX_FORMAT, ...meta })}</DocumentSheet>
</VisioDocument>`;
}

/** Без части windows.xml Visio считает пакет недопустимым и не открывает файл. */
function windowsXml(first: Page): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Windows xmlns="${NS}" xmlns:r="${NS_R}" xml:space="preserve" ClientWidth="1200" ClientHeight="800"><Window ID="0" WindowType="Drawing" WindowState="1073741824" WindowLeft="0" WindowTop="0" WindowWidth="1200" WindowHeight="800" ContainerType="Page" Page="0" ViewScale="-1" ViewCenterX="${num(first.widthIn / 2)}" ViewCenterY="${num(first.heightIn / 2)}"/></Windows>`;
}

function pagesXml(pages: Page[]): string {
  const items = pages
    .map(
      (p, i) =>
        `<Page ID="${i}" NameU="${esc(p.name)}" Name="${esc(p.name)}" ViewScale="-1" ViewCenterX="${num(p.widthIn / 2)}" ViewCenterY="${num(p.heightIn / 2)}"><PageSheet LineStyle="0" FillStyle="0" TextStyle="0"><Cell N="PageWidth" V="${num(p.widthIn)}"/><Cell N="PageHeight" V="${num(p.heightIn)}"/><Cell N="PageScale" V="1"/><Cell N="DrawingScale" V="1"/><Cell N="DrawingSizeType" V="3"/><Cell N="DrawingScaleType" V="0"/>${userRows(p.meta)}</PageSheet><Rel r:id="rId${i + 1}"/></Page>`
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Pages xmlns="${NS}" xmlns:r="${NS_R}" xml:space="preserve">${items}</Pages>`;
}

const rels = (items: { id: string; type: string; target: string }[]) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${REL_NS}">${items.map((r) => `<Relationship Id="${r.id}" Type="${r.type}" Target="${r.target}"/>`).join("")}</Relationships>`;

/** Упаковывает страницы в OPC-пакет .vsdx. */
export async function packVsdx(pages: Page[], docMeta: Record<string, string> = {}, masters: StencilMaster[] = []): Promise<Buffer> {
  const zip = new JSZip();
  // без записей каталогов: OPC-пакет — плоский список частей
  const put = (name: string, data: string) => zip.file(name, data, { createFolders: false });
  put(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/visio/document.xml" ContentType="application/vnd.ms-visio.drawing.main+xml"/><Override PartName="/visio/windows.xml" ContentType="application/vnd.ms-visio.windows+xml"/><Override PartName="/visio/pages/pages.xml" ContentType="application/vnd.ms-visio.pages+xml"/>${pages
      .map((_, i) => `<Override PartName="/visio/pages/page${i + 1}.xml" ContentType="application/vnd.ms-visio.page+xml"/>`)
      .join("")}${
      masters.length
        ? `<Override PartName="/visio/masters/masters.xml" ContentType="application/vnd.ms-visio.masters+xml"/>` +
          masters.map((_, i) => `<Override PartName="/visio/masters/master${i + 1}.xml" ContentType="application/vnd.ms-visio.master+xml"/>`).join("")
        : ""
    }</Types>`
  );
  put("_rels/.rels", rels([{ id: "rId1", type: `${VISIO_REL}/document`, target: "visio/document.xml" }]));
  put("visio/document.xml", documentXml(docMeta));
  put(
    "visio/_rels/document.xml.rels",
    rels([
      { id: "rId1", type: `${VISIO_REL}/pages`, target: "pages/pages.xml" },
      { id: "rId2", type: `${VISIO_REL}/windows`, target: "windows.xml" },
      ...(masters.length ? [{ id: "rId3", type: `${VISIO_REL}/masters`, target: "masters/masters.xml" }] : []),
    ])
  );
  if (masters.length) {
    put("visio/masters/masters.xml", mastersXml(masters));
    put("visio/masters/_rels/masters.xml.rels", rels(masters.map((_, i) => ({ id: `rId${i + 1}`, type: `${VISIO_REL}/master`, target: `master${i + 1}.xml` }))));
    masters.forEach((m, i) => put(`visio/masters/master${i + 1}.xml`, m.page.masterContentXml()));
  }
  put("visio/windows.xml", windowsXml(pages[0]));
  put("visio/pages/pages.xml", pagesXml(pages));
  put("visio/pages/_rels/pages.xml.rels", rels(pages.map((_, i) => ({ id: `rId${i + 1}`, type: `${VISIO_REL}/page`, target: `page${i + 1}.xml` }))));
  pages.forEach((p, i) => put(`visio/pages/page${i + 1}.xml`, p.contentXml()));

  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

/**
 * Собирает .vsdx со всеми диаграммами модели. docMeta (session, base) записывается в документ,
 * чтобы импорт мог проверить, что файл относится к той же сессии и не устарел.
 */
export async function buildVsdx(model: ProcessLogicModel, docMeta: Record<string, string> = {}): Promise<Buffer> {
  const bpmn = await generateBpmn(model);
  const idef0 = buildIdef0Diagrams(model);
  const codes = idef0Codes(model);
  // диаграммы BPMN операций — по странице на каждую, после общей схемы
  const scopes = [...new Set(model.nodes.map((n) => n.bpmn_scope).filter((s): s is string => !!s))];
  const scoped = await Promise.all(scopes.map(async (s) => ({ scope: s, code: codes.get(s) ?? s, d: (await generateBpmn(model, s)).diagram })));
  const rootName = isStructured(model) ? `IDEF0 ${idef0.root.code}` : "IDEF0 A0";

  const contextPage = idef0Page(idef0.context, isStructured(model) ? `IDEF0 ${idef0.context.code} контекст` : "IDEF0 A-0", model, "context");
  const rootPage = idef0Page(idef0.root, rootName, model, "root");
  const childPages = idef0.children.map((c) => ({ parentNodeId: c.parentNodeId, page: idef0Page(c, `IDEF0 ${c.code}`, model, "child", c.parentNodeId) }));
  const bpmnPages = scoped.map((s) => ({ scope: s.scope, page: bpmnPage(s.d, `BPMN ${s.code}`, model, s.scope, codes.get(s.scope) ?? "") }));
  const schemePage = bpmnPage(bpmn.diagram, "BPMN", model, null, processCodeOf(model));

  // имена страниц Visio уникальны и без запрещённых символов
  if (isStructured(model)) {
    // порядок атласа процесса, как в документах организации: контекст A-0 → A0 → для каждого подпроцесса его диаграмма IDEF0 и
    // BPMN его операций → операции, не вошедшие в декомпозицию → общая схема процесса
    const used = new Set<string>();
    const ordered = [contextPage, rootPage];
    for (const child of childPages) {
      ordered.push(child.page);
      for (const op of model.nodes.filter((n) => n.idef0_parent === child.parentNodeId)) {
        const found = bpmnPages.find((b) => b.scope === op.id);
        if (found && !used.has(op.id)) {
          used.add(op.id);
          ordered.push(found.page);
        }
      }
    }
    for (const b of bpmnPages) if (!used.has(b.scope)) ordered.push(b.page);
    ordered.push(schemePage);
    return packVsdx(ordered, docMeta, stencilMasters());
  }
  return packVsdx([schemePage, ...bpmnPages.map((b) => b.page), contextPage, rootPage, ...childPages.map((c) => c.page)], docMeta, stencilMasters());
}
