import { describe, expect, it } from "vitest";
import { artifactsOf, messageEdges, poolBoxes } from "../src/shared/bpmnArtifacts.js";

const names = { data: new Map([["d1", "Заявка"]]), systems: new Map([["s1", "1С"]]) };
const node = (extra = {}) => ({ id: "t", type: "task", inputs: ["d1"], outputs: [], system_ids: ["s1"], ...extra });
const boxes = new Map([["t", { x: 200, y: 100, w: 100, h: 60 }]]);

describe("значки документов: ручное смещение", () => {
  it("без смещения место прежнее, со смещением значок сдвигается вместе с ассоциацией", () => {
    const [doc0, store0] = artifactsOf([node()], boxes, names);
    const [doc1, store1] = artifactsOf([node({ artifact_offsets: { "input:d1": { dx: 40, dy: -10 } } })], boxes, names);
    expect(doc1.box).toEqual({ ...doc0.box, x: doc0.box.x + 40, y: doc0.box.y - 10 });
    expect(store1.box).toEqual(store0.box); // другой значок не тронут
    expect(doc1.edge[0][0]).toBe(doc1.box.x + doc1.box.w / 2);
  });

  it("значок сбоку от задачи связывается с её боковой стороной", () => {
    const [doc] = artifactsOf([node({ artifact_offsets: { "input:d1": { dx: -200, dy: 50 } } })], boxes, names);
    const end = doc.edge[1];
    expect(end[0]).toBe(200); // левая сторона задачи
    expect(end[1]).toBeGreaterThanOrEqual(100);
    expect(end[1]).toBeLessThanOrEqual(160);
  });
});

describe("значки и пулы едут вместе с задачами", () => {
  it("смещение значка хранится относительно задачи: при сдвиге задачи (в том числе группой) значок с его ручным смещением сдвигается на столько же", () => {
    const n = node({ artifact_offsets: { "input:d1": { dx: 40, dy: -10 } } });
    const at = (x: number, y: number) => artifactsOf([n], new Map([["t", { x, y, w: 100, h: 60 }]]), names);
    const [a, b] = [at(200, 100), at(500, 340)];
    for (let i = 0; i < a.length; i++) {
      expect(b[i].box.x - a[i].box.x).toBe(300);
      expect(b[i].box.y - a[i].box.y).toBe(240);
    }
  });

  it("пул со своим смещением следует за шагом, к которому привязан: ручное смещение остаётся относительным", () => {
    const msgs = [{ id: "m", from: "t", to: "p" }];
    const pools = [{ id: "p", name: "Поставщики", dx: 70, dy: 25 }];
    const one = poolBoxes(pools, msgs, new Map([["t", { x: 200, y: 100, w: 100, h: 60 }]]), 400).get("p")!;
    const two = poolBoxes(pools, msgs, new Map([["t", { x: 500, y: 100, w: 100, h: 60 }]]), 400).get("p")!;
    expect(two.x - one.x).toBe(300);
    expect(two.y).toBe(one.y);
    expect(messageEdges(msgs, new Map([["t", { x: 500, y: 100, w: 100, h: 60 }]]), new Map([["p", two]]))[0].points.at(-1)![0]).toBe(two.x + two.w / 2);
  });
});
