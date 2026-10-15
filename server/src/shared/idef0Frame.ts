/**
 * Рамка листа диаграммы IDEF0: клетчатое поле, контур и штамп внизу (NODE — номер узла, TITLE — название, NO. — номер листа).
 * Геометрия общая для редактора в браузере и SVG-выгрузки, поэтому нарисованное и экспортированное совпадает. Все надписи
 * штампа — и подписи, и значения — можно переопределить; настройки хранятся в модели по диаграммам (ключ — frameKey).
 */

export type FrameField = "nodeLabel" | "node" | "titleLabel" | "title" | "noLabel" | "no";

export const FRAME_FIELDS: FrameField[] = ["nodeLabel", "node", "titleLabel", "title", "noLabel", "no"];

/** Настройки рамки одной диаграммы; незаданное — по умолчанию (рамка и сетка включены, надписи автоматические). */
export interface IdefFrame {
  show?: boolean;
  grid?: boolean;
  /** Лист, заданный вручную: положение левого верхнего угла и размер поля (без штампа). Без w и h лист занимает диаграмму. */
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  texts?: Partial<Record<FrameField, string>>;
}

export interface FrameDefaults {
  node: string;
  title: string;
  no: string;
}

export const FRAME_H = 12; // высота штампа: у Business Studio он узкая полоса под листом
export const FRAME_GRID = 40; // шаг клеток (у Business Studio — около сантиметра)
export const FRAME_MAJOR = 1_000_000; // выделенных линий сетки у Business Studio нет: все клетки одинаковые
const MAX_LINES = 400;
/** Ширина ячейки NODE (15 % листа, не меньше 90) и ячейки NO. (не меньше 56): доли штампа Business Studio. */
const nodeWidth = (w: number) => Math.max(90, Math.round(w * 0.154));
const noWidth = (w: number) => Math.max(56, Math.round(w * 0.035));
/** Размер шрифта надписей штампа (px): мелкий, как в Business Studio. */
export const FRAME_FONT = 7.5;

const LABELS: Record<"nodeLabel" | "titleLabel" | "noLabel", string> = { nodeLabel: "NODE:", titleLabel: "TITLE:", noLabel: "NO.:" };

/** Ключ настроек: диаграмма функции по её id, верхняя диаграмма — пустая строка, контекстная — "ctx". */
export const frameKey = (parentId: string | null) => parentId ?? "";

export const frameShown = (f: IdefFrame | undefined) => f?.show !== false;
/** На диаграммах BPMN рамка листа по умолчанию выключена: её включают в меню «Лист» для нужной диаграммы. */
export const bpmnFrameShown = (f: IdefFrame | undefined) => f?.show === true;

/** Штамп листа BPMN по умолчанию: код и название операции (у общей схемы — процесса), номер листа. */
export const bpmnFrameDefaults = (code: string, name: string): FrameDefaults => ({ node: code || "BPMN", title: `${code} ${name}`.trim(), no: "1.0" });

/** Поле вокруг диаграммы BPMN под автоматическим листом: края листа не совпадают с краями дорожек и их ручками. */
export const BPMN_SHEET_MARGIN = 40;

/** «Мир» диаграммы BPMN для листа: содержимое с полем справа и снизу. */
export const bpmnSheetWorld = (world: { w: number; h: number }) => ({ w: world.w + BPMN_SHEET_MARGIN, h: world.h + BPMN_SHEET_MARGIN / 2 });
export const gridShown = (f: IdefFrame | undefined) => f?.grid !== false;

/** Тексты штампа: заданные вручную, иначе автоматические (пустое значение возвращает автоматическое). */
export function frameTexts(frame: IdefFrame | undefined, d: FrameDefaults): Record<FrameField, string> {
  const base: Record<FrameField, string> = { ...LABELS, node: d.node, title: d.title, no: d.no };
  const out = { ...base };
  for (const k of FRAME_FIELDS) {
    const v = frame?.texts?.[k];
    if (typeof v === "string" && v.trim()) out[k] = v;
  }
  return out;
}

export interface FrameCell {
  field: FrameField;
  /** Область, по которой щёлкают, чтобы править надпись. */
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  /** Опорная точка текста по x и выравнивание. */
  tx: number;
  anchor: "start" | "middle";
}

export interface FrameGeometry {
  /** Весь лист: поле диаграммы и штамп под ним. */
  sheet: { x: number; y: number; w: number; h: number };
  footer: { x: number; y: number; w: number; h: number };
  /** Вертикали, отделяющие ячейки штампа. */
  dividers: number[];
  gridXs: { at: number; major: boolean }[];
  gridYs: { at: number; major: boolean }[];
  cells: FrameCell[];
}

/** Стандартные форматы листа (альбомная ориентация): размер поля без штампа в пикселях при 96 dpi, кратный клетке. */
export const SHEET_FORMATS: { id: string; label: string; w: number; h: number }[] = [
  { id: "A4", label: "A4", w: 1120, h: 760 },
  { id: "A3", label: "A3", w: 1580, h: 1080 },
  { id: "A2", label: "A2", w: 2240, h: 1560 },
];

