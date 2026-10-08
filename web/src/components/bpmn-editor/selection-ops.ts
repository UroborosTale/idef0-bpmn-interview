import type { ProcessFlow, ProcessLogicModel, ProcessNode } from "../../types";
import { MIN_X, boxMap, boxOf, isBoundary, snap, visibleNodes, type Box } from "./geometry";
import { deleteNode, dropNodeIntoLane, nextId } from "./model-ops";

/**
 * Операции над несколькими фигурами диаграммы: выделение рамкой, перенос группой, копирование и вставка фрагмента
 * (в том числе в другую диаграмму), выравнивание. Чистые функции над видом диаграммы (scopeView).
 */

type M = ProcessLogicModel;

/** Фигуры, которые можно выделять группой: граничные события едут вместе со своей задачей и отдельно не выбираются. */
export function selectableIds(m: M): string[] {
  const shown = visibleNodes(m);
  return shown.filter((n) => !isBoundary(n, shown)).map((n) => n.id);
}

const intersects = (a: Box, b: Box) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

/** Фигуры, попавшие в рамку выделения (хотя бы частью), в порядке модели. */
export function nodesInRect(m: M, rect: { x: number; y: number; w: number; h: number }): string[] {
  const boxes = boxMap(visibleNodes(m));
  return selectableIds(m).filter((id) => intersects(boxes.get(id)!, rect));
}

/** Общая рамка набора фигур (для «приблизить к выделению»); null — если фигур нет. */
export function boundsOf(m: M, ids: string[]): Box | null {
  const boxes = boxMap(visibleNodes(m));
  const list = ids.map((id) => boxes.get(id)).filter((b): b is Box => !!b);
  if (list.length === 0) return null;
  const x = Math.min(...list.map((b) => b.x));
  const y = Math.min(...list.map((b) => b.y));
  return { x, y, w: Math.max(...list.map((b) => b.x + b.w)) - x, h: Math.max(...list.map((b) => b.y + b.h)) - y };
}

/** Сдвиг группы от исходного положения; фигуры не уходят левее поля дорожек. Дорожку определяет drop (после отпускания). */
export function moveGroup(base: M, ids: string[], dx: number, dy: number): M {
  const set = new Set(ids);
  const minX = Math.min(...base.nodes.filter((n) => set.has(n.id)).map((n) => boxOf(n).x), Infinity);
  const sx = Number.isFinite(minX) ? Math.max(dx, MIN_X - minX) : dx;
  return {
    ...base,
    nodes: base.nodes.map((n) => {
      if (!set.has(n.id)) return n;
      const b = boxOf(n);
      return { ...n, layout: { x: snap(b.x + sx), y: snap(b.y + dy) } };
    }),
  };
}

/** После переноса группы каждая фигура становится в дорожку под своим центром. */
export const dropGroup = (m: M, ids: string[]): M => ids.reduce((acc, id) => dropNodeIntoLane(acc, id), m);

export function deleteGroup(m: M, ids: string[]): M {
  return ids.reduce((acc, id) => deleteNode(acc, id), m);
}

/** Выровнять левые края группы по самой левой фигуре. */
export function alignLeft(m: M, ids: string[]): M {
  const ref = boundsOf(m, ids);
  if (!ref) return m;
  const set = new Set(ids);
  return { ...m, nodes: m.nodes.map((n) => (set.has(n.id) ? { ...n, layout: { x: ref.x, y: boxOf(n).y } } : n)) };
}

/** Выровнять центры фигур по горизонтальной оси — отдельно в каждой дорожке (по самой верхней фигуре дорожки). */
export function alignMiddle(m: M, ids: string[]): M {
  const set = new Set(ids);
  const lanes = new Map<string, ProcessNode[]>();
  for (const n of m.nodes) if (set.has(n.id)) lanes.set(n.role_id ?? "", [...(lanes.get(n.role_id ?? "") ?? []), n]);
  const cy = new Map<string, number>();
  for (const group of lanes.values()) {
    if (group.length < 2) continue;
    const top = group.reduce((a, b) => (boxOf(b).y < boxOf(a).y ? b : a));
    for (const n of group) cy.set(n.id, boxOf(top).y + boxOf(top).h / 2);
  }
  if (cy.size === 0) return m;
  return { ...m, nodes: m.nodes.map((n) => (cy.has(n.id) ? { ...n, layout: { x: boxOf(n).x, y: snap(cy.get(n.id)! - boxOf(n).h / 2) } } : n)) };
}

