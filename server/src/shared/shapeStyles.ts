import { eventSpec } from "./events.js";

/**
 * Оформление фигур по видам (как стили диаграммы в Business Studio): для каждого вида фигуры — заливка, цвет линии, цвет и
 * размер текста. Хранится в модели (shape_styles), одно на все диаграммы; чего нет — берётся из DEFAULT_STYLES, они совпадают
 * с прежним видом фигур, поэтому модель без стилей выглядит как раньше. Общий модуль редакторов, выгрузки VSDX и клиента
 * (web подключает его через псевдоним @shared).
 */

export const STYLE_KINDS = ["task", "subprocess", "gateway", "event_start", "event_intermediate", "event_end", "idef0_block"] as const;
export type StyleKind = (typeof STYLE_KINDS)[number];

export const STYLE_KIND_LABELS: Record<StyleKind, string> = {
  task: "Задачи BPMN",
  subprocess: "Подпроцессы BPMN",
  gateway: "Шлюзы BPMN",
  event_start: "Начальные события",
  event_intermediate: "Промежуточные и граничные события",
  event_end: "Конечные события",
  idef0_block: "Блоки функций IDEF0",
};

export interface ShapeStyle {
  /** Заливка, #rrggbb. */
  fill?: string;
  /** Цвет линии, #rrggbb. */
  line?: string;
  /** Цвет текста, #rrggbb. */
  text?: string;
  /** Размер текста, px (8…24). */
  font_size?: number;
}

export type ResolvedStyle = Required<ShapeStyle>;

export const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
export const FONT_SIZE_MIN = 8;
export const FONT_SIZE_MAX = 24;

const BPMN_INK = "#1e293b";
const IDEF0_INK = "#1f2937";

export const DEFAULT_STYLES: Record<StyleKind, ResolvedStyle> = {
  task: { fill: "#ffffff", line: BPMN_INK, text: BPMN_INK, font_size: 12 },
  subprocess: { fill: "#ffffff", line: BPMN_INK, text: BPMN_INK, font_size: 12 },
  gateway: { fill: "#ffffff", line: BPMN_INK, text: BPMN_INK, font_size: 11 },
  event_start: { fill: "#f0fdf4", line: BPMN_INK, text: BPMN_INK, font_size: 11 },
  event_intermediate: { fill: "#ffffff", line: BPMN_INK, text: BPMN_INK, font_size: 11 },
  event_end: { fill: "#fef2f2", line: BPMN_INK, text: BPMN_INK, font_size: 11 },
  idef0_block: { fill: "#eef2ff", line: IDEF0_INK, text: IDEF0_INK, font_size: 12 },
};

/** Модель, у которой могут быть стили. */
export interface StyledModel {
  shape_styles?: Partial<Record<StyleKind, ShapeStyle>>;
}

/** Стиль вида с учётом заданного в модели; неверные значения (не цвет, размер вне границ) игнорируются. */
export function styleOf(m: StyledModel | undefined, kind: StyleKind): ResolvedStyle {
  const base = DEFAULT_STYLES[kind];
  const own = m?.shape_styles?.[kind];
  if (!own) return base;
  const size = own.font_size;
  return {
    fill: own.fill && HEX_COLOR.test(own.fill) ? own.fill : base.fill,
    line: own.line && HEX_COLOR.test(own.line) ? own.line : base.line,
    text: own.text && HEX_COLOR.test(own.text) ? own.text : base.text,
    font_size: typeof size === "number" && size >= FONT_SIZE_MIN && size <= FONT_SIZE_MAX ? size : base.font_size,
  };
}

/** Вид стиля шага диаграммы BPMN: задача, подпроцесс, шлюз или событие (граничное считается промежуточным). */
export function styleKindOf(node: { type: string; subtype?: string | null; trigger?: unknown; attached_to?: string | null }, boundary = false): StyleKind | null {
  if (node.type === "task") return "task";
  if (node.type === "subprocess") return "subprocess";
  if (node.type === "gateway") return "gateway";
  if (node.type !== "event") return null;
  if (boundary) return "event_intermediate";
  const position = eventSpec(node as Parameters<typeof eventSpec>[0], false).position;
  return position === "start" ? "event_start" : position === "end" ? "event_end" : "event_intermediate";
}

/** Заданы ли у вида собственные значения (для кнопки «Сбросить»). */
export const hasOwnStyle = (m: StyledModel | undefined, kind: StyleKind): boolean => !!m?.shape_styles?.[kind] && Object.keys(m.shape_styles[kind]!).length > 0;

/** Только заданные в модели и верные значения стиля вида: выгрузка подставляет их поверх своих значений по умолчанию. */
export function ownStyle(m: StyledModel | undefined, kind: StyleKind): ShapeStyle {
  const own = m?.shape_styles?.[kind];
  if (!own) return {};
  const out: ShapeStyle = {};
  if (own.fill && HEX_COLOR.test(own.fill)) out.fill = own.fill;
  if (own.line && HEX_COLOR.test(own.line)) out.line = own.line;
  if (own.text && HEX_COLOR.test(own.text)) out.text = own.text;
  if (typeof own.font_size === "number" && own.font_size >= FONT_SIZE_MIN && own.font_size <= FONT_SIZE_MAX) out.font_size = own.font_size;
  return out;
}
