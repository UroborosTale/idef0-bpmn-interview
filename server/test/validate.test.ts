import { describe, expect, it } from "vitest";
import { validateModel } from "../src/pipeline/validate.js";
import { branchingModel, purchaseModel } from "./fixtures.js";

const rules = (issues: ReturnType<typeof validateModel>, severity?: "error" | "warning") =>
  issues.filter((i) => !severity || i.severity === severity).map((i) => i.rule);

describe("валидация", () => {
  it("модель без явных событий не даёт ошибок старта/конца (их достраивает генератор)", () => {
    expect(rules(validateModel(purchaseModel()), "error")).toEqual([]);
  });

  it("корректный процесс с событиями и шлюзом — без ошибок", () => {
    expect(rules(validateModel(branchingModel()), "error")).toEqual([]);
  });

  it("недостижимый узел — ошибка", () => {
    const m = branchingModel();
    m.nodes.push({ ...m.nodes[1], id: "lost", name: "потерянный шаг" });
    m.flows.push({ id: "fx", from: "lost", to: "e", source: [], confirmed_by: [] });
    expect(rules(validateModel(m), "error")).toContain("bpmn_unreachable_node");
  });

  it("замкнутый процесс без входа — ошибка", () => {
    const m = branchingModel();
    m.nodes = m.nodes.filter((n) => n.type !== "event");
    m.flows = [
      { id: "a", from: "t1", to: "g", source: [], confirmed_by: [] },
      { id: "b", from: "g", to: "t1", source: [], confirmed_by: [] },
    ];
    m.nodes = m.nodes.filter((n) => n.id === "t1" || n.id === "g");
    expect(rules(validateModel(m), "error")).toEqual(expect.arrayContaining(["bpmn_no_start", "bpmn_no_end"]));
  });

  it("управление данными от другой функции считается управлением", () => {
    const issues = validateModel(purchaseModel());
    expect(issues.filter((i) => i.rule === "idef0_no_control" && i.message.includes("оплатить"))).toEqual([]);
  });

  it("несбалансированная декомпозиция — предупреждение", () => {
    const m = purchaseModel();
    m.nodes.find((n) => n.id === "b2")!.outputs.push("d4");
    expect(rules(validateModel(m), "warning")).toContain("idef0_unbalanced");
  });
});
