import { describe, expect, it } from "vitest";
import { purchaseModel } from "../../test/fixtures";
import { addEntry, entriesOf, entryOf, removeEntry, unlinkedCount, updateEntry, usageOf } from "./dict-ops";

describe("справочники: где используется", () => {
  it("документ — входы, выходы и управление данными по всем уровням декомпозиции", () => {
    const m = purchaseModel();
    expect(usageOf(m, "data", "d1").map((u) => `${u.nodeId}:${u.how}`)).toEqual(["a:выход", "b:вход", "b1:вход"]);
    expect(usageOf(m, "data", "d3").map((u) => `${u.nodeId}:${u.how}`)).toEqual(["b:выход", "c:управление", "b2:выход"]);
  });

  it("исполнитель, система и регламент", () => {
    const m = purchaseModel();
    expect(usageOf(m, "roles", "r1").map((u) => u.nodeId)).toEqual(["a", "b"]);
    expect(usageOf(m, "systems", "s1")).toEqual([{ nodeId: "c", nodeName: "оплатить счёт", how: "механизм" }]);
    expect(usageOf(m, "controls", "c1")).toHaveLength(4);
  });

  it("функции без исполнителя и без системы считаются для подсказки", () => {
    const m = purchaseModel();
    expect(unlinkedCount(m, "roles")).toBe(2); // b1, b2
    expect(unlinkedCount(m, "systems")).toBe(4);
    expect(unlinkedCount(m, "kpi")).toBe(0);
    // шаг диаграммы операции не входит в «функций N» строки состояния и не должен попадать в подсказку
    const withStep = { ...m, nodes: [...m.nodes, { ...m.nodes[0], id: "step", name: "Шаг операции", bpmn_scope: "a", role_id: null }] };
    expect(unlinkedCount(withStep, "roles")).toBe(2);
  });
});

describe("справочники: добавление и правка", () => {
  it("новая запись каждого вида получает свободный id и попадает в свой список", () => {
    for (const kind of ["roles", "systems", "data", "controls", "kpi", "risks"] as const) {
      const m = purchaseModel();
      const r = addEntry(m, kind, "Новая запись");
      const list = entriesOf(r.model, kind);
      expect(list.length, kind).toBe(entriesOf(m, kind).length + 1);
      expect(entryOf(r.model, kind, r.id)?.name, kind).toBe("Новая запись");
      expect(entriesOf(m, kind).some((e) => e.id === r.id), kind).toBe(false);
    }
  });

  it("правка не меняет исходную модель (история правок опирается на неизменяемость)", () => {
    const m = purchaseModel();
    const snapshot = JSON.stringify(m);
    updateEntry(m, "data", "d1", { name: "заявка на закупку", description: "Форма З-1" });
    removeEntry(m, "roles", "r1");
    expect(JSON.stringify(m)).toBe(snapshot);
  });

  it("поля карточки сохраняются у любого справочника", () => {
    let m = purchaseModel();
    m = updateEntry(m, "roles", "r1", { name: "Заявитель", description: "Сотрудник подразделения", owner: "Отдел закупок" });
    expect(m.roles[0]).toMatchObject({ name: "Заявитель", description: "Сотрудник подразделения", owner: "Отдел закупок" });
    m = addEntry(m, "kpi", "Срок закупки").model;
    m = updateEntry(m, "kpi", m.process.kpi[0].id, { target: "5", unit: "дней", period: "ежемесячно" });
    expect(m.process.kpi[0]).toMatchObject({ target: "5", unit: "дней", period: "ежемесячно" });
  });
});

describe("справочники: удаление снимает ссылки", () => {
  it("документ убирается из входов, выходов, управления и интерфейсов процесса", () => {
    const m = removeEntry(purchaseModel(), "data", "d3");
    expect(m.data.some((d) => d.id === "d3")).toBe(false);
    expect(m.nodes.flatMap((n) => [...n.inputs, ...n.outputs, ...(n.control_data_ids ?? [])])).not.toContain("d3");
    const m2 = removeEntry(purchaseModel(), "data", "d2");
    expect(m2.interfaces).toEqual([]);
  });

  it("исполнитель: шаги остаются без исполнителя, отметки RACI удаляются", () => {
    const m = removeEntry(purchaseModel(), "roles", "r1");
    expect(m.roles.map((r) => r.id)).toEqual(["r2"]);
    expect(m.nodes.find((n) => n.id === "a")?.role_id).toBeNull();
    expect(m.nodes).toHaveLength(5);
    expect(m.raci).toEqual([]);
  });

  it("исполнитель: ссылки респондентов мультиинтервью на удалённую роль снимаются", () => {
    const base = purchaseModel();
    base.respondents = [{ id: "resp1", name: "Иванов", role_id: "r1", session_ids: [], weight: 1 }];
    const m = removeEntry(base, "roles", "r1");
    expect(m.respondents[0].role_id ?? null).toBeNull();
  });

  it("система и регламент", () => {
    expect(removeEntry(purchaseModel(), "systems", "s1").nodes.find((n) => n.id === "c")?.system_ids).toEqual([]);
    expect(removeEntry(purchaseModel(), "controls", "c1").nodes.every((n) => n.controls.length === 0)).toBe(true);
  });
});

describe("удаление записи убирает привязанные к ней ручные положения", () => {
  it("смещения значков BPMN и маршруты стрелок IDEF0 удалённого документа не достаются новой записи с тем же id", async () => {
    const { structuredModel } = await import("../../test/fixtures");
    const { addEntry, removeEntry } = await import("./dict-ops");
    const m = structuredModel();
    const b1 = m.nodes.find((n) => n.id === "b1")!;
    b1.inputs = ["d1"];
    b1.artifact_offsets = { "input:d1": { dx: 40, dy: 10 }, "store:s1": { dx: 5, dy: 5 } };
    const o1 = m.nodes.find((n) => n.id === "o1")!;
    o1.arrow_routes = { "input:d1": { points: [[10, 20]] }, "control:c1": { pos: 0.3 } };
    const removed = removeEntry(m, "data", "d1");
    const nb1 = removed.nodes.find((n) => n.id === "b1")!;
    expect(nb1.artifact_offsets).toEqual({ "store:s1": { dx: 5, dy: 5 } }); // чужие смещения остались
    expect(removed.nodes.find((n) => n.id === "o1")!.arrow_routes).toEqual({ "control:c1": { pos: 0.3 } });
    // новая запись с освободившимся id появляется без чужого положения
    const again = addEntry(removed, "data", "Новый документ");
    expect(again.model.nodes.find((n) => n.id === "b1")!.artifact_offsets?.[`input:${again.id}`]).toBeUndefined();
  });
});
