import type { FreeImage, ProcessLogicModel } from "../../types";

type M = ProcessLogicModel;

/**
 * В12: рисунки на диаграмме IDEF0. Как и свободные текстовые блоки, хранятся по диаграмме:
 * ключ "" — верхняя, иначе id функции. Картинка лежит в модели целиком (data URL), поэтому
 * диаграмма самодостаточна: её видно и в SVG, и в печати.
 */
export const imagesOf = (m: M, parentId: string | null): FreeImage[] => m.idef0_images?.[parentId ?? ""] ?? [];

/** Пределы: файл больше — не берём (модель раздуется), картинка показывается не крупнее 480×360. */
export const IMAGE_MAX_CHARS = 400_000;
export const IMAGE_BOX = { w: 480, h: 360 };
export const IMAGE_MIN = { w: 40, h: 30 };

/** Вписать картинку в IMAGE_BOX с сохранением пропорций — так рисунок не растягивается при вставке. */
export function fitImage(w: number, h: number): { w: number; h: number } {
  const k = Math.min(1, IMAGE_BOX.w / Math.max(1, w), IMAGE_BOX.h / Math.max(1, h));
  return { w: Math.max(IMAGE_MIN.w, Math.round(w * k)), h: Math.max(IMAGE_MIN.h, Math.round(h * k)) };
}

const setFor = (m: M, parentId: string | null, list: FreeImage[]): M => {
  const key = parentId ?? "";
  const all = { ...(m.idef0_images ?? {}) };
  if (list.length) all[key] = list;
  else delete all[key];
  if (Object.keys(all).length) return { ...m, idef0_images: all };
  const { idef0_images: _drop, ...rest } = m;
  return rest as M;
};

export function addImage(m: M, parentId: string | null, file: { name: string; data: string; w: number; h: number }, x: number, y: number): { model: M; id: string } {
  const list = imagesOf(m, parentId);
  const ids = new Set(Object.values(m.idef0_images ?? {}).flat().map((i) => i.id));
  let n = list.length + 1;
  while (ids.has(`img${n}`)) n++;
  const id = `img${n}`;
  const size = fitImage(file.w, file.h);
  return { model: setFor(m, parentId, [...list, { id, name: file.name, data: file.data, x: Math.max(0, Math.round(x)), y: Math.max(0, Math.round(y)), ...size }]), id };
}

/** Правка рисунка по id на любой диаграмме. */
export function updateImage(m: M, id: string, patch: Partial<Omit<FreeImage, "id">>): M {
  const all = { ...(m.idef0_images ?? {}) };
  let touched = false;
  for (const [key, list] of Object.entries(all)) {
    if (!list.some((i) => i.id === id)) continue;
    all[key] = list.map((i) => (i.id === id ? { ...i, ...patch } : i));
    touched = true;
  }
  return touched ? { ...m, idef0_images: all } : m;
}

export const moveImage = (m: M, id: string, x: number, y: number): M => updateImage(m, id, { x: Math.max(0, Math.round(x)), y: Math.max(0, Math.round(y)) });

export const resizeImage = (m: M, id: string, w: number, h: number): M => updateImage(m, id, { w: Math.max(IMAGE_MIN.w, Math.round(w)), h: Math.max(IMAGE_MIN.h, Math.round(h)) });

export function deleteImage(m: M, id: string): M {
  const all = { ...(m.idef0_images ?? {}) };
  let touched = false;
  for (const [key, list] of Object.entries(all)) {
    const next = list.filter((i) => i.id !== id);
    if (next.length === list.length) continue;
    touched = true;
    if (next.length) all[key] = next;
    else delete all[key];
  }
  if (!touched) return m;
  return Object.keys(all).length ? { ...m, idef0_images: all } : (({ idef0_images: _drop, ...rest }) => rest as M)(m);
}

export const findImage = (m: M, id: string): FreeImage | undefined => Object.values(m.idef0_images ?? {}).flat().find((i) => i.id === id);