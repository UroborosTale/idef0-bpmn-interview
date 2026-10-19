import { describe, expect, it } from "vitest";
import { generateIdef0 } from "../src/pipeline/idef0.js";
import { b002Model } from "../src/reference/b002.js";
import { noteBox } from "../src/shared/idef0Layout.js";

/**
 * В12 (план BS6): примечание к функции. Поле `note` есть в модели и редактируется в карточке элемента;
 * на диаграмме IDEF0 оно рисуется жёлтым блоком справа от функции — одинаково в редакторе, SVG и Visio.
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