/** Формат листа по размеру поля (с учётом поворота); null — размер нестандартный. */
export function sheetFormatOf(w: number, h: number): { id: string; portrait: boolean } | null {
  for (const f of SHEET_FORMATS) {
    if (f.w === w && f.h === h) return { id: f.id, portrait: false };
    if (f.w === h && f.h === w) return { id: f.id, portrait: true };
  }
  return null;
}

/** Меньше этого размера поле листа не делают: по ширине должен поместиться штамп (NODE, TITLE хотя бы на 60 px, NO.), по высоте — 200 px. */
export const FRAME_MIN_W = 440;
export const FRAME_MIN_H = 200;

const snapUp = (v: number) => Math.ceil(v / FRAME_GRID) * FRAME_GRID;

/**
 * Поле листа (без штампа). Пока размер не задан вручную, лист занимает диаграмму от нуля (округлено до клетки) и растёт вместе
 * с ней; заданный вручную лист (x, y, w, h) стоит где поставили и не зависит от содержимого.
 */
export function frameBody(world: { w: number; h: number }, frame: IdefFrame | undefined): { x: number; y: number; w: number; h: number } {
  if (frame && typeof frame.w === "number" && typeof frame.h === "number") {
    return { x: frame.x ?? 0, y: frame.y ?? 0, w: Math.max(FRAME_MIN_W, frame.w), h: Math.max(FRAME_MIN_H, frame.h) };
  }
  return { x: 0, y: 0, w: snapUp(world.w), h: snapUp(world.h) };
}

/** Геометрия листа для «мира» диаграммы w × h; штамп добавляется под полем листа. */
export function frameGeometry(world: { w: number; h: number }, frame: IdefFrame | undefined, d: FrameDefaults): FrameGeometry {
  const body = frameBody(world, frame);
  const { x: ox, y: oy, w, h: bodyH } = body;
  const sheet = { x: ox, y: oy, w, h: bodyH + FRAME_H };
  const footer = { x: ox, y: oy + bodyH, w, h: FRAME_H };
  const t = frameTexts(frame, d);
  const NODE_W = nodeWidth(w);
  const NO_W = noWidth(w);
  const noX = ox + w - NO_W;
  // на очень больших листах шаг клеток растёт, чтобы линий было не больше MAX_LINES на сторону
  const lines = (origin: number, len: number) => {
    const step = FRAME_GRID * Math.max(1, Math.ceil(len / FRAME_GRID / MAX_LINES));
    return Array.from({ length: Math.max(0, Math.ceil(len / step) - 1) }, (_, i) => ({ at: origin + (i + 1) * step, major: (i + 1) % FRAME_MAJOR === 0 }));
  };
  const y = footer.y;
  const nx = ox + NODE_W;
  // как в Business Studio: «NODE:» у левого края ячейки, значение — по её центру, «TITLE:» у левого края, название — по центру,
  // «NO.:» и номер листа — в узкой ячейке справа
  const labelW = { node: 38, title: 34, no: 22 };
  const cells: FrameCell[] = [
    { field: "nodeLabel", x: ox, y, w: labelW.node, h: FRAME_H, text: t.nodeLabel, tx: ox + 3, anchor: "start" },
    { field: "node", x: ox + labelW.node, y, w: NODE_W - labelW.node, h: FRAME_H, text: t.node, tx: (ox + labelW.node + nx) / 2, anchor: "middle" },
    { field: "titleLabel", x: nx, y, w: labelW.title, h: FRAME_H, text: t.titleLabel, tx: nx + 3, anchor: "start" },
    { field: "title", x: nx + labelW.title, y, w: noX - nx - labelW.title, h: FRAME_H, text: t.title, tx: (nx + labelW.title + noX) / 2, anchor: "middle" },
    { field: "noLabel", x: noX, y, w: labelW.no, h: FRAME_H, text: t.noLabel, tx: noX + 3, anchor: "start" },
    { field: "no", x: noX + labelW.no, y, w: NO_W - labelW.no, h: FRAME_H, text: t.no, tx: noX + labelW.no + 3, anchor: "start" },
  ];

  return { sheet, footer, dividers: [nx, noX], gridXs: lines(ox, w), gridYs: lines(oy, bodyH), cells };
}

/** Размер «мира» — всё, что нужно показать: содержимое диаграммы и лист со штампом (где бы он ни стоял). */
export function withFrameHeight(world: { w: number; h: number }, frame: IdefFrame | undefined): { w: number; h: number } {
  if (!frameShown(frame)) return world;
  const g = frameGeometry(world, frame, { node: "", title: "", no: "" }).sheet;
  return { w: Math.max(world.w, g.x + g.w), h: Math.max(world.h, g.y + g.h) };
}
