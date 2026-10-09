import { describe, expect, it } from "vitest";
import { generateBpmn } from "../src/pipeline/bpmn.js";
import { b002Model } from "../src/reference/b002.js";
import { c025Model } from "../src/reference/c025.js";
import { demoModel } from "../src/reference/demo.js";
import { labelBox, wrapText } from "../src/shared/bpmnLabels.js";
import { routeFlows, routeQuality, type RouteFlow, type RouteNode } from "../src/shared/bpmnRouting.js";
import { bpmnHosts } from "../src/shared/codes.js";
import type { Box, Pt } from "../src/shared/bpmnGeometry.js";

const cuts = (pts: Pt[], r: Box) => pts.slice(1).some((p, i) => Math.max(pts[i][0], p[0]) > r.x + 0.5 && Math.min(pts[i][0], p[0]) < r.x + r.w - 0.5 && Math.max(pts[i][1], p[1]) > r.y + 0.5 && Math.min(pts[i][1], p[1]) < r.y + r.h - 0.5);

describe("подписи событий и шлюзов при прокладке стрелок", () => {
  it("рамка подписи: под фигурой, по центру, по числу строк", () => {
    const b = labelBox({ x: 300, y: 190, w: 50, h: 50 }, "Проверка договора юристом");
    expect(wrapText("Проверка договора юристом", 20, 3)).toEqual(["Проверка договора", "юристом"]);
    expect(b).toMatchObject({ y: 243, h: 26 });
    expect(b!.x + b!.w / 2).toBeCloseTo(325);
    expect(labelBox({ x: 0, y: 0, w: 36, h: 36 }, "   ")).toBeNull();
  });

  // Прямая стрелка идёт на 20 пикселей ниже шлюза — ровно там, где под ним стоит подпись.
  const nodes = (label?: string): RouteNode[] => [
    { id: "a", type: "task", box: { x: 100, y: 220, w: 100, h: 80 } },
    { id: "g", type: "gateway", box: { x: 300, y: 190, w: 50, h: 50 }, label },
    { id: "b", type: "task", box: { x: 500, y: 220, w: 100, h: 80 } },
  ];
  const flows: RouteFlow[] = [{ id: "ab", from: "a", to: "b" }];

  it("без подписи стрелка идёт прямо, с подписью обходит её", () => {
    const text = "Проверка договора юристом";
    const box = labelBox(nodes()[1].box, text)!;
    const straight = routeFlows(nodes(), flows).get("ab")!;
    expect(straight).toHaveLength(2);
    expect(cuts(straight, box)).toBe(true);
    const around = routeFlows(nodes(text), flows).get("ab")!;
    expect(cuts(around, box)).toBe(false);
  });

  it("свои стрелки фигуры подпись не задевают: стрелка из шлюза вниз остаётся вниз", () => {
    const withTarget: RouteNode[] = [...nodes("Проверка договора юристом"), { id: "c", type: "task", box: { x: 275, y: 400, w: 100, h: 80 } }];
    const route = routeFlows(withTarget, [{ id: "gc", from: "g", to: "c" }]).get("gc")!;
    expect(route[0][1]).toBeCloseTo(240); // выходит из нижней вершины
    expect(routeQuality(withTarget, [{ id: "gc", from: "g", to: "c" }], new Map([["gc", route]])).labels).toBe(0);
  });

  it("подписи двух фигур, налезающие друг на друга, считаются в качестве прокладки", () => {
    const near: RouteNode[] = [
      { id: "e1", type: "event", box: { x: 100, y: 100, w: 36, h: 36 }, label: "Просрочка согласования эскалирована" },
      { id: "e2", type: "event", box: { x: 165, y: 100, w: 36, h: 36 }, label: "Согласование прекращено" },
    ];
    expect(routeQuality(near, [], new Map()).labelClash).toBe(1);
    expect(routeQuality([near[0], { ...near[1], box: { x: 400, y: 100, w: 36, h: 36 } }], [], new Map()).labelClash).toBe(0);
  });

  it("на эталонах подписи событий и шлюзов не налезают друг на друга", async () => {
    let clashes = 0;
    for (const m of [b002Model(), c025Model(), demoModel()]) {
      for (const h of bpmnHosts(m)) {
        const { diagram: d } = await generateBpmn(m, h.id);
        const nodes = d.shapes.map((s) => ({ id: s.id, type: s.kind, box: { x: s.x, y: s.y, w: s.w, h: s.h }, label: s.name }));
        clashes += routeQuality(nodes, [], new Map()).labelClash;
      }
    }
    expect(clashes).toBe(0);
  }, 120_000);

  it("на эталонах чужие стрелки почти не идут через подписи", async () => {
    let hits = 0;
    for (const m of [b002Model(), c025Model(), demoModel()]) {
      for (const h of bpmnHosts(m)) {
        const { diagram: d } = await generateBpmn(m, h.id);
        for (const e of d.edges) {
          for (const s of d.shapes) {
            if ((s.kind !== "event" && s.kind !== "gateway") || s.id === e.from || s.id === e.to) continue;
            const box = labelBox({ x: s.x, y: s.y, w: s.w, h: s.h }, s.name);
            if (box && cuts(e.points as Pt[], box)) hits++;
          }
        }
      }
    }
    expect(hits).toBeLessThanOrEqual(2); // без учёта подписей было 6, сейчас 1: вертикаль через подпись конца в «Приёмке оборудования»
  }, 120_000);
});
