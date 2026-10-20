import { describe, expect, it } from "vitest";
import { detectAntipatterns } from "../src/pipeline/antipatterns.js";
import { emptyModel } from "../src/types/model.js";

/**
 * B12 из отчёта 19.10: «Подряд 16 согласований» включало технический шлюз «Согласование завершено»,
 * а две почти совпадающие петли давали одинаковый ключ ap_loop_… (React ругался на дубль).
 */
const node = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, type: "task", name: id, role_id: null, inputs: [], outputs: [], controls: [], system_ids: [], source: [], confirmed_by: [], ...extra }) as never;
const flow = (from: string, to: string) => ({ id: `${from}-${to}`, from, to, source: [], confirmed_by: [] }) as never;

describe("антипаттерны (B12)", () => {
  it("шлюзы не считаются согласованиями, но цепочка согласований проходит через них", () => {
    const m = emptyModel({ id: "p", name: "Процесс" });
    m.nodes.push(
      node("a", { name: "Согласовать заявку" }),
      node("g1", { type: "gateway", subtype: "exclusive", name: "Согласование завершено" }),
      node("b", { name: "Утвердить решение" }),
      node("g2", { type: "gateway", subtype: "exclusive", name: "Слияние потоков" }),
      node("c", { name: "Одобрить бюджет" })
    );
    m.flows.push(flow("a", "g1"), flow("g1", "b"), flow("b", "g2"), flow("g2", "c"));
    const approval = detectAntipatterns(m).find((f) => f.rule === "excessive_approval")!;
    expect(approval.elementIds).toEqual(["a", "b", "c"]);
  });

  it("у почти совпадающих петель разные ключи", () => {
    const m = emptyModel({ id: "p", name: "Процесс" });
    m.nodes.push(node("a", { name: "Проверить" }), node("b", { name: "Согласовать" }), node("c", { name: "Уточнить" }));
    m.flows.push(flow("a", "b"), flow("b", "a"), flow("a", "c"), flow("c", "a"));
    const loops = detectAntipatterns(m).filter((f) => f.rule === "loop_without_exit");
    expect(loops.length).toBeGreaterThan(0);
    expect(new Set(loops.map((f) => f.id)).size).toBe(loops.length);
  });

  it("операция с шагами не предлагается к удалению как шаг без выхода", () => {
    const m = emptyModel({ id: "p", name: "Процесс" });
    m.nodes.push(
      node("op", { type: "subprocess", name: "Обработка ответа клиента" }),
      node("s1", { name: "Проверить ответ", bpmn_scope: "op", outputs: ["d1"] })
    );
    const finding = detectAntipatterns(m).find((f) => f.rule === "step_without_output" && f.elementIds.includes("op"));
    expect(finding).toBeUndefined();
  });
});
