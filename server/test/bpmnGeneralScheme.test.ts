import { describe, expect, it } from "vitest";
import { generateBpmn } from "../src/pipeline/bpmn.js";
import { b002Model } from "../src/reference/b002.js";
import { ProcessLogicModel } from "../src/types/model.js";

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

  it("D7: роль на шагах операции поднимается к подпроцессу; синтетические события — в дорожке шагов", async () => {
    const m = ProcessLogicModel.parse({
      process: { id: "d7", name: "Приём сотрудника" },
      roles: [{ id: "r1", name: "Руководитель" }, { id: "r2", name: "Охранник" }],
      nodes: [
        { id: "sp", type: "task", name: "Оформление" },
        { id: "op1", type: "task", name: "Проверка", idef0_parent: "sp" },
        { id: "op2", type: "task", name: "Выдача", idef0_parent: "sp" },
        { id: "t1", type: "task", name: "Проверить документы", bpmn_scope: "op1", role_id: "r1" },
        { id: "t2", type: "task", name: "Согласовать заявку", bpmn_scope: "op1", role_id: "r1" },
        { id: "t3", type: "task", name: "Выдать пропуск", bpmn_scope: "op2", role_id: "r2" },
        { id: "t4", type: "task", name: "Закрыть заявку", bpmn_scope: "op2", role_id: "r2" },
      ],
      flows: [
        { id: "f1", from: "t1", to: "t2" },
        { id: "f2", from: "t3", to: "t4" },
      ],
    });
    const general = await generateBpmn(m, null);
    const sub = general.diagram.shapes.find((s) => s.nodeId === "sp")!;
    expect(laneOf(general.diagram.lanes, sub)?.roleId).toBe("r1");

    const op = await generateBpmn(m, "op1");
    for (const id of ["SynthStart", "SynthEnd"]) {
      const shape = op.diagram.shapes.find((s) => s.id === id)!;
      expect(shape, id).toBeTruthy();
      expect(laneOf(op.diagram.lanes, shape)?.roleId, id).toBe("r1");
    }
  });
});
