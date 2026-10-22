import { describe, expect, it } from "vitest";
import { layoutIdef0 } from "../src/shared/idef0Layout.js";

/**
 * «Разбитая стрелка» IDEF0 (как «Разбить стрелку»/«Соединить стрелки» в Business Studio): когда одна сущность
 * в одном виде приходит в несколько блоков, подпись на диаграмме ставится один раз — иначе имя документа повторяется
 * у каждой стрелки и разветвление не читается. Должности и системы сюда не попадают: у них отдельная «шина».
 */
const fn = (id: string, name: string, x: number, inputs: string[]) => ({
  id,
  type: "task" as const,
  name,
  idef0_parent: null,
  inputs,
  outputs: [],
  controls: [],
  system_ids: [],
  role_id: null,
  idef0_layout: { x, y: 0 },
  status: "confirmed" as const,
  confidence: 1,
  source: [],
  requirement_ids: [],
  tags: [],
  confirmed_by: [],
});

const model = (nodes: ReturnType<typeof fn>[]) =>
  ({
    process: { code: "B1", name: "Процесс" },
    nodes,
    data: [{ id: "d1", name: "Договор", kind: "document" }],
    controls: [],
    roles: [],
    systems: [],
    assignments: [],
    flows: [],
    messages: [],
    pools: [],
  }) as never;

/**
 * Управления на разных блоках не сводятся в общий ствол: длинная горизонталь пересекала бы вертикали
 * других управлений и стрелок (I5). На одном блоке общий ствол по-прежнему нужен — его проверяет
 * разбитая стрелка ниже.
 */
describe("ствол управлений IDEF0", () => {
  it("управления разных блоков идут отдельными короткими стрелками", () => {
    const withCtl = (id: string, name: string, x: number) => ({ ...fn(id, name, x, []), controls: ["c1"] });
    const layout = layoutIdef0(
      {
        process: { code: "B1", name: "Процесс" },
        nodes: [withCtl("f1", "Функция 1", 0), withCtl("f2", "Функция 2", 420)],
        data: [{ id: "d1", name: "Договор", kind: "document" }],
        controls: [{ id: "c1", name: "Регламент" }],
        roles: [],
        systems: [],
        assignments: [],
        flows: [],
        messages: [],
        pools: [],
      } as never,
      null
    );
    const ctrls = layout.arrows.filter((a) => a.kind === "control" && a.entityId === "c1");
    expect(ctrls).toHaveLength(2);
    for (const a of ctrls) {
      expect(a.points).toHaveLength(2);
      expect(a.points[0][1]).toBeLessThan(a.points[1][1]); // стрелка идёт сверху вниз в блок
    }
    expect(ctrls[0].points[0][0]).not.toBe(ctrls[1].points[0][0]);
  });
});


describe("разбитая стрелка IDEF0: одна подпись на сущность", () => {
  it("подпись остаётся у первой стрелки, у копий скрывается", () => {
    const layout = layoutIdef0(model([fn("f1", "Функция 1", 0, ["d1"]), fn("f2", "Функция 2", 420, ["d1"])]), null);
    const inputs = layout.arrows.filter((a) => a.kind === "input" && a.entityId === "d1");
    expect(inputs).toHaveLength(2);
    expect(inputs[0].labelHidden ?? false).toBe(false);
    expect(inputs[1].labelHidden).toBe(true);
    expect(inputs.filter((a) => a.label && !a.labelHidden)).toHaveLength(1);
  });

  it("одна стрелка и разные виды одной сущности подписи не теряют", () => {
    const one = layoutIdef0(model([fn("f1", "Функция 1", 0, ["d1"])]), null);
    expect(one.arrows.filter((a) => a.kind === "input" && a.entityId === "d1")).toHaveLength(1);
    expect(one.arrows.filter((a) => a.label && !a.labelHidden).length).toBeGreaterThan(0);

    const mixed = layoutIdef0(model([fn("f1", "Функция 1", 0, ["d1"]), fn("f2", "Функция 2", 420, [])]), null);
    const inputs = mixed.arrows.filter((a) => a.kind === "input" && a.entityId === "d1");
    const outputs = mixed.arrows.filter((a) => a.kind === "output" && a.entityId === "d1");
    expect(inputs).toHaveLength(1);
    expect(outputs).toHaveLength(0); // выходом d1 ни у кого не сделан — скрывать нечего
    expect(inputs[0].labelHidden ?? false).toBe(false);
  });
});
