import type { ProcessLogicModel, ProcessNode } from "../../types";
import { deleteNode, nextId } from "../bpmn-editor/model-ops";
import { MIN_POS, buildIdef0, snap, type Box } from "./geometry";
import { routesForCopy, shiftRoutes } from "./arrow-edit";

type M = ProcessLogicModel;

/**
 * Операции над несколькими блоками диаграммы IDEF0: выделение рамкой, перенос группой, копирование и вставка (в том числе
 * в другую диаграмму), выравнивание, удаление. Чистые функции; диаграмма — функции одного родителя (parentId; null — A0).
 */

const intersects = (a: Box, b: Box) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

/** Рамки блоков диаграммы в порядке отрисовки (с учётом положения по умолчанию у блоков без позиции). */
export function blockBoxes(m: M, parentId: string | null): Map<string, Box> {
  return new Map(buildIdef0(m, parentId).functions.map((f) => [f.node.id, f.box as Box] as const));
}

export const selectableIds = (m: M, parentId: string | null): string[] => [...blockBoxes(m, parentId).keys()];

/** Блоки, попавшие в рамку выделения хотя бы частью. */
export function blocksInRect(m: M, parentId: string | null, rect: Box): string[] {
  return [...blockBoxes(m, parentId)].filter(([, b]) => intersects(b, rect)).map(([id]) => id);
}

/** Общая рамка набора блоков (для «приблизить к выделению»); null — если блоков нет. */
export function boundsOf(m: M, parentId: string | null, ids: string[]): Box | null {
  const boxes = blockBoxes(m, parentId);
  const list = ids.map((id) => boxes.get(id)).filter((b): b is Box => !!b);
  if (list.length === 0) return null;
  const x = Math.min(...list.map((b) => b.x));
  const y = Math.min(...list.map((b) => b.y));
  return { x, y, w: Math.max(...list.map((b) => b.x + b.w)) - x, h: Math.max(...list.map((b) => b.y + b.h)) - y };
}

/** Новые положения блоков; маршруты их стрелок едут вместе с ними, а у связи внутри перемещаемой группы — и изломы (источник тоже сдвинулся). */
const place = (m: M, pos: Map<string, { x: number; y: number }>): M => ({
  ...m,
  nodes: m.nodes.map((n) => {
    const to = pos.get(n.id);
    if (!to) return n;
    const from = n.idef0_layout;
    const producerMoves = (entity: string) => m.nodes.some((p) => p.id !== n.id && pos.has(p.id) && p.outputs.includes(entity));
    const moved = from ? shiftRoutes(n, to.x - from.x, to.y - from.y, producerMoves) : n;
    return { ...moved, idef0_layout: to };
  }),
});

/** Сдвиг группы от исходного положения base; блоки не уходят левее и выше поля стрелок (MIN_POS). */
export function moveGroup(base: M, parentId: string | null, ids: string[], dx: number, dy: number): M {
  const boxes = blockBoxes(base, parentId);
  const picked = ids.map((id) => boxes.get(id)).filter((b): b is Box => !!b);
  if (picked.length === 0) return base;
  const sx = Math.max(dx, MIN_POS - Math.min(...picked.map((b) => b.x)));
  const sy = Math.max(dy, MIN_POS - Math.min(...picked.map((b) => b.y)));
  return place(base, new Map(ids.filter((id) => boxes.has(id)).map((id) => [id, { x: snap(boxes.get(id)!.x + sx), y: snap(boxes.get(id)!.y + sy) }] as const)));
}

/** Есть ли у выбранных блоков вложенные функции (декомпозиция): копия их не переносит, а удаление уничтожает. */
export const hasDecomposition = (m: M, ids: string[]): boolean => m.nodes.some((n) => n.idef0_parent !== null && n.idef0_parent !== undefined && ids.includes(n.idef0_parent));

export const deleteGroup = (m: M, ids: string[]): M => ids.reduce((acc, id) => deleteNode(acc, id), m);

/** Выровнять левые края по самому левому блоку. */
export function alignLeft(m: M, parentId: string | null, ids: string[]): M {
  const ref = boundsOf(m, parentId, ids);
  if (!ref) return m;
  const boxes = blockBoxes(m, parentId);
  return place(m, new Map(ids.filter((id) => boxes.has(id)).map((id) => [id, { x: ref.x, y: boxes.get(id)!.y }] as const)));
}

/** Выровнять верхние края по самому верхнему блоку. */
export function alignTop(m: M, parentId: string | null, ids: string[]): M {
  const ref = boundsOf(m, parentId, ids);
  if (!ref) return m;
  const boxes = blockBoxes(m, parentId);
  return place(m, new Map(ids.filter((id) => boxes.has(id)).map((id) => [id, { x: boxes.get(id)!.x, y: ref.y }] as const)));
}

