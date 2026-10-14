import { describe, expect, it } from "vitest";
import { generateBpmn } from "../src/pipeline/bpmn.js";
import { ProcessFlow } from "../src/types/model.js";
import { fixedRoute, routeFlows, routeFlowsDetailed, type RouteFlow, type RouteNode } from "../src/shared/bpmnRouting.js";
import { purchaseModel } from "./fixtures.js";

/** Размеры фигур, на которые рассчитаны ожидаемые числа этого теста (логика маршрутов от размеров не зависит). */
const SIZE = { task: { w: 100, h: 80 }, subprocess: { w: 110, h: 80 }, gateway: { w: 50, h: 50 }, event: { w: 36, h: 36 } };
import { JOG, STUB, insertJog, interiorOf, moveCorner, moveSegment, nearestSegment, orthogonalPath, positionOnSide, tidy, type Pt } from "../src/shared/bpmnManual.js";

/** Каждая пара соседних точек лежит на одной горизонтали или вертикали. */
const orthogonal = (poly: Pt[]) => poly.slice(1).every((p, i) => Math.abs(p[0] - poly[i][0]) < 0.5 || Math.abs(p[1] - poly[i][1]) < 0.5);

describe("ручной маршрут: ортогональная ломаная", () => {
  it("tidy убирает повторы и точки на прямой", () => {
    expect(tidy([[0, 0], [10, 0], [10, 0], [20, 0], [20, 30]])).toEqual([[0, 0], [20, 0], [20, 30]]);
  });

  it("без точек: из правой стороны в левую со смещением — Z-образная линия", () => {
    const path = orthogonalPath([100, 100], "R", [], [300, 200], "L");
    expect(path[0]).toEqual([100, 100]);
    expect(path.at(-1)).toEqual([300, 200]);
    expect(orthogonal(path)).toBe(true);
    expect(path[1][1]).toBe(100); // выходит горизонтально
    expect(path.at(-2)![1]).toBe(200); // входит горизонтально
  });

  it("проходит через заданные точки в заданном порядке, достраивая колена", () => {
    const path = orthogonalPath([100, 100], "R", [[200, 60], [260, 60], [260, 180]], [300, 200], "L");
    expect(orthogonal(path)).toBe(true);
    // точка (200,60) лежит посреди прямого отрезка — она не излом и убирается; изломы остаются, в заданном порядке
    for (const v of [[260, 60], [260, 180]]) expect(path.some((p) => p[0] === v[0] && p[1] === v[1])).toBe(true);
    expect(path.findIndex((p) => p[0] === 260 && p[1] === 60)).toBeLessThan(path.findIndex((p) => p[0] === 260 && p[1] === 180));
    expect(path.some((p) => p[0] === 200 && p[1] === 60)).toBe(false);
  });

  it("точка, не лежащая на линиях соседей, даёт колено, а не косой отрезок", () => {
    const path = orthogonalPath([100, 100], "R", [[250, 40]], [400, 100], "L");
    expect(orthogonal(path)).toBe(true);
  });

  it("у портов линия идёт прямо от фигуры (STUB), даже если следующая точка сбоку", () => {
    const path = orthogonalPath([100, 100], "R", [[100, 40]], [300, 100], "L");
    expect(orthogonal(path)).toBe(true);
    expect(path[1][1]).toBe(100); // первый отрезок горизонтален — вдоль нормали правой стороны
    expect(path[1][0]).toBeGreaterThanOrEqual(100 + STUB);
  });

  it("конец входит перпендикулярно стороне: в верх фигуры — сверху вниз", () => {
    const path = orthogonalPath([100, 100], "R", [[200, 100]], [300, 220], "T");
    expect(orthogonal(path)).toBe(true);
    expect(path.at(-2)![0]).toBe(300);
    expect(path.at(-2)![1]).toBeLessThan(220);
  });
});

describe("ручной маршрут: правка отрезков и изломов", () => {
  // Z-образная: порт (100,100) → (200,100) → (200,200) → порт (300,200)
  const z: Pt[] = [[100, 100], [200, 100], [200, 200], [300, 200]];

  it("средний отрезок сдвигается поперёк, соседние удлиняются", () => {
    expect(moveSegment(z, 1, 50)).toEqual([[100, 100], [250, 100], [250, 200], [300, 200]]);
    expect(moveSegment(z, 1, -40)).toEqual([[100, 100], [160, 100], [160, 200], [300, 200]]);
  });

  it("отрезок у порта не двигает порт: у него появляется прямой участок и ступенька", () => {
    const moved = moveSegment(z, 0, 30);
    expect(moved[0]).toEqual([100, 100]);
    expect(orthogonal(moved)).toBe(true);
    expect(moved[1][1]).toBe(100); // сначала прямо
    expect(moved.some((p) => p[1] === 130)).toBe(true); // потом на 30 ниже
    expect(moved.at(-1)).toEqual([300, 200]);
  });

  it("единственный прямой отрезок между портами сдвигается со ступеньками у обоих концов", () => {
    const moved = moveSegment([[100, 100], [300, 100]], 0, -40);
    expect(moved[0]).toEqual([100, 100]);
    expect(moved.at(-1)).toEqual([300, 100]);
    expect(orthogonal(moved)).toBe(true);
    expect(moved.some((p) => p[1] === 60)).toBe(true);
  });

  it("излом переносится вместе с двумя своими отрезками", () => {
    const l: Pt[] = [[100, 100], [300, 100], [300, 250], [400, 250]];
    // излом (300,100) переехал в (340,60): горизонтальный отрезок поднялся, вертикальный сдвинулся вправо
    const moved = moveCorner(l, 1, [340, 60]);
    expect(orthogonal(moved)).toBe(true);
    expect(moved.some((p) => p[0] === 340 && p[1] === 60)).toBe(true);
    expect(moved.at(-1)).toEqual([400, 250]);
    expect(moved[0]).toEqual([100, 100]);
  });

  it("ступенька добавляет два излома на отрезке и не портит ортогональность", () => {
    const jogged = insertJog([[100, 100], [400, 100]], 0);
    expect(jogged.length).toBe(6);
    expect(orthogonal(jogged)).toBe(true);
    expect(jogged.some((p) => p[1] === 100 + JOG)).toBe(true);
    expect(jogged[0]).toEqual([100, 100]);
    expect(jogged.at(-1)).toEqual([400, 100]);
  });

  it("слишком короткий отрезок ступеньку не получает", () => {
    expect(insertJog([[0, 0], [30, 0]], 0)).toEqual([[0, 0], [30, 0]]);
  });

  it("внутренние точки — без портов; ближайший отрезок и положение на стороне", () => {
    expect(interiorOf(z)).toEqual([[200, 100], [200, 200]]);
    expect(nearestSegment(z, [205, 150])).toMatchObject({ index: 1 });
    const box = { x: 0, y: 0, w: 100, h: 80 };
    expect(positionOnSide(box, "T", [25, 0])).toBe(0.25);
    expect(positionOnSide(box, "R", [100, 80])).toBe(0.9); // у самого угла — не дальше 90%
    expect(positionOnSide(box, "L", [0, -20])).toBe(0.1);
  });
});

