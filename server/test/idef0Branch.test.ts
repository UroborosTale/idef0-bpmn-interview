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
 * Ствол управлений: копии одной сущности сходятся в общей горизонтали над блоками. Если вылет ствола рисует только
 * головная стрелка, участок между ней и копией остаётся пустым и ствол выглядит разорванным (замечание с осмотра).
 */
describe("ствол управлений IDEF0 непрерывный", () => {
  it("каждая копия проходит через вылет ствола", () => {
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
    const xs = ctrls.flatMap((a) => a.points.map((p) => p[0]));
    const ys = ctrls.flatMap((a) => a.points.map((p) => p[1]));
    const stub: [number, number] = [Math.min(...xs), Math.min(...ys)];
    // общий вылет ствола есть в каждой стрелке — ствол непрерывный
    for (const a of ctrls) expect(a.points.some((p) => p[0] === stub[0] && p[1] === stub[1])).toBe(true);
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
