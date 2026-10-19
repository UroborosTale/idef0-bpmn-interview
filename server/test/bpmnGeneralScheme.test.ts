import { describe, expect, it } from "vitest";
import { generateBpmn } from "../src/pipeline/bpmn.js";
import { b002Model } from "../src/reference/b002.js";

/**
 * Общая схема процесса эталона: подпроцессы связаны между собой и стоят в дорожках своих исполнителей.
 * Было: дорожки всех ролей пустые, все подпроцессы в «Без исполнителя», связей 0 — схема распадалась
 * на изолированные блоки (замечание с осмотра веб-версии).
 */
describe("общая схема процесса: дорожки и связи", () => {
  const laneOf = (lanes: { roleId: string | null; y: number; h: number }[], s: { y: number; h: number }) =>
    lanes.find((l) => s.y >= l.y && s.y + s.h <= l.y + l.h + 1);

  it("B002: каждый подпроцесс — в дорожке исполнителя, связей между подпроцессами — по числу стыков", async () => {
    const m = b002Model();
    const fns = m.nodes.filter((n) => !n.bpmn_scope && !n.idef0_parent);
    expect(fns.length).toBeGreaterThan(1);

    const r = await generateBpmn(m, null);
    expect(r.diagram.lanes.length).toBeGreaterThan(1);

    for (const f of fns) {
      const shape = r.diagram.shapes.find((s) => s.nodeId === f.id);
      expect(shape, f.name).toBeTruthy();
      // ни один подпроцесс не висит в «Без исполнителя»
      expect(laneOf(r.diagram.lanes, shape!)?.roleId, f.name).not.toBeNull();
    }
    // пустых дорожек не остаётся: роль показывается только если в её дорожке кто-то есть
    for (const l of r.diagram.lanes) {
      expect(
        r.diagram.shapes.some((s) => s.y >= l.y && s.y + s.h <= l.y + l.h + 1),
        l.name
      ).toBe(true);
    }
    // подпроцессы выстроены в цепочку: стыков на один меньше, чем подпроцессов
    const ids = new Set(fns.map((f) => `Node_${f.id}`));
    const between = r.diagram.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
    expect(between).toHaveLength(fns.length - 1);
    expect(r.xml).toContain("DerivedFlow_1");
  });
});
