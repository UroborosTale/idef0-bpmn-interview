import type { ProcessLogicModel, ProcessNode } from "../../types";
import type { Pt } from "../editor-core/hooks";
import { LANE_H, MIN_X, START_Y, sizeOf, type Box } from "@shared/bpmnGeometry";

// Размеры фигур, дорожки и маршрутизация стрелок — общий модуль server/src/shared/bpmnGeometry.ts
// (им же пользуется генератор BPMN), поэтому экспорт совпадает с нарисованным в редакторе.
export { SIZE, LANE_H, START_Y, LANE_X, LABEL_W, MIN_X, sizeOf, waypoints } from "@shared/bpmnGeometry";
export type { Box } from "@shared/bpmnGeometry";
export type { Pt };

export const GRID = 10;
const COL_W = 170;

/** Узлы диаграммы процесса: вложенные функции IDEF0 (idef0_parent) в BPMN не показываются. */
export const visibleNodes = (m: ProcessLogicModel) => m.nodes.filter((n) => !n.idef0_parent);

export const snap = (v: number) => Math.round(v / GRID) * GRID;

export function boxOf(n: ProcessNode): Box {
  const s = sizeOf(n);
  return { x: n.layout?.x ?? MIN_X, y: n.layout?.y ?? START_Y, w: s.w, h: s.h };
}

/** Размер «мира» диаграммы: ширина по самой правой фигуре, высота по числу дорожек. */
export function modelExtents(m: ProcessLogicModel): { w: number; h: number } {
  let maxX = 900;
  for (const n of visibleNodes(m)) {
    const b = boxOf(n);
    maxX = Math.max(maxX, b.x + b.w + 120);
  }
  return { w: maxX, h: laneTop(laneCount(m)) + 20 };
}

/** Дорожек на одну больше числа ролей: последняя — «Без исполнителя». */
export const laneCount = (m: ProcessLogicModel) => m.roles.length + 1;
export const laneTop = (i: number) => START_Y + i * LANE_H;

export function laneIndexOfRole(m: ProcessLogicModel, roleId: string | null | undefined): number {
  const i = roleId ? m.roles.findIndex((r) => r.id === roleId) : -1;
  return i >= 0 ? i : m.roles.length;
}

export function laneIndexAtY(m: ProcessLogicModel, y: number): number {
  const i = Math.floor((y - START_Y) / LANE_H);
  return Math.max(0, Math.min(laneCount(m) - 1, i));
}

export function roleIdOfLane(m: ProcessLogicModel, laneIndex: number): string | null {
  return m.roles[laneIndex]?.id ?? null;
}

/** Удерживает фигуру целиком внутри дорожки и правее подписи дорожки. */
export function clampIntoLane(m: ProcessLogicModel, n: Pick<ProcessNode, "type">, x: number, y: number, laneIndex: number): Pt {
  const s = sizeOf(n);
  const top = laneTop(laneIndex);
  return [Math.max(MIN_X, x), Math.min(Math.max(y, top + 4), top + LANE_H - s.h - 4)];
}

