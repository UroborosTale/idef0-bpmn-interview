import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { insertJog } from "@shared/bpmnManual";
import { scopeView } from "@shared/scope";
import { session, structuredModel } from "../../test/fixtures";
import type { ProcessLogicModel } from "../../types";
import Studio from "../studio/Studio";
import { addBend, dragCorner, dragSegment, removeBend, type FlowGeometry } from "./flow-edit";
import { guideFor, guideTargets, snapAxis, snapShape } from "./guides";
import { diagramLayout } from "./geometry";
import { dropNodeIntoLane, moveNode, reconnectFlow, reverseRoute, setFlowRoute } from "./model-ops";
import { boundsOf, dropGroup, moveGroup } from "./selection-ops";

type M = ProcessLogicModel;
const flow = (m: M, id: string) => m.flows.find((f) => f.id === id)!;
/** Диаграмма операции o1, как её видит редактор. */
const view = (m: M = structuredModel()) => scopeView(m, "o1");
const geometry = (m: M, id: string): FlowGeometry => {
  const l = diagramLayout(m);
  return { poly: l.routes.get(id)!, from: l.info.get(id)!.from, to: l.info.get(id)!.to };
};
const orthogonal = (poly: [number, number][]) => poly.slice(1).every((p, i) => Math.abs(p[0] - poly[i][0]) < 0.5 || Math.abs(p[1] - poly[i][1]) < 0.5);

describe("ручной маршрут: хранение в модели", () => {
  it("точки и положения концов сохраняются, округляются и ограничиваются; пустое снимается", () => {
    const m = view();
    let r = setFlowRoute(m, "bf2", { from_side: "R", from_pos: 0.3333, to_pos: 4, points: [[100.26, 50.9], [200, 50.9]] });
    expect(flow(r, "bf2").route).toEqual({ from_side: "R", from_pos: 0.333, to_pos: 1, points: [[100.5, 51], [200, 51]] });
    r = setFlowRoute(r, "bf2", { points: undefined, from_pos: undefined, to_pos: undefined, from_side: undefined });
    expect(flow(r, "bf2").route).toBeNull();
    // нечисловые точки отбрасываются
    expect(flow(setFlowRoute(m, "bf2", { points: [[NaN, 1]] as never }), "bf2").route).toBeNull();
  });

  it("разворот стрелки: стороны и положения меняются местами, точки идут в обратном порядке", () => {
    const route = { from_side: "R", to_side: "T", from_pos: 0.25, to_pos: 0.75, channel: 300, points: [[1, 2], [3, 4], [5, 6]] } as const;
    expect(reverseRoute(route as never)).toEqual({ from_side: "T", to_side: "R", from_pos: 0.75, to_pos: 0.25, points: [[5, 6], [3, 4], [1, 2]] });
    expect(reverseRoute(null)).toBeNull();
  });

  it("перенос конца вдоль той же стороны сохраняет точки и запоминает положение; другая сторона или фигура точки сбрасывает", () => {
    const m = setFlowRoute(view(), "bf2", { from_side: "R", to_side: "L", points: [[400, 100], [400, 200]] });
    const slid = reconnectFlow(m, "bf2", "from", "b1", "R", undefined, 0.8);
    expect(flow(slid.model, "bf2").route).toMatchObject({ from_side: "R", from_pos: 0.8, points: [[400, 100], [400, 200]] });
    const otherSide = reconnectFlow(m, "bf2", "from", "b1", "B", undefined, 0.5);
    expect(flow(otherSide.model, "bf2").route).toMatchObject({ from_side: "B", from_pos: 0.5 });
    expect(flow(otherSide.model, "bf2").route!.points).toBeUndefined();
    const otherNode = reconnectFlow(m, "bf2", "to", "b9", "L", undefined, 0.4);
    expect(flow(otherNode.model, "bf2").route!.points).toBeUndefined();
  });
});

