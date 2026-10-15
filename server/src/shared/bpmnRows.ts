/**
 * Ряды фигур внутри дорожки (общее для серверной раскладки и кнопки «Расставить» в редакторе): ветки шлюза уходят выше и ниже
 * основной линии, как в Business Studio.
 */

/** Фигура для расстановки по рядам. */
export interface RowNode {
  id: string;
  laneIndex: number;
  type?: string;
  /** Закреплена вручную — в ряды не переставляется. */
  fixed?: unknown;
}

/** Расстояние между рядами фигур внутри одной дорожки (задача 90 + зазор 20). */
export const ROW_PITCH = 110;

/**
 * Ряды внутри дорожки, как у Business Studio: у шлюза с несколькими выходами основная ветка (самая длинная) остаётся на линии
 * дорожки, остальные уходят выше и ниже неё: вторая уходит вверх, первая («Нет») вниз. Ряд получает первая фигура ветки в той же дорожке и вся цепочка
 * за ней, пока не встретится слияние, шлюз или другая дорожка. Закреплённые в редакторе фигуры не двигаются.
 */
export function branchRows(nodes: RowNode[], edges: { from: string; to: string }[], boxes: Map<string, { x: number }>, firstDown: boolean): Map<string, number> {
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const out = new Map<string, string[]>();
  const into = new Map<string, number>();
  for (const e of edges) {
    if (e.from === e.to || !byId.has(e.from) || !byId.has(e.to)) continue;
    out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
    into.set(e.to, (into.get(e.to) ?? 0) + 1);
  }
  // сколько фигур достижимо из фигуры вперёд (по x), чтобы найти основную ветку
  const reach = (start: string): number => {
    const seen = new Set<string>([start]);
    const stack = [start];
    while (stack.length) {
      const u = stack.pop()!;
      for (const v of out.get(u) ?? []) if (!seen.has(v) && boxes.get(v)!.x > boxes.get(u)!.x) (seen.add(v), stack.push(v));
    }
    return seen.size;
  };
  const rows = new Map<string, number>();
  const gateways = nodes.filter((n) => n.type === "gateway" && !n.fixed && (out.get(n.id)?.length ?? 0) >= 2).sort((a, b) => boxes.get(a.id)!.x - boxes.get(b.id)!.x);
  for (const g of gateways) {
    const targets = (out.get(g.id) ?? []).filter((t) => byId.get(t)!.laneIndex === g.laneIndex && !byId.get(t)!.fixed && !rows.has(t) && (into.get(t) ?? 0) === 1);
    if (targets.length < 2) continue;
    // основная — самая длинная ветка (при равенстве — ближняя)
    const main = [...targets].sort((a, b) => reach(b) - reach(a) || boxes.get(a)!.x - boxes.get(b)!.x)[0];
    let k = 0;
    for (const t of targets) {
      if (t === main) continue;
      k++;
      const row = (k % 2 === 1 === firstDown ? 1 : -1) * Math.ceil(k / 2); // первая — ниже основной (обычно «Нет»), вторая — выше
      let cur = t;
      const guard = new Set<string>();
      while (!guard.has(cur)) {
        guard.add(cur);
        rows.set(cur, row);
        const nexts = out.get(cur) ?? [];
        if (nexts.length !== 1) break;
        const nx = byId.get(nexts[0])!;
        if (nx.type === "gateway" || nx.laneIndex !== g.laneIndex || nx.fixed || (into.get(nx.id) ?? 0) !== 1 || rows.has(nx.id)) break;
        cur = nx.id;
      }
    }
  }
  // Шлюз, в который входят только из другой дорожки (сверху или снизу), встаёт у границы своей дорожки — в «верхнем» или «нижнем» ряду,
  // а следующий за ним шаг — в основном ряду того же столбца (стрелка вертикальна), как в Business Studio. Стрелки сверху: ряд выше основного.
  const incoming = new Map<string, string[]>();
  for (const e of edges) if (e.from !== e.to && byId.has(e.from) && byId.has(e.to)) incoming.set(e.to, [...(incoming.get(e.to) ?? []), e.from]);
  for (const g of nodes) {
    if (g.type !== "gateway" || g.fixed || rows.has(g.id)) continue;
    const ins = incoming.get(g.id) ?? [];
    const outs = out.get(g.id) ?? [];
    if (ins.length === 0 || outs.length !== 1) continue;
    if (!ins.every((f) => byId.get(f)!.laneIndex !== g.laneIndex)) continue;
    const target = byId.get(outs[0])!;
    if (target.laneIndex !== g.laneIndex || target.type === "gateway" || target.fixed || rows.has(target.id)) continue;
    const fromAbove = ins.every((f) => byId.get(f)!.laneIndex < g.laneIndex);
    // входящий снизу шлюз остаётся в основном ряду: стрелка поднимается к нему вертикально
    if (fromAbove) rows.set(g.id, -1);
  }
  return rows;
}

/** Пары стрелок, идущих по одной прямой на общем участке: две линии сливаются в одну, и не видно, куда какая ведёт. */
export function collinearOverlaps(routes: Map<string, [number, number][]>): number {
  const segs: { id: string; axis: "x" | "y"; at: number; a: number; b: number }[] = [];
  for (const [id, pts] of routes) {
    for (let i = 0; i + 1 < pts.length; i++) {
      const [p, q] = [pts[i], pts[i + 1]];
      if (Math.abs(p[1] - q[1]) < 1e-6) segs.push({ id, axis: "y", at: p[1], a: Math.min(p[0], q[0]), b: Math.max(p[0], q[0]) });
      else if (Math.abs(p[0] - q[0]) < 1e-6) segs.push({ id, axis: "x", at: p[0], a: Math.min(p[1], q[1]), b: Math.max(p[1], q[1]) });
    }
  }
  let n = 0;
  for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) if (segs[i].id !== segs[j].id && segs[i].axis === segs[j].axis && Math.abs(segs[i].at - segs[j].at) < 3 && Math.min(segs[i].b, segs[j].b) - Math.max(segs[i].a, segs[j].a) > 2) n++;
  return n;
}

