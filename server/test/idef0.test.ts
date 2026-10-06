import { describe, expect, it } from "vitest";
import { buildIdef0Diagrams, generateIdef0, idef0Codes, idef0Functions } from "../src/pipeline/idef0.js";
import { purchaseModel } from "./fixtures.js";

describe("IDEF0", () => {
  it("иерархические коды функций", () => {
    const codes = idef0Codes(purchaseModel());
    expect(Object.fromEntries(codes)).toEqual({ a: "A1", b: "A2", b1: "A21", b2: "A22", c: "A3" });
  });

  it("A0 — только функции верхнего уровня, вложенные — на своей диаграмме", () => {
    const m = purchaseModel();
    expect(idef0Functions(m, null).map((n) => n.id)).toEqual(["a", "b", "c"]);
    const d = buildIdef0Diagrams(m);
    expect(d.root.blocks.map((b) => b.code)).toEqual(["A1", "A2", "A3"]);
    expect(d.root.blocks.find((b) => b.nodeId === "b")?.hasChildren).toBe(true);
    expect(d.children.map((c) => [c.code, c.blocks.length])).toEqual([["A2", 2]]);
  });

  it("выход одной функции — управление другой: стрелка от источника заходит сверху", () => {
    const d = buildIdef0Diagrams(purchaseModel());
    const link = d.root.arrows.find((a) => a.ref?.kind === "controlLink");
    expect(link).toBeDefined();
    expect(link!.startNode).toBe("b");
    expect(link!.endNode).toBe("c");
    const target = d.root.blocks.find((b) => b.nodeId === "c")!;
    const last = link!.points[link!.points.length - 1];
    expect(last[1]).toBe(target.y); // конец — на верхней стороне блока
  });

  it("у каждой стрелки функции есть ссылка на элемент модели и блок", () => {
    const d = buildIdef0Diagrams(purchaseModel());
    for (const a of d.root.arrows) {
      expect(a.ref).toBeDefined();
      expect(a.startNode ?? a.endNode).toBeDefined();
    }
  });

  it("SVG строится для всех уровней", () => {
    const r = generateIdef0(purchaseModel());
    expect(r.decompositionSvg).toContain("<svg");
    expect(r.children.map((c) => c.code)).toEqual(["A2"]);
    expect(r.nodeTreeSvg).toContain("A21");
  });
});
