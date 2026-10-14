import { describe, expect, it } from "vitest";
import { generateBpmn } from "../src/pipeline/bpmn.js";
import { LANE_H, LANE_X, MAX_DIAGRAM_W, MAX_LANE_H, MIN_DIAGRAM_W, MIN_LANE_H, START_Y, clampDiagramWidth, clampLaneHeight, laneHeightOf, laneTops } from "../src/shared/bpmnGeometry.js";
import { mergeScope, scopeView } from "../src/shared/scope.js";
import { ProcessLogicModel, ProcessMeta, Role } from "../src/types/model.js";
import { branchingModel, structuredModel } from "./fixtures.js";

describe("высота дорожек: общая геометрия", () => {
  it("высота ограничивается, кратна 10; нет настройки или она не число — стандартная", () => {
    expect(clampLaneHeight(10)).toBe(MIN_LANE_H);
    expect(clampLaneHeight(1000)).toBe(MAX_LANE_H);
    expect(clampLaneHeight(237)).toBe(240);
    expect(laneHeightOf(undefined)).toBe(LANE_H);
    expect(laneHeightOf(null)).toBe(LANE_H);
    expect(laneHeightOf(NaN)).toBe(LANE_H);
    expect(laneHeightOf(260)).toBe(260);
  });

  it("верхние границы дорожек идут друг за другом от START_Y", () => {
    expect(laneTops([150, 250, 120])).toEqual([START_Y, START_Y + 150, START_Y + 400]);
    expect(laneTops([])).toEqual([]);
  });

  it("схема принимает высоты в допустимых пределах и отвергает остальные", () => {
    expect(Role.parse({ id: "r", name: "Р", lane_height: 300 }).lane_height).toBe(300);
    expect(Role.parse({ id: "r", name: "Р", lane_height: null }).lane_height).toBeNull();
    expect(() => Role.parse({ id: "r", name: "Р", lane_height: 50 })).toThrow();
    expect(() => Role.parse({ id: "r", name: "Р", lane_height: 900 })).toThrow();
    expect(ProcessMeta.parse({ id: "p", name: "П", unassigned_lane_height: 200 }).unassigned_lane_height).toBe(200);
    expect(() => ProcessMeta.parse({ id: "p", name: "П", unassigned_lane_height: 5 })).toThrow();
  });
});

describe("высота дорожек в BPMN", () => {
  it("дорожки получают заданные высоты и идут без промежутков; фигуры стоят внутри своих дорожек", async () => {
    const m = branchingModel();
    m.roles[0].lane_height = 260; // «Юрист»
    m.roles[1].lane_height = 200; // «Менеджер»
    m.process.unassigned_lane_height = 180; // начало и конец без исполнителя — своя дорожка
    const { diagram, xml } = await generateBpmn(m, null);
    const heights = diagram.lanes.map((l) => l.h);
    expect(heights.slice(0, 2)).toEqual([260, 200]);
    expect(heights.at(-1)).toBe(180);
    diagram.lanes.slice(1).forEach((l, i) => expect(l.y).toBe(diagram.lanes[i].y + diagram.lanes[i].h));
    // фигуры лежат целиком в своей дорожке
    const lane = (roleId: string | null) => diagram.lanes.find((l) => l.roleId === roleId)!;
    for (const s of diagram.shapes) {
      const node = m.nodes.find((n) => n.id === s.nodeId);
      if (!node || s.attachedTo) continue;
      const l = lane(node.role_id ?? null);
      expect(s.y, s.name).toBeGreaterThanOrEqual(l.y);
      expect(s.y + s.h, s.name).toBeLessThanOrEqual(l.y + l.h);
    }
    // в BPMN DI те же рамки дорожек
    expect(xml).toContain(`height="260"`);
    expect(xml).toContain(`height="200"`);
    expect(xml).toContain(`height="180"`);
  });

  it("задача стоит по центру высокой дорожки, а мир диаграммы растёт вместе с дорожками", async () => {
    const base = await generateBpmn(branchingModel(), null);
    const m = branchingModel();
    m.roles[0].lane_height = 300;
    const tall = await generateBpmn(m, null);
    const t1 = tall.diagram.shapes.find((s) => s.nodeId === "t1")!;
    const lane = tall.diagram.lanes.find((l) => l.roleId === "r1")!;
    // ветки шлюза уходят рядами выше и ниже основной линии, поэтому ряд основной ветки может стоять не точно по центру
    expect(Math.abs(t1.y + t1.h / 2 - (lane.y + lane.h / 2))).toBeLessThanOrEqual(60);
    expect(t1.y).toBeGreaterThanOrEqual(lane.y);
    expect(t1.y + t1.h).toBeLessThanOrEqual(lane.y + lane.h);
    expect(tall.diagram.height).toBeGreaterThan(base.diagram.height); // заданная высота больше той, что нужна рядам веток
  });

  it("без настроек всё как прежде: все дорожки стандартной высоты", async () => {
    const { diagram } = await generateBpmn(branchingModel(), null);
    // стандартная высота; дорожка, в которой ветки шлюза идут рядами, вырастает на шаг ряда
    for (const l of diagram.lanes) expect(l.h).toBeGreaterThanOrEqual(LANE_H);
    expect(diagram.lanes.some((l) => l.h === LANE_H)).toBe(true);
  });

  it("высота роли действует на диаграмме операции: вид области сохраняет настройку, а правка из вида возвращается в модель", async () => {
    const m = structuredModel();
    const role = m.roles.find((r) => r.id === "r2")!;
    role.lane_height = 240;
    const view = scopeView(m, "o1");
    expect(view.roles.find((r) => r.id === "r2")!.lane_height).toBe(240);
    // правка в виде (высота роли и дорожки «Без исполнителя») возвращается в полную модель
    const edited = { ...view, roles: view.roles.map((r) => (r.id === "r2" ? { ...r, lane_height: 300 } : r)), process: { ...view.process, unassigned_lane_height: 210 } };
    const merged = mergeScope(m, edited, "o1", view);
    expect(merged.roles.find((r) => r.id === "r2")!.lane_height).toBe(300);
    expect(merged.process.unassigned_lane_height).toBe(210);
    const { diagram } = await generateBpmn(merged, "o1");
    expect(diagram.lanes.find((l) => l.roleId === "r2")?.h).toBe(300);
  });
});

