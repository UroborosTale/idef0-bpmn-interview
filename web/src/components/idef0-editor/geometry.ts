import type { ProcessLogicModel, ProcessNode } from "../../types";
import { functionsOf as sharedFunctionsOf, layoutIdef0, defaultPos, type Arrow as SharedArrow, type FunctionBlock as SharedBlock, type Idef0Layout as SharedLayout, labelSpec as sharedLabelSpec } from "@shared/idef0Layout";

// Раскладка диаграмм — общий модуль server/src/shared/idef0Layout.ts: им же пользуется сервер для SVG и VSDX,
// поэтому экспортированная диаграмма совпадает с нарисованной.
export { BLOCK_W, BLOCK_H, STEP_X, STEP_Y, MARGIN, defaultPos, idef0Codes, idef0Extents } from "@shared/idef0Layout";
export type { Box, LabelSide, ArrowKind } from "@shared/idef0Layout";

export type Arrow = SharedArrow;
export type FunctionBlock = SharedBlock<ProcessNode>;
export type Idef0Layout = SharedLayout<ProcessNode>;

export const MIN_POS = 100; // левее/выше блок не ставим: слева и сверху нужно место для стрелок и подписей
export const GRID = 10;
export const snap = (v: number) => Math.round(v / GRID) * GRID;

const isFn = (n: ProcessNode) => (n.type === "task" || n.type === "subprocess") && !n.bpmn_scope;

/** Функции одной диаграммы: parentId = null — уровень A0, иначе — вложенные функции узла. */
export const functionsOf = (m: ProcessLogicModel, parentId: string | null = null): ProcessNode[] => sharedFunctionsOf(m, parentId);

/** Блоки и ICOM-стрелки диаграммы (parentId = null — A0). */
export const buildIdef0 = (m: ProcessLogicModel, parentId: string | null = null): Idef0Layout => layoutIdef0(m, parentId);
/** Цепочка предков функции от верхнего уровня к ближайшему родителю (для хлебных крошек). */
export function ancestorsOf(m: ProcessLogicModel, id: string): string[] {
  const chain: string[] = [];
  let cur = m.nodes.find((n) => n.id === id)?.idef0_parent;
  while (cur && !chain.includes(cur)) {
    chain.unshift(cur);
    cur = m.nodes.find((n) => n.id === cur)?.idef0_parent;
  }
  return chain;
}

/** Все потомки функции (вложенные на любую глубину). */
export function descendantsOf(m: ProcessLogicModel, id: string): string[] {
  const out: string[] = [];
  const walk = (pid: string) => {
    for (const n of m.nodes) {
      if (n.idef0_parent === pid && !out.includes(n.id)) {
        out.push(n.id);
        walk(n.id);
      }
    }
  };
  walk(id);
  return out;
}

/**
 * Достраивает позиции блокам без неё — на всех уровнях иерархии. force + parentId сбрасывает
 * расстановку только на указанной диаграмме (по диагонали).
 */
export function withIdef0Layout(m: ProcessLogicModel, force = false, parentId: string | null = null): ProcessLogicModel {
  const groups = new Set<string | null>([null, ...m.nodes.filter(isFn).map((n) => n.idef0_parent ?? null)]);
  const pos = new Map<string, { x: number; y: number }>();
  for (const g of groups) {
    functionsOf(m, g).forEach((n, i) => {
      if ((force && g === parentId) || !n.idef0_layout) pos.set(n.id, defaultPos(i));
    });
  }
  if (pos.size === 0) return m;
  return { ...m, nodes: m.nodes.map((n) => (pos.has(n.id) ? { ...n, idef0_layout: pos.get(n.id)! } : n)) };
}

/** Подпись стрелки (общая функция; у стрелки редактора подпись есть всегда). */
export function labelSpec(a: Pick<Arrow, "points" | "side" | "label" | "labelHidden" | "bus" | "labelRow" | "labelOffset">): { x: number; y: number; anchor: "start" | "middle" | "end"; text: string } {
  return sharedLabelSpec(a) ?? { x: a.points[0][0], y: a.points[0][1], anchor: "start", text: "" };
}