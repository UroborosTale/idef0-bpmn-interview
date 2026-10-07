import { describe, expect, it } from "vitest";
import { purchaseModel } from "../../test/fixtures";
import { LANE_H, START_Y, autoLayout, boxOf, laneIndexAtY, laneIndexOfRole, positionsFromBpmnXml, visibleNodes, withLayout, wrapText } from "./geometry";
import { addFlow, addNodeAt, addRole, deleteNode, deleteRole, dropNodeIntoLane, moveNode, nextId, setNodeRole, setNodeType } from "./model-ops";

const laid = () => withLayout(purchaseModel());

describe("BPMN: операции над моделью", () => {
  it("nextId не повторяет занятые id", () => {
    expect(nextId("n", ["n1", "n2"])).toBe("n3");
    expect(nextId("n", ["n3", "x"])).toBe("n4");
    expect(nextId("flow", [])).toBe("flow1");
  });

  it("стрелка: запреты и успешное добавление", () => {
    const m = purchaseModel();
    m.nodes.push({ ...m.nodes[0], id: "s", type: "event", subtype: "start", name: "Начало" }, { ...m.nodes[0], id: "e", type: "event", subtype: "end", name: "Конец" });
    expect(addFlow(m, "a", "a").error).toMatch(/самим собой/);
    expect(addFlow(m, "a", "b").error).toMatch(/уже есть/);
    expect(addFlow(m, "e", "a").error).toMatch(/конечного/);
    expect(addFlow(m, "a", "s").error).toMatch(/начальное/);
    expect(addFlow(m, "a", "zzz").error).toBeTruthy();
    const ok = addFlow(m, "s", "a");
    expect(ok.error).toBeUndefined();
    expect(ok.model.flows.find((f) => f.id === ok.id)).toMatchObject({ from: "s", to: "a" });
  });

  it("удаление функции уносит вложенные функции, их связи, RACI и ссылки интерфейсов", () => {
    const base = purchaseModel();
    base.interfaces.push({ id: "i2", direction: "out", data_id: "d4", linked_node_id: "b2" });
    base.raci.push({ node_id: "b1", role_id: "r2", type: "C" });
    const m = deleteNode(base, "b");
    expect(m.nodes.map((n) => n.id)).toEqual(["a", "c"]);
    expect(m.flows).toEqual([]);
    expect(m.raci.every((r) => r.node_id === "a")).toBe(true);
    expect(m.interfaces.find((i) => i.id === "i2")?.linked_node_id).toBeNull();
  });

  it("смена типа подставляет вид по умолчанию и сохраняет центр фигуры", () => {
    const m = laid();
    const before = boxOf(m.nodes[0]);
    const g = setNodeType(m, "a", "gateway");
    const n = g.nodes[0];
    expect(n).toMatchObject({ type: "gateway", subtype: "exclusive" });
    const after = boxOf(n);
    expect(Math.abs(after.x + after.w / 2 - (before.x + before.w / 2))).toBeLessThanOrEqual(10);
    expect(setNodeType(m, "a", "task")).toBe(m); // тот же тип — модель не меняется
  });

  it("дорожки: новая роль, отказ удалить непустую, перенос фигуры между дорожками", () => {
    const m = laid();
    const added = addRole(m);
    expect(added.model.roles).toHaveLength(3);
    expect(deleteRole(m, "r1").error).toBeTruthy();
    const moved = setNodeRole(m, "a", "r2");
    const a = moved.nodes.find((n) => n.id === "a")!;
    expect(a.role_id).toBe("r2");
    expect(laneIndexAtY(moved, boxOf(a).y + boxOf(a).h / 2)).toBe(laneIndexOfRole(moved, "r2"));
  });

  it("перетаскивание: исполнитель — дорожка под центром фигуры, фигура остаётся внутри дорожки", () => {
    const m = laid();
    const lane2Top = START_Y + 2 * LANE_H; // третья дорожка — «Без исполнителя»
    const dropped = dropNodeIntoLane(moveNode(m, "a", 300, lane2Top + 5), "a");
    const a = dropped.nodes.find((n) => n.id === "a")!;
    expect(a.role_id).toBeNull();
    expect(boxOf(a).y).toBeGreaterThanOrEqual(lane2Top);
    expect(boxOf(a).y + boxOf(a).h).toBeLessThanOrEqual(lane2Top + LANE_H);
  });

  it("новая фигура из палитры получает исполнителя по дорожке", () => {
    const m = laid();
    const r = addNodeAt(m, { type: "task", name: "Новая задача" }, 500, START_Y + LANE_H + LANE_H / 2);
    expect(r.model.nodes.find((n) => n.id === r.id)?.role_id).toBe("r2");
  });
});

describe("BPMN: раскладка", () => {
  it("вложенные функции IDEF0 в BPMN не показываются", () => {
    expect(visibleNodes(purchaseModel()).map((n) => n.id)).toEqual(["a", "b", "c"]);
  });

  it("авто-раскладка: по столбцу на шаг цепочки, по строке на дорожку, без наложений", () => {
    const pos = autoLayout(purchaseModel());
    const a = pos.get("a")!;
    const b = pos.get("b")!;
    const c = pos.get("c")!;
    expect(a.x).toBeLessThan(b.x);
    expect(b.x).toBeLessThan(c.x);
    expect(a.y).toBe(b.y); // одна дорожка
    expect(c.y).toBeGreaterThan(b.y);
    expect(pos.has("b1")).toBe(false);
  });

  it("позиции из BPMN сервера применяются только к фигурам без своей позиции", () => {
    const xml = `<bpmndi:BPMNShape id="Node_a_di" bpmnElement="a"><dc:Bounds x="400" y="77" width="100" height="80"/></bpmndi:BPMNShape>`;
    const seed = positionsFromBpmnXml(xml);
    expect(seed.get("a")).toEqual({ x: 400, y: 77 });
    const m = purchaseModel();
    m.nodes[1].layout = { x: 1000, y: 1000 };
    const out = withLayout(m, false, seed);
    expect(out.nodes[0].layout).toEqual({ x: 400, y: 77 });
    expect(out.nodes[1].layout).toEqual({ x: 1000, y: 1000 });
    expect(out.nodes[2].layout).toBeTruthy();
    expect(positionsFromBpmnXml(null).size).toBe(0);
  });

  it("перенос подписи по словам с многоточием", () => {
    // многоточие занимает место последнего символа, чтобы строка не стала шире
    expect(wrapText("проверить договор на соответствие шаблону", 12, 2)).toEqual(["проверить", "договор н…"]);
    expect(wrapText("оченьдлинноеслово", 6, 5)).toEqual(["оченьд", "линное", "слово"]);
  });
});
