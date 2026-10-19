import { describe, expect, it } from "vitest";
import { generateIdef0 } from "../src/pipeline/idef0.js";
import { purchaseModel } from "./fixtures.js";

/**
 * В редакторе подпись стрелки рисуется с белой обводкой (paint-order: stroke) — иначе линия стрелки перечёркивает
 * текст. В SVG-выгрузке (она же страница печати и PDF) обводки не было: замечание с осмотра веб-версии.
 */
describe("SVG IDEF0: белая обводка подписи стрелки", () => {
  it("подписи стрелок идут с paint-order: stroke на всех диаграммах", () => {
    const r = generateIdef0(purchaseModel());
    const pages = [r.contextSvg, r.decompositionSvg, ...r.children.map((c) => (c as { svg?: string }).svg ?? "")].filter(Boolean);
    expect(pages.length).toBeGreaterThan(1);
    for (const svg of pages) {
      const labels = svg.match(/<text[^>]*paint-order="stroke"[^>]*>/g) ?? [];
      expect(labels.length).toBeGreaterThan(0);
      for (const tag of labels) {
        expect(tag).toContain('stroke="#ffffff"');
        expect(tag).toContain('stroke-width="3"');
      }
    }
  });
});
