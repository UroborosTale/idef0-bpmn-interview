import { describe, expect, it } from "vitest";
import { XMLParser } from "fast-xml-parser";
import { generateBpmn } from "../src/pipeline/bpmn.js";
import { orthogonalWaypoints } from "../src/pipeline/layout.js";
import { branchingModel, purchaseModel } from "./fixtures.js";

const overlaps = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe("BPMN", () => {
  it("вложенные функции IDEF0 не попадают на диаграмму процесса", async () => {
    const r = await generateBpmn(purchaseModel());
    expect(r.diagram.shapes.map((s) => s.nodeId).filter(Boolean).sort()).toEqual(["a", "b", "c"]);
    expect(r.xml).not.toContain("проверить бюджет");
  });

  it("XML разбирается и ссылается только на существующие элементы", async () => {
    const r = await generateBpmn(branchingModel());
    const doc = new XMLParser({ ignoreAttributes: false }).parse(r.xml);
    expect(doc["bpmn:definitions"]).toBeDefined();
    const ids = new Set([...r.xml.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]));
    for (const m of r.xml.matchAll(/(?:sourceRef|targetRef|bpmnElement)="([^"]+)"/g)) expect(ids.has(m[1])).toBe(true);
  });

  it("фигуры не перекрываются и стоят в дорожке своей роли", async () => {
    const r = await generateBpmn(branchingModel());
    const shapes = r.diagram.shapes;
    for (let i = 0; i < shapes.length; i++) for (let j = i + 1; j < shapes.length; j++) expect(overlaps(shapes[i], shapes[j]), `${shapes[i].id} × ${shapes[j].id}`).toBe(false);
    for (const s of shapes.filter((x) => x.nodeId)) {
      const node = branchingModel().nodes.find((n) => n.id === s.nodeId)!;
      const lane = r.diagram.lanes.find((l) => l.roleId === (node.role_id ?? null))!;
      expect(s.y).toBeGreaterThanOrEqual(lane.y);
      expect(s.y + s.h).toBeLessThanOrEqual(lane.y + lane.h);
    }
  });

  it("позиция из редактора приоритетнее авто-раскладки", async () => {
    const m = branchingModel();
    m.nodes.find((n) => n.id === "t3")!.layout = { x: 900, y: 75 };
    const r = await generateBpmn(m);
    const s = r.diagram.shapes.find((x) => x.nodeId === "t3")!;
    expect([s.x, s.y]).toEqual([900, 75]);
  });

  it("прямая стрелка обходит фигуру на пути (сверху или снизу)", () => {
    const from = { x: 0, y: 100, width: 100, height: 80 };
    const to = { x: 400, y: 100, width: 100, height: 80 };
    const mid = { x: 200, y: 100, width: 100, height: 80 };
    const pts = orthogonalWaypoints(from, to, [mid]);
    expect(pts.length).toBeGreaterThan(2);
    expect(Math.min(...pts.map((p) => p[1])) < mid.y || Math.max(...pts.map((p) => p[1])) > mid.y + mid.height).toBe(true);
    expect(orthogonalWaypoints(from, to, [])).toHaveLength(2);
  });
});
