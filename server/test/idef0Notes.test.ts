import { describe, expect, it } from "vitest";
import { buildIdef0Diagrams, generateIdef0 } from "../src/pipeline/idef0.js";
import { b002Model } from "../src/reference/b002.js";
import { noteBox } from "../src/shared/idef0Layout.js";

/**
 * В12 (план BS6): примечание к функции и свободные текстовые блоки диаграммы.
 * Примечание к функции — поле note узла (жёлтый блок у блока); свободные блоки — idef0_notes по диаграмме.
 */
describe("примечание к функции IDEF0", () => {
  it("блок стоит справа от функции, текст переносится по словам", () => {
    const nb = noteBox({ x: 100, y: 50, w: 200, h: 80 }, "Сверить с юристом до подписания договора")!;
    expect(nb.x).toBe(312); // 100 + 200 + 12
    expect(nb.y).toBe(50);
    expect(nb.lines.length).toBeGreaterThan(1);
    expect(nb.h).toBeGreaterThanOrEqual(34);
  });

  it("примечание попадает в SVG диаграммы", () => {
    const m = b002Model();
    const fn = m.nodes.find((n) => !n.bpmn_scope && !n.idef0_parent)!;
    fn.note = "Сверить с регламентом";
    const svg = generateIdef0(m).decompositionSvg;
    expect(svg).toContain("Сверить");
    expect(svg).toContain('fill="#fef9c3"');
  });
});

describe("свободные текстовые блоки IDEF0", () => {
  const m = () => {
    const model = b002Model();
    model.idef0_notes = { "": [{ id: "note1", text: "Допущение: сроки уточняются", x: 900, y: 700, w: 200, h: 60 }] };
    return model;
  };

  it("блок диаграммы попадает в её данные и в SVG, полотно расширяется под него", () => {
    const model = m();
    const { root } = buildIdef0Diagrams(model);
    expect(root.notes).toHaveLength(1);
    expect(root.notes![0].text).toContain("Допущение");
    expect(root.width).toBeGreaterThanOrEqual(900 + 200 + 20);
    const svg = generateIdef0(model).decompositionSvg;
    expect(svg).toContain("Допущение");
  });

  it("блоки привязаны к своей диаграмме: в декомпозиции функции их нет", () => {
    const model = m();
    const { children } = buildIdef0Diagrams(model);
    for (const c of children) expect(c.notes ?? []).toEqual([]);
  });
});
