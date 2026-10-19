import { describe, expect, it } from "vitest";
import { b002Model } from "../src/reference/b002.js";
import { layoutIdef0, offpageMarks } from "../src/shared/idef0Layout.js";

/**
 * В11 (план BS6): междиаграммная ссылка — конец стрелки, помеченный «Ссылка на диаграмму», рисуется значком
 * страницы (как OffPageReference в Business Studio), а не скобками туннеля.
 */
const marked = () => {
  const model = b002Model();
  const fn = model.nodes.find((n) => !n.bpmn_scope && !n.idef0_parent && n.inputs.length > 0)!;
  fn.tunnels = { [`input:${fn.inputs[0]}`]: { upKind: "offpage" } };
  return { model, fn };
};

describe("ссылка на диаграмму IDEF0", () => {
  it("помеченный конец становится ссылкой, а не скобками туннеля", () => {
    const { model, fn } = marked();
    const a = layoutIdef0(model, null).arrows.find((x) => x.kind === "input" && x.nodeId === fn.id)!;
    expect(a.offpageUp).toBe(true);
    expect(a.tunnelUp).toBeFalsy();
    expect(a.boundaryUp).toBeFalsy();
  });

  it("значок страницы стоит у свободного конца, в 12 px внутрь стрелки", () => {
    const { model, fn } = marked();
    const a = layoutIdef0(model, null).arrows.find((x) => x.kind === "input" && x.nodeId === fn.id)!;
    const pts = offpageMarks(a);
    expect(pts).toHaveLength(1);
    const free = a.points[0];
    expect(Math.hypot(pts[0][0] - free[0], pts[0][1] - free[1])).toBeCloseTo(12, 6);
  });

  it("без пометки значков нет", () => {
    const { model, fn } = marked();
    fn.tunnels = {};
    const a = layoutIdef0(model, null).arrows.find((x) => x.kind === "input" && x.nodeId === fn.id)!;
    expect(offpageMarks(a)).toEqual([]);
    expect(a.offpageUp).toBeFalsy();
  });
});
