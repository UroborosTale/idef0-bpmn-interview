import { DEFAULT_STYLES, HEX_COLOR, FONT_SIZE_MAX, FONT_SIZE_MIN, type ShapeStyle, type StyleKind } from "@shared/shapeStyles";
import type { ProcessLogicModel } from "../../types";

type M = ProcessLogicModel;

/**
 * Оформление фигур по видам. Значение, равное стандартному, в модели не хранится: модель без правок оформления остаётся
 * без поля shape_styles, а «сбросить» просто убирает вид. Неверные цвет и размер игнорируются.
 */
export function setKindStyle(m: M, kind: StyleKind, patch: ShapeStyle): M {
  const base = DEFAULT_STYLES[kind];
  const cur: ShapeStyle = { ...(m.shape_styles?.[kind] ?? {}) };
  for (const key of ["fill", "line", "text"] as const) {
    const v = patch[key];
    if (v === undefined) continue;
    if (!HEX_COLOR.test(v)) continue; // неверное значение игнорируется, прежнее остаётся
    if (v.toLowerCase() === base[key]) delete cur[key];
    else cur[key] = v.toLowerCase();
  }
  if (patch.font_size !== undefined) {
    const s = Math.round(patch.font_size);
    if (s >= FONT_SIZE_MIN && s <= FONT_SIZE_MAX) {
      if (s === base.font_size) delete cur.font_size;
      else cur.font_size = s;
    }
  }
  return withKind(m, kind, cur);
}

export const resetKindStyle = (m: M, kind: StyleKind): M => withKind(m, kind, {});

function withKind(m: M, kind: StyleKind, style: ShapeStyle): M {
  const next = { ...(m.shape_styles ?? {}) };
  if (Object.keys(style).length === 0) delete next[kind];
  else next[kind] = style;
  const { shape_styles: _old, ...rest } = m;
  return Object.keys(next).length === 0 ? (rest as M) : { ...rest, shape_styles: next };
}
