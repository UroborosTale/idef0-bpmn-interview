import { describe, expect, it } from "vitest";
import { generateBpmn } from "../src/pipeline/bpmn.js";
import { MIN_EVALUATIONS, evaluationsFor, layoutLayered } from "../src/pipeline/layout.js";
import { b002Model } from "../src/reference/b002.js";
import { c025Model } from "../src/reference/c025.js";
import { demoModel } from "../src/reference/demo.js";
import { routeQuality, type RouteNode } from "../src/shared/bpmnRouting.js";
import { bpmnHosts } from "../src/shared/codes.js";
import type { Pt } from "../src/shared/bpmnGeometry.js";

/** Пересечения стрелок на диаграмме операции — по готовой прокладке (то же, что видит пользователь). */
async function crossingsOf(m: ReturnType<typeof b002Model>, host: string): Promise<number> {
  const { diagram } = await generateBpmn(m, host);
  const routes = new Map(diagram.edges.map((e) => [e.id, e.points as Pt[]] as const));
  const nodes: RouteNode[] = diagram.shapes.map((s) => ({ id: s.id, type: s.kind, box: { x: s.x, y: s.y, w: s.w, h: s.h } }));
  return routeQuality(nodes, diagram.edges.map((e) => ({ id: e.id, from: e.from, to: e.to })), routes).crossings;
}

// Пересечения до подбора раскладки (замер до введения подбора): подбор может только уменьшать их.
const BEFORE: Record<string, number> = {
  "b002:o21": 2, "b002:o22": 2, "b002:o33": 7,
  "c025:o11": 1, "c025:o12": 2, "c025:o13": 8, "c025:o21": 1, "c025:o22": 6,
  "demo:o11": 4, "demo:o12": 5, "demo:o22": 4, "demo:o32": 1,
};

describe("подбор раскладки: меньше пересечений стрелок при тех же дорожках", () => {
  it("на эталонах и демо ни одна диаграмма не хуже прежней, а всего пересечений заметно меньше", async () => {
    let before = 0;
    let after = 0;
    for (const [name, m] of [["b002", b002Model()], ["c025", c025Model()], ["demo", demoModel()]] as const) {
      for (const h of bpmnHosts(m)) {
        const c = await crossingsOf(m, h.id);
        const was = BEFORE[`${name}:${h.id}`] ?? 0;
        expect(c, `${name} ${h.id}`).toBeLessThanOrEqual(was);
        before += was;
        after += c;
      }
    }
    expect(before).toBe(43);
    expect(after).toBeLessThanOrEqual(31); // замер: 29
  }, 120_000);

  it("LAYOUT_SEARCH=0 возвращает прежнюю раскладку: ровно 43 пересечения на тех же диаграммах", async () => {
    process.env.LAYOUT_SEARCH = "0";
    try {
      let total = 0;
      for (const [name, m] of [["b002", b002Model()], ["c025", c025Model()], ["demo", demoModel()]] as const) for (const h of bpmnHosts(m)) total += await crossingsOf(m, h.id);
      expect(total).toBe(43);
    } finally {
      delete process.env.LAYOUT_SEARCH;
    }
  }, 120_000);

  it("число проверяемых вариантов зависит только от размера диаграммы: на малых — полный перебор, на больших меньше, на огромных подбора нет", () => {
    expect(evaluationsFor(10)).toBe(200);
    expect(evaluationsFor(26)).toBe(200);
    const sizes = [26, 40, 60, 80, 100, 120, 150, 300].map(evaluationsFor);
    expect([...sizes].sort((a, b) => b - a)).toEqual(sizes); // с ростом диаграммы не растёт
    expect(evaluationsFor(100)).toBeGreaterThanOrEqual(MIN_EVALUATIONS); // типичная крупная диаграмма ещё подбирается
    expect(evaluationsFor(150)).toBeLessThan(MIN_EVALUATIONS); // от ~120 стрелок — как есть
    expect(evaluationsFor(150)).toBe(evaluationsFor(150)); // не зависит от запуска
  });

  it("результат не зависит от запуска: одинаковые координаты и маршруты", async () => {
    const m = c025Model();
    const a = await generateBpmn(m, "o22");
    const b = await generateBpmn(m, "o22");
    expect(b.diagram.shapes.map((s) => [s.id, s.x, s.y])).toEqual(a.diagram.shapes.map((s) => [s.id, s.x, s.y]));
    expect(b.diagram.edges.map((e) => e.points)).toEqual(a.diagram.edges.map((e) => e.points));
  });

  it("позиции, заданные в редакторе, подбор не двигает", async () => {
    const m = c025Model();
    const free = await generateBpmn(m, "o22");
    const pinnedId = free.diagram.shapes.find((s) => s.kind === "task")!.id.replace(/^Node_/, "");
    const pinned = { ...m, nodes: m.nodes.map((n) => (n.id === pinnedId ? { ...n, layout: { x: 777, y: 123 } } : n)) };
    const r = await generateBpmn(pinned, "o22");
    const s = r.diagram.shapes.find((x) => x.id === `Node_${pinnedId}`)!;
    expect([s.x, s.y]).toEqual([777, 123]);
  });

  it("layoutLayered: ветки шлюза в одной дорожке — порядок выбирается так, чтобы стрелки не пересекались; ничего не теряется", async () => {
    // g → a → m, g → b → m, g → c → m; одна дорожка; возврат m → g не нужен. Любой порядок допустим, но пересечений быть не должно.
    const nodes = ["g", "a", "b", "c", "m", "end"].map((id) => ({ id, width: id === "g" || id === "m" ? 50 : 100, height: id === "g" || id === "m" ? 50 : 80, laneIndex: 0, type: id === "g" || id === "m" ? "gateway" : id === "end" ? "event" : "task" }));
    const edges = [["g", "a"], ["g", "b"], ["g", "c"], ["a", "m"], ["b", "m"], ["c", "m"], ["m", "end"]].map(([from, to], i) => ({ id: `e${i}`, from, to }));
    const r = await layoutLayered(nodes, edges, 1);
    expect([...r.boxes.keys()].sort()).toEqual(["a", "b", "c", "end", "g", "m"]);
    const boxes = [...r.boxes.values()];
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const [p, q] = [boxes[i], boxes[j]];
      expect(p.x < q.x + q.width && p.x + p.width > q.x && p.y < q.y + q.height && p.y + p.height > q.y, `фигуры ${i} и ${j} налезают`).toBe(false);
    }
    const routeNodes: RouteNode[] = nodes.map((n) => ({ id: n.id, type: n.type, box: { x: r.boxes.get(n.id)!.x, y: r.boxes.get(n.id)!.y, w: n.width, h: n.height } }));
    const { routeFlows } = await import("../src/shared/bpmnRouting.js");
    const flows = edges.map((e) => ({ id: e.id, from: e.from, to: e.to }));
    expect(routeQuality(routeNodes, flows, routeFlows(routeNodes, flows)).cuts).toBe(0);
  });
});