import { describe, expect, it } from "vitest";
import { generateBpmn } from "../src/pipeline/bpmn.js";
import { c025Model } from "../src/reference/c025.js";
import { routeQuality, type RouteNode } from "../src/shared/bpmnRouting.js";
import type { Pt } from "../src/shared/bpmnGeometry.js";

/**
 * C025.02.01 (план BS6, В13): длинная цепочка шагов одной дорожки упаковывается в ряды, как страницы в Business Studio.
 * Без упаковки диаграмма уходила на 3 метра вправо; возврат с конца ряда в начало следующего идёт в промежутке между рядами.
 */
describe("упаковка длинной цепочки BPMN", () => {
  const host = "o21"; // C025.02.01 — 16 шагов подряд

  const build = async (pack: boolean) => {
    const prev = process.env.BPMN_PACK;
    process.env.BPMN_PACK = pack ? "1" : "0";
    try {
      return (await generateBpmn(c025Model(), host)).diagram;
    } finally {
      if (prev === undefined) delete process.env.BPMN_PACK;
      else process.env.BPMN_PACK = prev;
    }
  };

  it("C025.02.01: диаграмма стала заметно уже, шаги идут рядами внутри своей дорожки", async () => {
    const plain = await build(false);
    const packed = await build(true);
    expect(plain.width).toBeGreaterThan(3000);
    expect(packed.width).toBeLessThanOrEqual(2000);
    expect(packed.width).toBeLessThan(plain.width * 0.7);

    // шаги завернулись: какая-то стрелка идёт назад — с конца ряда в начало следующего
    const back = packed.edges.some((e) => e.points.some((p, i) => i > 0 && p[0] < e.points[i - 1][0] - 300));
    expect(back).toBe(true);
    // и каждая фигура остаётся в своей дорожке
    for (const s of packed.shapes) {
      const inside = packed.lanes.some((l) => s.y >= l.y && s.y + s.h <= l.y + l.h + 1);
      expect(inside, `${s.id} вне дорожек`).toBe(true);
    }
    for (const s of packed.shapes) expect(s.y + s.h <= packed.height, `${s.id} ниже диаграммы`).toBe(true);
  });

  it("возврат между рядами не проходит сквозь фигуры", async () => {
    const packed = await build(true);
    const routes = new Map(packed.edges.map((e) => [e.id, e.points as Pt[]] as const));
    const nodes: RouteNode[] = packed.shapes.map((s) => ({ id: s.id, type: s.kind, box: { x: s.x, y: s.y, w: s.w, h: s.h } }));
    const q = routeQuality(nodes, packed.edges.map((e) => ({ id: e.id, from: e.from, to: e.to })), routes);
    expect(q.cuts).toBe(0);
  });

  it("раскладка воспроизводима: тот же результат при повторном построении", async () => {
    const a = await build(true);
    const b = await build(true);
    expect(b.shapes.map((s) => `${s.id}:${Math.round(s.x)},${Math.round(s.y)}`)).toEqual(a.shapes.map((s) => `${s.id}:${Math.round(s.x)},${Math.round(s.y)}`));
  });
});