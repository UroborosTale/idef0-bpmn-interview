import { describe, expect, it } from "vitest";
import { artifactsOf } from "../src/shared/bpmnArtifacts.js";

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
