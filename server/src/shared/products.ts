/**
 * Продукты процесса и схема перехода статусов (регламент процесса, рис. «Схема перехода статусов»):
 * продукты выстраиваются по стадиям — от входов процесса к конечным продуктам; продукты, которые
 * выпускает одна функция, образуют группу.
 */

import { functionsOf, type NodeLike } from "./idef0Layout.js";

export interface StageItem {
  id: string;
  name: string;
  /** Номер стадии: 0 — входы процесса, дальше — продукты, полученные из продуктов предыдущих стадий. */
  layer: number;
  /** Группа: продукты одной функции на одной стадии; у входов процесса — общая группа стадии. */
  group: string;
}

export interface StageScheme {
  items: StageItem[];
  /** Переход «продукт → продукт»: из входа (или управления) функции в её выход. */
  edges: { from: string; to: string }[];
  layers: number;
}

export interface StageModel {
  nodes: NodeLike[];
  data: { id: string; name: string }[];
}

/** Схема переходов по функциям верхнего уровня. Циклы (обратные связи) не создают стадий. */
export function productStages(m: StageModel): StageScheme {
  const dataById = new Map(m.data.map((d) => [d.id, d] as const));
  const fns = functionsOf(m, null);
  const order: string[] = [];
  const see = (id: string) => {
    if (dataById.has(id) && !order.includes(id)) order.push(id);
  };
  const producer = new Map<string, string>();
  const edges: { from: string; to: string }[] = [];
  for (const f of fns) {
    const ins = [...f.inputs, ...(f.control_data_ids ?? [])].filter((id) => dataById.has(id));
    const outs = f.outputs.filter((id) => dataById.has(id));
    ins.forEach(see);
    outs.forEach(see);
    for (const o of outs) if (!producer.has(o)) producer.set(o, f.id);
    for (const i of ins) for (const o of outs) if (i !== o && !edges.some((e) => e.from === i && e.to === o)) edges.push({ from: i, to: o });
  }

  // стадия — длиннейший путь от входов процесса
  const incoming = new Map<string, string[]>();
  for (const e of edges) incoming.set(e.to, [...(incoming.get(e.to) ?? []), e.from]);
  const layerOf = new Map<string, number>();
  const visiting = new Set<string>();
  const layer = (id: string): number => {
    const known = layerOf.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const l = Math.max(-1, ...(incoming.get(id) ?? []).map(layer)) + 1;
    visiting.delete(id);
    layerOf.set(id, l);
    return l;
  };

  const items: StageItem[] = order.map((id) => {
    const l = layer(id);
    const p = producer.get(id);
    return { id, name: dataById.get(id)!.name, layer: l, group: p && l > 0 ? `${p}@${l}` : `in@${l}` };
  });
  return { items, edges, layers: items.reduce((n, i) => Math.max(n, i.layer + 1), 0) };
}
