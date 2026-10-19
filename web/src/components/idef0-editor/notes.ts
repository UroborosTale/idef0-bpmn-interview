import { wrapText } from "@shared/bpmnLabels";
import type { FreeNote, ProcessLogicModel } from "../../types";

type M = ProcessLogicModel;

/**
 * В12: свободные текстовые блоки на диаграмме IDEF0. Хранятся в модели по диаграмме: ключ "" — верхняя,
 * иначе id функции. Примечание к самой функции — отдельное поле note узла, это другой блок (у блока).
 */
export const notesOf = (m: M, parentId: string | null): FreeNote[] => m.idef0_notes?.[parentId ?? ""] ?? [];

/** Размер нового блока и перенос текста: около 22 знаков на 150 px, как у примечания к функции. */
export const NOTE_SIZE = { w: 180, h: 60 };
export const noteLines = (text: string, w = NOTE_SIZE.w): string[] => wrapText(text, Math.max(8, Math.floor((w - 10) / 6.4)), 12);

/** Записать список блоков диаграммы; пустой список убирает ключ, пустая запись — поле целиком. */
const setFor = (m: M, parentId: string | null, list: FreeNote[]): M => {
  const key = parentId ?? "";
  const all = { ...(m.idef0_notes ?? {}) };
  if (list.length) all[key] = list;
  else delete all[key];
  if (Object.keys(all).length) return { ...m, idef0_notes: all };
  const { idef0_notes: _drop, ...rest } = m;
  return rest as M;
};

export function addNote(m: M, parentId: string | null, x: number, y: number, text = "Примечание"): { model: M; id: string } {
  const list = notesOf(m, parentId);
  const ids = new Set(Object.values(m.idef0_notes ?? {}).flat().map((n) => n.id));
  let i = list.length + 1;
  while (ids.has(`note${i}`)) i++;
  const id = `note${i}`;
  return { model: setFor(m, parentId, [...list, { id, text, x, y, ...NOTE_SIZE }]), id };
}

/** Правка блока по id на любой диаграмме: панели свойств не нужно знать, на какой диаграмме он лежит. */
export function updateNote(m: M, id: string, patch: Partial<Omit<FreeNote, "id">>): M {
  const all = { ...(m.idef0_notes ?? {}) };
  let touched = false;
  for (const [key, list] of Object.entries(all)) {
    if (!list.some((n) => n.id === id)) continue;
    all[key] = list.map((n) => (n.id === id ? { ...n, ...patch } : n));
    touched = true;
  }
  return touched ? { ...m, idef0_notes: all } : m;
}

/** Наименьший блок: меньше — текст уже не читается. */
export const NOTE_MIN = { w: 100, h: 40 };

/** Перетаскивание: положение не уходит за край листа (0, 0). */
export const moveNote = (m: M, id: string, x: number, y: number): M =>
  updateNote(m, id, { x: Math.max(0, Math.round(x)), y: Math.max(0, Math.round(y)) });

/** Растягивание за угол: размер не меньше NOTE_MIN. */
export const resizeNote = (m: M, id: string, w: number, h: number): M =>
  updateNote(m, id, { w: Math.max(NOTE_MIN.w, Math.round(w)), h: Math.max(NOTE_MIN.h, Math.round(h)) });

export function deleteNote(m: M, id: string): M {
  const all = { ...(m.idef0_notes ?? {}) };
  let touched = false;
  for (const [key, list] of Object.entries(all)) {
    const next = list.filter((n) => n.id !== id);
    if (next.length === list.length) continue;
    touched = true;
    if (next.length) all[key] = next;
    else delete all[key];
  }
  if (!touched) return m;
  return Object.keys(all).length ? { ...m, idef0_notes: all } : (({ idef0_notes: _drop, ...rest }) => rest as M)(m);
}

export const findNote = (m: M, id: string): FreeNote | undefined => Object.values(m.idef0_notes ?? {}).flat().find((n) => n.id === id);
