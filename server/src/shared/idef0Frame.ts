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
  texts?: Partial<Record<FrameField, string>>;
}

export interface FrameDefaults {
  node: string;
  title: string;
  no: string;
}

export const FRAME_H = 30; // высота штампа
export const FRAME_GRID = 20; // шаг клеток
export const FRAME_MAJOR = 5; // каждая пятая линия — потемнее
const MAX_LINES = 400;
const NODE_W = 170;
const NO_W = 140;
const GUIDE_W = 200; // правая полоса листа отделена пунктиром

const LABELS: Record<"nodeLabel" | "titleLabel" | "noLabel", string> = { nodeLabel: "NODE:", titleLabel: "TITLE:", noLabel: "NO.:" };

/** Ключ настроек: диаграмма функции по её id, верхняя диаграмма — пустая строка, контекстная — "ctx". */
export const frameKey = (parentId: string | null) => parentId ?? "";

export const frameShown = (f: IdefFrame | undefined) => f?.show !== false;
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
  /** Пунктир, отделяющий правую полосу листа. */
  guideX: number;
  gridXs: { at: number; major: boolean }[];
  gridYs: { at: number; major: boolean }[];
  cells: FrameCell[];
}

/** Геометрия листа для «мира» диаграммы w × h: размеры округляются до клетки, штамп добавляется снизу. */
export function frameGeometry(world: { w: number; h: number }, frame: IdefFrame | undefined, d: FrameDefaults): FrameGeometry {
  const w = Math.ceil(world.w / FRAME_GRID) * FRAME_GRID;
  const bodyH = Math.ceil(world.h / FRAME_GRID) * FRAME_GRID;
  const sheet = { x: 0, y: 0, w, h: bodyH + FRAME_H };
  const footer = { x: 0, y: bodyH, w, h: FRAME_H };
  const t = frameTexts(frame, d);
  const noX = w - NO_W;
  // на очень больших листах (блоки унесены далеко) шаг клеток растёт, чтобы линий было не больше MAX_LINES на сторону
  const lines = (len: number) => {
    const step = FRAME_GRID * Math.max(1, Math.ceil(len / FRAME_GRID / MAX_LINES));
    return Array.from({ length: Math.max(0, Math.ceil(len / step) - 1) }, (_, i) => ({ at: (i + 1) * step, major: (i + 1) % FRAME_MAJOR === 0 }));
  };
  const y = footer.y;
  const cells: FrameCell[] = [
    { field: "nodeLabel", x: 0, y, w: 70, h: FRAME_H, text: t.nodeLabel, tx: 6, anchor: "start" },
    { field: "node", x: 70, y, w: NODE_W - 70, h: FRAME_H, text: t.node, tx: 80, anchor: "start" },
    { field: "titleLabel", x: NODE_W, y, w: 70, h: FRAME_H, text: t.titleLabel, tx: NODE_W + 6, anchor: "start" },
    { field: "title", x: NODE_W + 70, y, w: noX - NODE_W - 70, h: FRAME_H, text: t.title, tx: (NODE_W + 70 + noX) / 2, anchor: "middle" },
    { field: "noLabel", x: noX, y, w: 60, h: FRAME_H, text: t.noLabel, tx: noX + 6, anchor: "start" },
    { field: "no", x: noX + 60, y, w: NO_W - 60, h: FRAME_H, text: t.no, tx: noX + 66, anchor: "start" },
  ];
  return { sheet, footer, dividers: [NODE_W, noX], guideX: w - GUIDE_W, gridXs: lines(w), gridYs: lines(bodyH), cells };
}

/** Размер «мира» вместе со штампом — для вписывания диаграммы в окно. */
export const withFrameHeight = (world: { w: number; h: number }, frame: IdefFrame | undefined) => (frameShown(frame) ? { w: world.w, h: world.h + FRAME_H } : world);