/** Равные промежутки между фигурами по горизонтали (крайние остаются на месте). */
export function distributeHorizontally(m: M, ids: string[]): M {
  const set = new Set(ids);
  const picked = m.nodes.filter((n) => set.has(n.id)).sort((a, b) => boxOf(a).x - boxOf(b).x);
  if (picked.length < 3) return m;
  const first = boxOf(picked[0]);
  const last = boxOf(picked[picked.length - 1]);
  const widths = picked.reduce((s, n) => s + boxOf(n).w, 0);
  const gap = (last.x + last.w - first.x - widths) / (picked.length - 1);
  const pos = new Map<string, number>();
  let x = first.x;
  for (const n of picked) {
    pos.set(n.id, snap(x));
    x += boxOf(n).w + gap;
  }
  return { ...m, nodes: m.nodes.map((n) => (pos.has(n.id) ? { ...n, layout: { x: pos.get(n.id)!, y: boxOf(n).y } } : n)) };
}

// --- копирование и вставка ---

/** Скопированный фрагмент: фигуры (вместе с граничными событиями выбранных задач) и стрелки между ними. */
export interface Fragment {
  nodes: ProcessNode[];
  flows: ProcessFlow[];
}

/** Фрагмент для буфера; null — копировать нечего. Источники в интервью, подтверждения и привязки к требованиям не копируются. */
export function copyFragment(m: M, ids: string[]): Fragment | null {
  const picked = new Set(ids);
  for (const n of m.nodes) if (n.attached_to && picked.has(n.attached_to)) picked.add(n.id);
  const nodes = m.nodes.filter((n) => picked.has(n.id)).map((n) => structuredClone(n));
  if (nodes.length === 0) return null;
  return { nodes, flows: m.flows.filter((f) => picked.has(f.from) && picked.has(f.to)).map((f) => structuredClone(f)) };
}

/**
 * Вставляет фрагмент со сдвигом; новые id, стрелки между вставленными фигурами сохраняются. Должность остаётся, только
 * если такая дорожка есть в этой диаграмме, иначе фигура встаёт в верхнюю дорожку без исполнителя.
 */
export function pasteFragment(m: M, frag: Fragment, dx: number, dy: number, reserved: { nodes?: string[]; flows?: string[] } = {}): { model: M; ids: string[] } {
  const map = new Map<string, string>();
  // id, занятые в других диаграммах, редактору не видны — их передаёт вызывающий (иначе слияние переименует фигуры)
  const used = [...m.nodes.map((n) => n.id), ...(reserved.nodes ?? [])];
  for (const n of frag.nodes) {
    const id = nextId("n", used);
    used.push(id);
    map.set(n.id, id);
  }
  const roles = new Set(m.roles.map((r) => r.id));
  const nodes = frag.nodes.map((n): ProcessNode => {
    const b = boxOf(n);
    const attached = n.attached_to && map.has(n.attached_to) ? map.get(n.attached_to)! : null;
    return {
      ...structuredClone(n),
      id: map.get(n.id)!,
      attached_to: attached,
      role_id: n.role_id && roles.has(n.role_id) ? n.role_id : null,
      layout: { x: Math.max(MIN_X, snap(b.x + dx)), y: snap(b.y + dy) },
      source: [],
      confirmed_by: [],
      requirement_ids: [],
      status: "confirmed",
      confidence: 1,
    };
  });
  const flowIds = [...m.flows.map((f) => f.id), ...(reserved.flows ?? [])];
  const flows = frag.flows.map((f): ProcessFlow => {
    const id = nextId("flow", flowIds);
    flowIds.push(id);
    return { ...structuredClone(f), id, from: map.get(f.from)!, to: map.get(f.to)!, source: [], confirmed_by: [] };
  });
  let model: M = { ...m, nodes: [...m.nodes, ...nodes], flows: [...m.flows, ...flows] };
  const ids = nodes.map((n) => n.id);
  for (const n of nodes) if (!n.attached_to) model = dropNodeIntoLane(model, n.id);
  return { model, ids: ids.filter((id) => !nodes.find((n) => n.id === id)!.attached_to) };
}

// Буфер обмена редактора: общий для всех диаграмм, чтобы фрагмент можно было вставить в другую диаграмму.
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