export function labelPoint(pts: Pt[]): Pt {
  const i = Math.floor((pts.length - 1) / 2);
  return [(pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2];
}

/**
 * Авто-раскладка слева направо: столбец = длиннейший путь от начала (петли
 * игнорируются), строка = дорожка роли. Две фигуры в одной ячейке не допускаются.
 */
export function autoLayout(m: ProcessLogicModel): Map<string, { x: number; y: number }> {
  const shown = visibleNodes(m);
  const ids = shown.map((n) => n.id);
  const order = new Map(ids.map((id, i) => [id, i] as const));
  const out = new Map<string, string[]>();
  const hasIn = new Set<string>();
  for (const f of m.flows) {
    if (f.from === f.to || !order.has(f.from) || !order.has(f.to)) continue;
    out.set(f.from, [...(out.get(f.from) ?? []), f.to]);
    hasIn.add(f.to);
  }

  // убираем обратные рёбра (петли), чтобы получить DAG
  const fwd = new Map<string, string[]>();
  const state = new Map<string, 1 | 2>();
  const dfs = (u: string) => {
    state.set(u, 1);
    for (const v of out.get(u) ?? []) {
      if (state.get(v) === 1) continue;
      fwd.set(u, [...(fwd.get(u) ?? []), v]);
      if (!state.has(v)) dfs(v);
    }
    state.set(u, 2);
  };
  for (const id of [...ids.filter((i) => !hasIn.has(i)), ...ids]) if (!state.has(id)) dfs(id);

  const preds = new Map<string, string[]>();
  const indeg = new Map<string, number>(ids.map((id) => [id, 0]));
  for (const [u, vs] of fwd) {
    for (const v of vs) {
      preds.set(v, [...(preds.get(v) ?? []), u]);
      indeg.set(v, (indeg.get(v) ?? 0) + 1);
    }
  }

  const laneOf = new Map(shown.map((n) => [n.id, laneIndexOfRole(m, n.role_id)] as const));
  const rank = new Map<string, number>();
  const taken = new Set<string>();
  const queue = ids.filter((id) => indeg.get(id) === 0);
  while (queue.length > 0) {
    queue.sort((a, b) => order.get(a)! - order.get(b)!);
    const u = queue.shift()!;
    let r = Math.max(-1, ...(preds.get(u) ?? []).map((p) => rank.get(p) ?? -1)) + 1;
    while (taken.has(`${r}:${laneOf.get(u)}`)) r++;
    taken.add(`${r}:${laneOf.get(u)}`);
    rank.set(u, r);
    for (const v of fwd.get(u) ?? []) {
      indeg.set(v, indeg.get(v)! - 1);
      if (indeg.get(v) === 0) queue.push(v);
    }
  }

  const result = new Map<string, { x: number; y: number }>();
  for (const n of shown) {
    const s = sizeOf(n);
    const cx = MIN_X + 60 + (rank.get(n.id) ?? 0) * COL_W;
    result.set(n.id, { x: snap(cx - s.w / 2), y: snap(laneTop(laneOf.get(n.id)!) + (LANE_H - s.h) / 2) });
  }
  return result;
}

/**
 * Позиции фигур из BPMN, сгенерированного сервером (раскладка ELK): id узла → левый верхний угол.
 * Редактор начинает с них, поэтому без ручных правок показывает ту же диаграмму, что и экспорт.
 */
export function positionsFromBpmnXml(xml: string | null | undefined): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  if (!xml) return out;
  for (const m of xml.matchAll(/<bpmndi:BPMNShape id="Node_(.+?)_di"[^>]*>\s*<dc:Bounds x="(-?[\d.]+)" y="(-?[\d.]+)"/g)) {
    out.set(m[1], { x: Number(m[2]), y: Number(m[3]) });
  }
  return out;
}

/**
 * Достраивает layout узлам, у которых его нет: из раскладки сервера (seed), иначе — своей авто-раскладкой.
 * force — расставить все фигуры заново авто-раскладкой.
 */
export function withLayout(m: ProcessLogicModel, force = false, seed?: Map<string, { x: number; y: number }>): ProcessLogicModel {
  if (!force && visibleNodes(m).every((n) => n.layout)) return m;
  const auto = autoLayout(m);
  const pick = (id: string) => (!force && seed?.get(id)) || auto.get(id);
  return { ...m, nodes: m.nodes.map((n) => (auto.has(n.id) && (force || !n.layout) ? { ...n, layout: pick(n.id)! } : n)) };
}

export function wrapText(text: string, maxChars: number, maxLines: number): string[] {
  const lines: string[] = [];
  let cur = "";
  for (let word of text.split(/\s+/).filter(Boolean)) {
    while (word.length > maxChars) {
      if (cur) {
        lines.push(cur);
        cur = "";
      }
      lines.push(word.slice(0, maxChars));
      word = word.slice(maxChars);
    }
    if (!cur) cur = word;
    else if ((cur + " " + word).length <= maxChars) cur += " " + word;
    else {
      lines.push(cur);
      cur = word;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const cut = lines.slice(0, maxLines);
    cut[maxLines - 1] = cut[maxLines - 1].replace(/.{0,1}$/, "…");
    return cut;
  }
  return lines;
}