describe("ручной маршрут в прокладке и экспорте", () => {
  const node = (id: string, x: number, y: number): RouteNode => ({ id, type: "task", box: { x, y, w: SIZE.task.w, h: SIZE.task.h } });
  const nodes = [node("a", 100, 100), node("b", 500, 300), node("c", 300, 450)];
  const flow = (fixed: RouteFlow["fixed"]): RouteFlow => ({ id: "ab", from: "a", to: "b", fixed });

  it("линия идёт строго через заданные точки между портами", () => {
    const pts = routeFlows(nodes, [flow({ e: "R", n: "L", points: [[320, 140], [320, 340]] })]).get("ab")!;
    expect(pts).toEqual([[200, 140], [320, 140], [320, 340], [500, 340]]);
  });

  it("стрелка помечена как ручная, а стороны берутся из заданных", () => {
    const info = routeFlowsDetailed(nodes, [flow({ e: "R", n: "L", points: [[320, 140], [320, 340]] })]).get("ab")!;
    expect(info).toMatchObject({ manual: true, from: "R", to: "L" });
    expect(info.channel).toBeUndefined();
  });

  it("стороны можно не задавать: тогда подбираются автоматически, а путь всё равно идёт через точки", () => {
    const pts = routeFlows(nodes, [flow({ points: [[320, 140], [320, 340]] })]).get("ab")!;
    expect(pts.some((p) => p[0] === 320 && p[1] === 340)).toBe(true);
    expect(pts.slice(1).every((p, i) => p[0] === pts[i][0] || p[1] === pts[i][1])).toBe(true);
  });

  it("положение концов на стороне задаётся долей: 0,25 у выхода и 0,75 у входа", () => {
    const pts = routeFlows(nodes, [flow({ e: "R", n: "L", ep: 0.25, np: 0.75 })]).get("ab")!;
    expect(pts[0][1]).toBe(100 + 0.25 * SIZE.task.h);
    expect(pts.at(-1)![1]).toBe(300 + 0.75 * SIZE.task.h);
  });

  it("остальные стрелки обходят ручную: на общей стороне они не берут заданное ею положение", () => {
    const other: RouteFlow = { id: "ac", from: "a", to: "c" };
    const routes = routeFlows(nodes, [flow({ e: "R", n: "L", ep: 0.25 }), other]);
    const [m, o] = [routes.get("ab")!, routes.get("ac")!];
    expect(m[0][1]).toBe(120);
    expect(o[0][0] === m[0][0] && o[0][1] === m[0][1]).toBe(false); // концы не совпадают
  });

  it("fixedRoute: пустой маршрут — автоматический; точки и положения переносятся", () => {
    expect(fixedRoute({})).toBeUndefined();
    expect(fixedRoute({ points: [] })).toBeUndefined();
    expect(fixedRoute({ from_side: "R", points: [[1, 2]], from_pos: 0.3, to_pos: 0.6 })).toEqual({ e: "R", n: undefined, channel: undefined, points: [[1, 2]], ep: 0.3, np: 0.6 });
  });

  it("схема принимает точки и положения, отбрасывает недопустимые", () => {
    const ok = ProcessFlow.parse({ id: "f", from: "a", to: "b", route: { from_side: "R", to_side: "L", from_pos: 0.2, to_pos: 0.8, points: [[10, 20], [30, 40]] } });
    expect(ok.route!.points).toEqual([[10, 20], [30, 40]]);
    expect(() => ProcessFlow.parse({ id: "f", from: "a", to: "b", route: { from_pos: 1.5 } })).toThrow();
    expect(() => ProcessFlow.parse({ id: "f", from: "a", to: "b", route: { points: [[1, 2, 3]] } })).toThrow();
  });

  it("экспорт BPMN повторяет нарисованное: точки излома попадают в BPMN DI и в данные диаграммы", async () => {
    const m = purchaseModel();
    m.flows[0].route = { from_side: "R", to_side: "L", points: [[1234, 567]] };
    const { xml, diagram } = await generateBpmn(m, null);
    const edge = diagram.edges.find((e) => e.flowId === m.flows[0].id)!;
    expect(edge.points.some((p) => p[0] === 1234 && p[1] === 567)).toBe(true);
    expect(xml).toContain('<di:waypoint x="1234" y="567" />');
  });
});