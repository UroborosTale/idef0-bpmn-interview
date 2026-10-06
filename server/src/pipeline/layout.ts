import * as ElkNS from "elkjs";

// elkjs публикует CJS-модуль с default-совместимой формой; в NodeNext-режиме
// TS не всегда разрешает интероп автоматически, поэтому берём конструктор
// явно (как это делает сам bpmn-generator-подобный тулинг).
import { LANE_H, MIN_X, START_Y, waypoints } from "../shared/bpmnGeometry.js";

const ElkCtor: new () => import("elkjs").ELK = (ElkNS as any).default ?? (ElkNS as any);

export interface LayoutNodeIn {
  id: string;
  width: number;
  height: number;
  laneIndex: number;
}
export interface LayoutEdgeIn {
  id: string;
  from: string;
  to: string;
}
export interface LayoutBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutResult {
  boxes: Map<string, LayoutBox>;
  laneBounds: { laneIndex: number; y: number; height: number }[];
  totalWidth: number;
  totalHeight: number;
}

// Дорожки начинаются с LANE_X, подпись дорожки занимает LABEL_W — фигуры начинаются правее (MIN_X).
const LANE_HEIGHT = LANE_H;
const START_X = MIN_X;

const elk = new ElkCtor();

/**
 * Раскладка слева-направо на основе ElkJS (Sugiyama layered algorithm,
 * ФТ-6.2): ELK определяет ранжирование узлов по столбцам (топологическая
 * упорядоченность с минимизацией пересечений), а вертикальная позиция
 * внутри столбца переопределяется по дорожке-роли (swimlane), т.к.
 * дорожки — это семантика BPMN, которую сам ELK не знает.
 */
export async function layoutLayered(nodes: LayoutNodeIn[], edges: LayoutEdgeIn[], laneCount: number): Promise<LayoutResult> {
  const elkGraph = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.layered.spacing.nodeNodeBetweenLayers": "90",
      "elk.spacing.nodeNode": "36",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
    },
    children: nodes.map((n) => ({ id: n.id, width: n.width, height: n.height })),
    edges: edges
      .filter((e) => nodes.some((n) => n.id === e.from) && nodes.some((n) => n.id === e.to))
      .map((e) => ({ id: e.id, sources: [e.from], targets: [e.to] })),
  };

  const result = await elk.layout(elkGraph as any);
  const elkX = new Map<string, number>();
  for (const child of result.children ?? []) {
    elkX.set(child.id!, child.x ?? 0);
  }

  const nodeById = new Map(nodes.map((n) => [n.id, n] as const));
  const boxes = new Map<string, LayoutBox>();
  const occupied = new Map<string, number>(); // key `${roundedX}:${lane}` -> stagger count

  // Стабильный порядок узлов для детерминированного стаггера при коллизиях
  const order = [...nodes].sort((a, b) => (elkX.get(a.id) ?? 0) - (elkX.get(b.id) ?? 0));

  for (const n of order) {
    const rawX = elkX.get(n.id) ?? 0;
    const key = `${Math.round(rawX / 4)}:${n.laneIndex}`;
    const stagger = occupied.get(key) ?? 0;
    occupied.set(key, stagger + 1);

    const x = START_X + rawX + stagger * 40;
    const laneY = START_Y + n.laneIndex * LANE_HEIGHT;
    const y = laneY + (LANE_HEIGHT - n.height) / 2 + stagger * 26;
    boxes.set(n.id, { x, y, width: n.width, height: n.height });
  }

  // Фигуры одной дорожки не должны налезать друг на друга (две ветки шлюза попадают в один слой ELK):
  // идём слева направо и сдвигаем перекрывающуюся фигуру правее предыдущей.
  const byLane = new Map<number, string[]>();
  for (const n of nodes) byLane.set(n.laneIndex, [...(byLane.get(n.laneIndex) ?? []), n.id]);
  for (const ids of byLane.values()) {
    ids.sort((a, b) => boxes.get(a)!.x - boxes.get(b)!.x);
    let right = -Infinity;
    for (const id of ids) {
      const b = boxes.get(id)!;
      if (b.x < right + 30) b.x = right + 30;
      right = b.x + b.width;
    }
  }

  let maxRight = 0;
  for (const b of boxes.values()) maxRight = Math.max(maxRight, b.x + b.width);
  const totalWidth = maxRight + 80;
  const totalHeight = START_Y + laneCount * LANE_HEIGHT + 40;

  const laneBounds = Array.from({ length: laneCount }, (_, i) => ({
    laneIndex: i,
    y: START_Y + i * LANE_HEIGHT,
    height: LANE_HEIGHT,
  }));

  return { boxes, laneBounds, totalWidth, totalHeight };
}

/**
 * Ортогональные точки перегиба стрелки между двумя прямоугольниками — общая функция
 * shared/bpmnGeometry.ts (её же использует редактор в браузере).
 */
export function orthogonalWaypoints(from: LayoutBox, to: LayoutBox, obstacles: LayoutBox[] = []): [number, number][] {
  const box = (b: LayoutBox) => ({ x: b.x, y: b.y, w: b.width, h: b.height });
  return waypoints(box(from), box(to), obstacles.map(box));
}