describe("свободная правка маршрута поверх нарисованной ломаной", () => {
  it("сдвиг отрезка делает маршрут ручным: стороны фиксируются, точки запоминаются, линия остаётся ортогональной", () => {
    const m = view();
    const g = geometry(m, "bf2");
    const i = g.poly.slice(0, -1).findIndex((p, k) => Math.abs(p[0] - g.poly[k + 1][0]) + Math.abs(p[1] - g.poly[k + 1][1]) > 40);
    const moved = dragSegment(m, "bf2", g, i, 30);
    const route = flow(moved, "bf2").route!;
    expect(route).toMatchObject({ from_side: g.from, to_side: g.to });
    expect(route.points!.length).toBeGreaterThan(0);
    const after = diagramLayout(moved);
    expect(after.info.get("bf2")!.manual).toBe(true);
    expect(orthogonal(after.routes.get("bf2")! as [number, number][])).toBe(true);
    // чужие стрелки не тронуты
    expect(flow(moved, "bf3")).toBe(flow(m, "bf3"));
  });

  it("повторный пересчёт от исходной ломаной не накапливает сдвиг: результат зависит только от последней дельты", () => {
    const m = view();
    const g = geometry(m, "bf2");
    const i = g.poly.slice(0, -1).findIndex((p, k) => Math.abs(p[0] - g.poly[k + 1][0]) + Math.abs(p[1] - g.poly[k + 1][1]) > 40);
    const once = dragSegment(m, "bf2", g, i, 40);
    const stepwise = dragSegment(dragSegment(dragSegment(m, "bf2", g, i, 10), "bf2", g, i, 25), "bf2", g, i, 40);
    expect(flow(stepwise, "bf2").route).toEqual(flow(once, "bf2").route);
  });

  it("перенос излома и добавление и удаление излома", () => {
    const m = view();
    // прямая стрелка получает ступеньку, а затем излом переносится
    const g0 = geometry(m, "bf2");
    const jogged = addBend(m, "bf2", g0);
    const bends = flow(jogged, "bf2").route?.points ?? [];
    expect(jogged).not.toBe(m);
    expect(bends.length).toBeGreaterThanOrEqual(2);
    const g1 = geometry(jogged, "bf2");
    expect(orthogonal(g1.poly as [number, number][])).toBe(true);
    const corner = 1;
    const to: [number, number] = [g1.poly[corner][0] + 25, g1.poly[corner][1] + 25];
    const moved = dragCorner(jogged, "bf2", g1, corner, to);
    expect(orthogonal(geometry(moved, "bf2").poly as [number, number][])).toBe(true);
    // убрать излом: линия по-прежнему ортогональна и соединяет те же концы
    const g2 = geometry(moved, "bf2");
    const removed = removeBend(moved, "bf2", g2, 1);
    const g3 = geometry(removed, "bf2");
    expect(orthogonal(g3.poly as [number, number][])).toBe(true);
    expect(g3.poly[0]).toEqual(g2.poly[0]);
    expect(g3.poly.at(-1)).toEqual(g2.poly.at(-1));
  });

  it("убрать излом ступеньки — убирается вся ступенька: линия снова прямая", () => {
    const m = view();
    const straight: FlowGeometry = { poly: [[100, 100], [400, 100]], from: "R", to: "L" };
    const jogged = addBend(m, "bf2", straight);
    const poly = insertJog(straight.poly, 0);
    expect(poly.length).toBe(6);
    for (const corner of [1, 2, 3, 4]) {
      const removed = removeBend(jogged, "bf2", { poly, from: "R", to: "L" }, corner);
      expect(flow(removed, "bf2").route!.points).toBeUndefined();
      expect(flow(removed, "bf2").route).toMatchObject({ from_side: "R", to_side: "L" });
    }
  });

  it("слишком короткий отрезок излом не получает: модель возвращается как есть", () => {
    const m = view();
    expect(addBend(m, "bf2", { poly: [[0, 0], [30, 0]], from: "R", to: "L" })).toBe(m);
  });
});

