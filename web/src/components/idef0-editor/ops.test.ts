import { describe, expect, it } from "vitest";
import { purchaseModel } from "../../test/fixtures";
import { BLOCK_H, BLOCK_W, ancestorsOf, buildIdef0, descendantsOf, functionsOf, idef0Codes, withIdef0Layout } from "./geometry";
import { addFunction, attach, createEntity, detach, linkFunctions, removeArrow, renameEntity, setFunctionRole } from "./ops";

describe("IDEF0: коды и иерархия", () => {
  it("коды функций по уровням декомпозиции", () => {
    expect(Object.fromEntries(idef0Codes(purchaseModel()))).toEqual({ a: "A1", b: "A2", c: "A3", b1: "A21", b2: "A22" });
  });

  it("предки, потомки, функции диаграммы", () => {
    const m = purchaseModel();
    expect(functionsOf(m, null).map((n) => n.id)).toEqual(["a", "b", "c"]);
    expect(functionsOf(m, "b").map((n) => n.id)).toEqual(["b1", "b2"]);
    expect(ancestorsOf(m, "b2")).toEqual(["b"]);
    expect(descendantsOf(m, "b")).toEqual(["b1", "b2"]);
  });

  it("стрелки A0: связь выход→вход и выход→управление между функциями", () => {
    const keys = buildIdef0(purchaseModel(), null).arrows.map((a) => a.key);
    expect(keys).toContain("link:b:d1");
    expect(keys).toContain("controlLink:c:d3");
  });

  it("раскладка достраивает позиции на всех уровнях", () => {
    const m = withIdef0Layout(purchaseModel());
    expect(m.nodes.every((n) => n.idef0_layout)).toBe(true);
  });
});

describe("IDEF0: операции", () => {
  it("прикрепление без дублей и открепление", () => {
    let m = attach(purchaseModel(), "a", "inputs", "d2");
    m = attach(m, "a", "inputs", "d2");
    expect(m.nodes[0].inputs).toEqual(["d2"]);
    expect(detach(m, "a", "inputs", "d2").nodes[0].inputs).toEqual([]);
  });

  it("новая сущность и переименование", () => {
    const c = createEntity(purchaseModel(), "control", "ГОСТ");
    expect(c.model.controls.find((x) => x.id === c.id)).toMatchObject({ name: "ГОСТ", kind: "rule" });
    expect(renameEntity(c.model, "control", c.id!, "ГОСТ Р").controls.find((x) => x.id === c.id)?.name).toBe("ГОСТ Р");
  });

  it("связь функций: свободного выхода нет — создаётся документ; повтор запрещён", () => {
    const r = linkFunctions(purchaseModel(), "a", "c");
    expect(r.error).toBeUndefined();
    const created = r.model.data.find((d) => d.id === r.id)!;
    expect(created.name).toBe("Новый документ");
    expect(r.model.nodes.find((n) => n.id === "c")!.inputs).toContain(created.id);
    expect(r.key).toBe(`link:c:${created.id}`);
    expect(linkFunctions(r.model, "a", "c").error).toMatch(/уже связаны/);
    expect(linkFunctions(r.model, "a", "a").error).toBeTruthy();
  });

  it("связь как управление", () => {
    const r = linkFunctions(purchaseModel(), "a", "c", "control");
    expect(r.key).toMatch(/^controlLink:c:/);
    expect(r.model.nodes.find((n) => n.id === "c")!.control_data_ids).toContain(r.id);
  });

  it("удаление стрелки снимает ссылку нужного вида, сущность остаётся в справочнике", () => {
    const m = purchaseModel();
    expect(removeArrow(m, { kind: "controlLink", nodeId: "c", entityId: "d3" }).nodes.find((n) => n.id === "c")!.control_data_ids).toEqual([]);
    expect(removeArrow(m, { kind: "system", nodeId: "c", entityId: "s1" }).nodes.find((n) => n.id === "c")!.system_ids).toEqual([]);
    expect(removeArrow(m, { kind: "role", nodeId: "c", entityId: "r2" }).nodes.find((n) => n.id === "c")!.role_id).toBeNull();
    expect(removeArrow(m, { kind: "control", nodeId: "a", entityId: "c1" }).controls).toHaveLength(1);
  });

  it("новая функция не налезает на соседей", () => {
    const m = withIdef0Layout(purchaseModel());
    const first = m.nodes[0].idef0_layout!;
    const r = addFunction(m, null, first.x + BLOCK_W / 2, first.y + BLOCK_H / 2);
    const p = r.model.nodes.find((n) => n.id === r.id)!.idef0_layout!;
    for (const o of functionsOf(m, null)) {
      const q = o.idef0_layout!;
      expect(Math.abs(q.x - p.x) >= BLOCK_W + 30 || Math.abs(q.y - p.y) >= BLOCK_H + 50, o.id).toBe(true);
    }
    expect(r.model.nodes.find((n) => n.id === r.id)!.idef0_parent).toBeNull();
  });

  it("исполнитель функции без позиции в BPMN меняется без переноса фигуры", () => {
    const m = setFunctionRole(purchaseModel(), "b1", "r2");
    expect(m.nodes.find((n) => n.id === "b1")).toMatchObject({ role_id: "r2" });
    expect(m.nodes.find((n) => n.id === "b1")!.layout).toBeUndefined();
  });
});