/** Равные промежутки по горизонтали (крайние блоки остаются на месте); нужно три блока. */
export function distributeHorizontally(m: M, parentId: string | null, ids: string[]): M {
  const boxes = blockBoxes(m, parentId);
  const picked = ids.filter((id) => boxes.has(id)).sort((a, b) => boxes.get(a)!.x - boxes.get(b)!.x);
  if (picked.length < 3) return m;
  const first = boxes.get(picked[0])!;
  const last = boxes.get(picked[picked.length - 1])!;
  const gap = (last.x + last.w - first.x - picked.reduce((s, id) => s + boxes.get(id)!.w, 0)) / (picked.length - 1);
  const pos = new Map<string, { x: number; y: number }>();
  let x = first.x;
  for (const id of picked) {
    pos.set(id, { x: snap(x), y: boxes.get(id)!.y });
    x += boxes.get(id)!.w + gap;
  }
  return place(m, pos);
}

/** Равные промежутки по вертикали (крайние блоки остаются на месте); нужно три блока. */
export function distributeVertically(m: M, parentId: string | null, ids: string[]): M {
  const boxes = blockBoxes(m, parentId);
  const picked = ids.filter((id) => boxes.has(id)).sort((a, b) => boxes.get(a)!.y - boxes.get(b)!.y);
  if (picked.length < 3) return m;
  const first = boxes.get(picked[0])!;
  const last = boxes.get(picked[picked.length - 1])!;
  const gap = (last.y + last.h - first.y - picked.reduce((s, id) => s + boxes.get(id)!.h, 0)) / (picked.length - 1);
  const pos = new Map<string, { x: number; y: number }>();
  let y = first.y;
  for (const id of picked) {
    pos.set(id, { x: boxes.get(id)!.x, y: snap(y) });
    y += boxes.get(id)!.h + gap;
  }
  return place(m, pos);
}

// --- копирование и вставка ---

/** Скопированные блоки. Вложенные функции (декомпозиция) не копируются — только сами блоки со своими стрелками (данными). */
export interface Fragment {
  nodes: ProcessNode[];
}

/** Фрагмент для буфера; null — копировать нечего. Источники в интервью и подтверждения не копируются. */
export function copyFragment(m: M, parentId: string | null, ids: string[]): Fragment | null {
  const boxes = blockBoxes(m, parentId);
  // положение берём с диаграммы, а не из модели: у блоков, которые не двигали, своей позиции в модели ещё нет
  const nodes = m.nodes.filter((n) => ids.includes(n.id) && boxes.has(n.id)).map((n) => ({ ...structuredClone(n), idef0_layout: { x: boxes.get(n.id)!.x, y: boxes.get(n.id)!.y } }));
  return nodes.length > 0 ? { nodes } : null;
}

/**
 * Вставляет фрагмент на диаграмму parentId со сдвигом: новые id, к названию добавляется «(копия)» (названия функций уникальны),
 * положение блоков сохраняется относительно друг друга. Возвращает модель и id вставленных блоков.
 */
export function pasteFragment(m: M, parentId: string | null, frag: Fragment, dx: number, dy: number, reserved: string[] = []): { model: M; ids: string[] } {
  const used = [...m.nodes.map((n) => n.id), ...reserved];
  const names = new Set(m.nodes.map((n) => n.name));
  const uniqueName = (name: string) => {
    let candidate = names.has(name) ? `${name} (копия)` : name;
    for (let i = 2; names.has(candidate); i++) candidate = `${name} (копия ${i})`;
    names.add(candidate);
    return candidate;
  };
  const nodes = frag.nodes.map((n): ProcessNode => {
    const id = nextId("n", used);
    used.push(id);
    const at = n.idef0_layout ?? { x: MIN_POS, y: MIN_POS };
    const to = { x: Math.max(MIN_POS, snap(at.x + dx)), y: Math.max(MIN_POS, snap(at.y + dy)) };
    return {
      ...routesForCopy(structuredClone(n), to.x - at.x, to.y - at.y),
      id,
      name: uniqueName(n.name),
      idef0_parent: parentId,
      bpmn_scope: null,
      layout: null,
      idef0_layout: to,
      source: [],
      confirmed_by: [],
      requirement_ids: [],
      status: "confirmed",
      confidence: 1,
    };
  });
  return { model: { ...m, nodes: [...m.nodes, ...nodes] }, ids: nodes.map((n) => n.id) };
}

// Буфер обмена редактора IDEF0: общий для всех диаграмм, чтобы блоки можно было вставить на другой уровень.
let clipboard: { fragment: Fragment; pastes: number } | null = null;
export const setClipboard = (fragment: Fragment | null) => {
  clipboard = fragment ? { fragment, pastes: 0 } : null;
};
export const hasClipboard = () => !!clipboard;
/** Фрагмент из буфера и порядковый номер вставки (каждая следующая вставка смещается дальше). */
export function takeClipboard(): { fragment: Fragment; n: number } | null {
  if (!clipboard) return null;
  clipboard.pastes += 1;
  return { fragment: clipboard.fragment, n: clipboard.pastes };
}