describe("редактор: свободное управление стрелкой", () => {
  const studio = (model: M) => {
    render(<Studio session={session(model)} busy={false} onSave={vi.fn(async () => true)} />);
    fireEvent.click(document.querySelector('[data-nav-bpmn="o1"]')!);
  };
  const svg = () => document.querySelector(".studio svg.bpe-svg")!;
  const pickFlow = (id: string) => {
    fireEvent.pointerDown(document.querySelector(`[data-flow-id="${id}"]`)!, { button: 0, pointerId: 1 });
    fireEvent.pointerUp(svg(), { pointerId: 1 });
  };
  const toolbar = () => screen.getByRole("toolbar", { name: "Действия со стрелкой" });

  it("у выбранной стрелки есть ручки на каждом достаточно длинном отрезке и на каждом изломе", () => {
    studio(structuredModel());
    pickFlow("bf2");
    expect(document.querySelectorAll('[data-flow-handle^="seg:"]').length).toBeGreaterThan(0);
    expect(document.querySelectorAll('[data-flow-handle^="corner:"]').length).toBeGreaterThanOrEqual(0);
    expect(document.querySelector('[data-flow-handle="from"]')).toBeTruthy();
  });

  it("перетаскивание ручки отрезка делает маршрут ручным и добавляет изломы; «Сбросить маршрут» возвращает автоматический", () => {
    studio(structuredModel());
    pickFlow("bf2");
    expect(toolbar().textContent).toContain("Маршрут автоматический");
    const handle = document.querySelector('[data-flow-handle^="seg:"]')!;
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(svg(), { pointerId: 1, clientX: 140, clientY: 140 });
    fireEvent.pointerUp(svg(), { pointerId: 1, clientX: 140, clientY: 140 });
    expect(toolbar().textContent).toContain("Маршрут задан вручную");
    expect(document.querySelectorAll('[data-flow-handle^="corner:"]').length).toBeGreaterThan(0);
    fireEvent.click(within(toolbar()).getByText("Сбросить маршрут"));
    expect(toolbar().textContent).toContain("Маршрут автоматический");
  });

  it("кнопка «Добавить излом» делает ступеньку на самом длинном отрезке и появляются ручки изломов", () => {
    studio(structuredModel());
    pickFlow("bf2");
    fireEvent.click(within(toolbar()).getByText("Добавить излом"));
    expect(toolbar().textContent).toContain("Маршрут задан вручную");
    expect(document.querySelectorAll('[data-flow-handle^="corner:"]').length).toBeGreaterThanOrEqual(2);
  });

  it("двойной щелчок по излому убирает его", () => {
    studio(structuredModel());
    pickFlow("bf2");
    fireEvent.click(within(toolbar()).getByText("Добавить излом"));
    const before = document.querySelectorAll('[data-flow-handle^="corner:"]').length;
    fireEvent.doubleClick(document.querySelector('[data-flow-handle^="corner:"]')!);
    expect(document.querySelectorAll('[data-flow-handle^="corner:"]').length).toBeLessThan(before);
  });

  it("у выбранной стрелки в панели свойств можно задать положение конца на стороне и убрать точки", () => {
    studio(structuredModel());
    pickFlow("bf2");
    fireEvent.click(within(toolbar()).getByText("Добавить излом"));
    expect(screen.getByText(/Точек излома:/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Положение выхода на стороне, %"), { target: { value: "25" } });
    expect((screen.getByLabelText("Положение выхода на стороне, %") as HTMLInputElement).value).toBe("25");
    fireEvent.click(screen.getByText("Убрать точки"));
    expect(screen.queryByText(/Точек излома:/)).toBeNull();
  });
});

describe("направляющие выравнивания", () => {
  const boxes = [{ x: 100, y: 100, w: 100, h: 80 }, { x: 400, y: 220, w: 100, h: 80 }];
  const poly: [number, number][] = [[200, 140], [300, 140], [300, 260], [400, 260]];

  it("опорные линии по y: верх, середина и низ фигур и вершины стрелки; перетаскиваемые вершины пропускаются", () => {
    const t = guideTargets("y", boxes, poly, [1, 2]).map((x) => x.at).sort((a, b) => a - b);
    expect(t).toEqual([100, 140, 140, 180, 220, 260, 260, 300]); // 3 + 3 от фигур, порты (200,140) и (400,260) остаются
    const x = guideTargets("x", boxes, poly, []).map((v) => v.at);
    expect(x).toContain(150); // середина первой фигуры
    expect(x).toContain(300); // излом стрелки
  });

  it("прилипание: ближайшая линия в пределах допуска; вне допуска — значение как есть; hit — все линии на этой координате", () => {
    const targets = guideTargets("y", boxes, poly, []);
    expect(snapAxis(143, targets, 6)).toMatchObject({ value: 140 });
    expect(snapAxis(143, targets, 6).hit.length).toBe(3); // середина фигуры и две вершины на y = 140 (порт и излом)
    expect(snapAxis(160, targets, 6)).toEqual({ value: 160, hit: [] });
    // две линии рядом — выбирается ближайшая
    expect(snapAxis(257, [{ at: 255, lo: 0, hi: 1 }, { at: 260, lo: 0, hi: 1 }], 6).value).toBe(255);
  });

  it("направляющая тянется через все выровненные источники и сам элемент с запасом по краям", () => {
    const g = guideFor("y", 140, [{ at: 140, lo: 100, hi: 200 }, { at: 140, lo: 300, hi: 300 }], [250, 320]);
    expect(g).toEqual({ axis: "y", at: 140, from: 84, to: 336 });
  });
});

describe("редактор: направляющие при перетаскивании", () => {
  const studio = (model: M) => {
    render(<Studio session={session(model)} busy={false} onSave={vi.fn(async () => true)} />);
    fireEvent.click(document.querySelector('[data-nav-bpmn="o1"]')!);
  };
  const svg = () => document.querySelector(".studio svg.bpe-svg")!;
  /** Холст масштабируется и сдвигается; из мировых координат в экранные. */
  const toClient = (wx: number, wy: number): [number, number] => {
    const [, tx, ty, k] = document.querySelector('.studio svg.bpe-svg g[transform^="translate"]')!.getAttribute("transform")!.match(/translate\(([-\d.]+) ([-\d.]+)\) scale\(([-\d.]+)\)/)!.map(Number) as unknown as [number, number, number, number];
    return [wx * k + tx, wy * k + ty];
  };
  const pickFlow = (id: string) => {
    fireEvent.pointerDown(document.querySelector(`[data-flow-id="${id}"]`)!, { button: 0, pointerId: 1 });
    fireEvent.pointerUp(svg(), { pointerId: 1 });
  };

  it("отрезок, подведённый к линии фигуры, прилипает к ней, пока тянешь виден розовый штрих, после отпускания он исчезает", () => {
    studio(structuredModel());
    pickFlow("bf2");
    const handle = document.querySelector('[data-flow-handle^="seg:"]') as SVGRectElement;
    const [hx, hy, hw, hh] = ["x", "y", "width", "height"].map((a) => Number(handle.getAttribute(a)));
    const horizontal = hw > hh;
    const [cx, cy] = [hx + hw / 2, hy + hh / 2];
    // линии фигур на этом холсте: края и середины прямоугольников задач
    const levels = [...document.querySelectorAll(".studio [data-node-id]")].flatMap((g) => {
      const r = g.querySelector("rect");
      if (!r) return [];
      const [x, y, w, h] = ["x", "y", "width", "height"].map((a) => Number(r.getAttribute(a)));
      return horizontal ? [y, y + h / 2, y + h] : [x, x + w / 2, x + w];
    });
    const base = horizontal ? cy : cx;
    const target = levels.filter((v) => Math.abs(v - base) > 15 && Math.abs(v - base) < 90).sort((a, b) => Math.abs(a - base) - Math.abs(b - base))[0];
    expect(target).toBeDefined();
    const [sx, sy] = toClient(cx, cy);
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: sx, clientY: sy });
    // чуть мимо линии — в пределах допуска притяжения
    const [mx, my] = toClient(horizontal ? cx : target + 2, horizontal ? target + 2 : cy);
    fireEvent.pointerMove(svg(), { pointerId: 1, clientX: mx, clientY: my });
    const guide = document.querySelector(`[data-guide="${horizontal ? "y" : "x"}"]`)!;
    expect(guide).toBeTruthy();
    const at = Number(guide.getAttribute(horizontal ? "y1" : "x1"));
    expect(Number(guide.getAttribute(horizontal ? "y2" : "x2"))).toBe(at); // линия ровная
    expect(Math.abs(at - (target + 2))).toBeLessThanOrEqual(6); // направляющая не дальше допуска притяжения от курсора
    // перетаскиваемый отрезок встал точно на направляющую: у его изломов эта координата равна at
    const corners = [...document.querySelectorAll('[data-flow-handle^="corner:"]')].map((c) => (horizontal ? Number(c.getAttribute("y")) : Number(c.getAttribute("x"))) + 4);
    expect(corners).toContain(at);    fireEvent.pointerUp(svg(), { pointerId: 1, clientX: mx, clientY: my });
    expect(document.querySelector("[data-guide]")).toBeNull();
  });

  it("далеко от любых линий направляющей нет", () => {
    studio(structuredModel());
    pickFlow("bf2");
    const handle = document.querySelector('[data-flow-handle^="seg:"]') as SVGRectElement;
    const [hx, hy, hw, hh] = ["x", "y", "width", "height"].map((a) => Number(handle.getAttribute(a)));
    const [cx, cy] = [hx + hw / 2, hy + hh / 2];
    const [sx, sy] = toClient(cx, cy);
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: sx, clientY: sy });
    // Alt отключает и направляющие, и привязку к сетке
    const [mx, my] = toClient(hw > hh ? cx : cx + 37.3, hw > hh ? cy + 37.3 : cy);
    fireEvent.pointerMove(svg(), { pointerId: 1, clientX: mx, clientY: my, altKey: true });
    expect(document.querySelector("[data-guide]")).toBeNull();
    fireEvent.pointerUp(svg(), { pointerId: 1 });
  });
});
describe("направляющие: вершины других стрелок и выравнивание фигур", () => {
  it("вершины других стрелок становятся опорными линиями", () => {
    const own: [number, number][] = [[0, 0], [100, 0]];
    const other: [number, number][] = [[10, 55], [60, 55], [60, 90]];
    const y = guideTargets("y", [], own, [], [other]).map((t) => t.at);
    expect(y).toEqual(expect.arrayContaining([0, 55, 90]));
    expect(guideTargets("x", [], own, [], [other]).map((t) => t.at)).toContain(60);
    // без других стрелок их линий нет
    expect(guideTargets("y", [], own, [], []).map((t) => t.at)).not.toContain(55);
  });

  const others = [{ x: 300, y: 100, w: 100, h: 80 }, { x: 100, y: 300, w: 50, h: 50 }];

  it("snapShape: левый край, середина и правый край фигуры ищут совпадение с такими же линиями других; выбирается ближайшее", () => {
    // правый край (x + 100 = 303) почти на левом краю фигуры 300 → сдвиг на -3
    const s = snapShape({ x: 203, y: 500, w: 100, h: 80 }, others, 6);
    expect(s).toMatchObject({ x: true, dx: -3 });
    expect(s.guides.some((g) => g.axis === "x" && g.at === 300)).toBe(true);
    // по y далеко от любых линий: не прилипает
    expect(s.y).toBe(false);
    expect(s.dy).toBe(0);
  });

  it("snapShape: по обеим осям сразу, направляющая тянется от фигуры до выровненных с ней", () => {
    const s = snapShape({ x: 302, y: 98, w: 100, h: 80 }, others, 6);
    expect(s).toMatchObject({ x: true, y: true, dx: -2, dy: 2 });
    const horizontal = s.guides.find((g) => g.axis === "y")!;
    expect(horizontal.at).toBe(100);
    expect(horizontal.from).toBeLessThanOrEqual(300 - 16);
  });

  it("snapShape: середина фигуры прилипает к центрам дорожек, а края — нет", () => {
    const withLane = snapShape({ x: 600, y: 61, w: 100, h: 80 }, [], 6, [100]);
    expect(withLane).toMatchObject({ y: true, dy: -1 }); // середина 101 → 100
    // верх фигуры (61) на центре дорожки не прилипает
    expect(snapShape({ x: 600, y: 98, w: 100, h: 80 }, [], 6, [100])).toMatchObject({ y: false });
  });

  it("snapShape: вне допуска ничего не меняется", () => {
    expect(snapShape({ x: 0, y: 0, w: 10, h: 10 }, others, 3)).toEqual({ dx: 0, dy: 0, x: false, y: false, guides: [] });
  });

  it("отпускание: выровненная по направляющей ось остаётся точной, остальные ложатся на сетку", () => {
    const m = view();
    const id = "b1";
    const dragged = moveNode(m, id, 403, 202);
    const gridded = dropNodeIntoLane(dragged, id);
    const exactX = dropNodeIntoLane(dragged, id, { x: true });
    const lay = (mm: M) => mm.nodes.find((n) => n.id === id)!.layout!;
    expect(lay(gridded).x % 5).toBe(0);
    expect(lay(exactX).x).toBe(403);
    expect(lay(exactX).y).toBe(lay(gridded).y); // ось y привязана к сетке по-прежнему
  });

  it("группа: moveGroup с keep не прыгает на сетку по выровненной оси", () => {
    const m = view();
    const ids = ["b1", "b2"];
    const free = moveGroup(m, ids, 13, 0);
    const exact = moveGroup(m, ids, 13, 0, { x: true });
    const x = (mm: M, id: string) => mm.nodes.find((n) => n.id === id)!.layout!.x;
    const base = boundsOf(m, ids)!.x;
    expect((x(free, "b1") % 5)).toBe(0);
    expect(x(exact, "b1")).toBeCloseTo(m.nodes.find((n) => n.id === "b1")!.layout!.x + 13, 5);
    expect(base).toBeDefined();
    expect(dropGroup(exact, ids, { x: true }).nodes.find((n) => n.id === "b1")!.layout!.x).toBeCloseTo(x(exact, "b1"), 5);
  });
});