describe("ширина дорожек", () => {
  it("ширина ограничивается и кратна 10; схема принимает ширины по диаграммам и отвергает недопустимые", () => {
    expect(clampDiagramWidth(100)).toBe(MIN_DIAGRAM_W);
    expect(clampDiagramWidth(99999)).toBe(MAX_DIAGRAM_W);
    expect(clampDiagramWidth(1234)).toBe(1230);
    const base = branchingModel();
    expect(ProcessLogicModel.parse({ ...base, diagram_widths: { "": 3000, o1: 4000 } }).diagram_widths).toEqual({ "": 3000, o1: 4000 });
    expect(() => ProcessLogicModel.parse({ ...base, diagram_widths: { o1: 100 } })).toThrow();
    expect(ProcessLogicModel.parse(base).diagram_widths).toBeUndefined();
  });

  it("общая схема процесса: дорожки не уже заданной ширины, правый край дорожек и пула совпадает с ней", async () => {
    const auto = await generateBpmn(branchingModel(), null);
    const m = branchingModel();
    m.diagram_widths = { "": auto.diagram.pool.w + 800 };
    const wide = await generateBpmn(m, null);
    expect(wide.diagram.pool.w).toBe(auto.diagram.pool.w + 800);
    for (const l of wide.diagram.lanes) expect(l.x + l.w).toBe(wide.diagram.pool.w);
    expect(LANE_X + wide.diagram.lanes[0].w).toBe(wide.diagram.pool.w);
    // заданная ширина меньше содержимого — действует содержимое
    const narrow = branchingModel();
    narrow.diagram_widths = { "": MIN_DIAGRAM_W };
    expect((await generateBpmn(narrow, null)).diagram.pool.w).toBe(auto.diagram.pool.w);
  });

  it("у каждой операции своя ширина: ключ — id операции", async () => {
    const m = structuredModel();
    const auto = (await generateBpmn(m, "o1")).diagram.pool.w;
    m.diagram_widths = { o1: auto + 1500 };
    expect((await generateBpmn(m, "o1")).diagram.pool.w).toBe(auto + 1500);
    // другая операция настройку первой не получает
    const o2 = structuredModel();
    const autoO2 = (await generateBpmn(o2, "o2")).diagram.pool.w;
    expect((await generateBpmn(m, "o2")).diagram.pool.w).toBe(autoO2);
  });

  it("вид области несёт ширину под ключом \"\", а слияние возвращает её под id области, не трогая чужие", () => {
    const m = structuredModel();
    m.diagram_widths = { o1: 2500, o2: 3100 };
    const view = scopeView(m, "o1");
    expect(view.diagram_widths).toEqual({ "": 2500 });
    // правка ширины в виде
    const merged = mergeScope(m, { ...view, diagram_widths: { "": 2900 } }, "o1", view);
    expect(merged.diagram_widths).toEqual({ o1: 2900, o2: 3100 });
    // снятие настройки в виде
    const cleared = mergeScope(m, { ...view, diagram_widths: undefined }, "o1", view);
    expect(cleared.diagram_widths).toEqual({ o2: 3100 });
    // у области без настройки в виде нет ширины, а появившаяся записывается
    const v2 = scopeView(m, "o3");
    expect(v2.diagram_widths).toBeUndefined();
    expect(mergeScope(m, { ...v2, diagram_widths: { "": 2000 } }, "o3", v2).diagram_widths).toEqual({ o1: 2500, o2: 3100, o3: 2000 });
    // без изменений модель та же
    expect(mergeScope(m, view, "o1", view)).toBe(m);
  });
});