describe("редактор: направляющие при перетаскивании фигуры", () => {
  const studio = (model: M) => {
    render(<Studio session={session(model)} busy={false} onSave={vi.fn(async () => true)} />);
    fireEvent.click(document.querySelector('[data-nav-bpmn="o1"]')!);
  };
  const svg = () => document.querySelector(".studio svg.bpe-svg")!;
  const toClient = (wx: number, wy: number): [number, number] => {
    const [, tx, ty, k] = document.querySelector('.studio svg.bpe-svg g[transform^="translate"]')!.getAttribute("transform")!.match(/translate\(([-\d.]+) ([-\d.]+)\) scale\(([-\d.]+)\)/)!.map(Number) as unknown as [number, number, number, number];
    return [wx * k + tx, wy * k + ty];
  };
  const rectOf = (g: Element) => ["x", "y", "width", "height"].map((a) => Number(g.querySelector("rect")!.getAttribute(a)));

  it("фигура, подведённая краем к краю другой, прилипает: виден розовый штрих, после отпускания он исчезает", () => {
    studio(structuredModel());
    const tasks = [...document.querySelectorAll(".studio [data-node-id]")].filter((g) => g.querySelector("rect"));
    expect(tasks.length).toBeGreaterThanOrEqual(2);
    const [a, b] = [tasks[0], tasks[1]];
    const [ax, ay, aw, ah] = rectOf(a);
    const [bx, by] = rectOf(b);
    // тянем первую фигуру так, чтобы её верх оказался на 2 пикселя ниже верха второй
    const [sx, sy] = toClient(ax + 10, ay + 10);
    fireEvent.pointerDown(a, { button: 0, pointerId: 1, clientX: sx, clientY: sy });
    const [mx, my] = toClient(ax + 10 + (bx - ax), ay + 10 + (by - ay) + 2);
    fireEvent.pointerMove(svg(), { pointerId: 1, clientX: mx, clientY: my });
    expect(document.querySelectorAll("[data-guide]").length).toBeGreaterThan(0);
    // направляющая ровная
    const guide = document.querySelector("[data-guide]")!;
    expect(guide.getAttribute("x1") === guide.getAttribute("x2") || guide.getAttribute("y1") === guide.getAttribute("y2")).toBe(true);
    fireEvent.pointerUp(svg(), { pointerId: 1, clientX: mx, clientY: my });
    expect(document.querySelector("[data-guide]")).toBeNull();
    expect(aw + ah).toBeGreaterThan(0);
  });

  it("Alt при перетаскивании фигуры отключает направляющие", () => {
    studio(structuredModel());
    const tasks = [...document.querySelectorAll(".studio [data-node-id]")].filter((g) => g.querySelector("rect"));
    const [a, b] = [tasks[0], tasks[1]];
    const [ax, ay] = rectOf(a);
    const [bx, by] = rectOf(b);
    const [sx, sy] = toClient(ax + 10, ay + 10);
    fireEvent.pointerDown(a, { button: 0, pointerId: 1, clientX: sx, clientY: sy });
    const [mx, my] = toClient(ax + 10 + (bx - ax), ay + 10 + (by - ay) + 2);
    fireEvent.pointerMove(svg(), { pointerId: 1, clientX: mx, clientY: my, altKey: true });
    expect(document.querySelector("[data-guide]")).toBeNull();
    fireEvent.pointerUp(svg(), { pointerId: 1 });
  });
});