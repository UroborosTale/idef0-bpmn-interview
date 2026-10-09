import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LANE_H, START_Y } from "@shared/bpmnGeometry";
import { session, structuredModel } from "../../test/fixtures";
import { purchaseModel } from "../../test/fixtures";
import type { ProcessLogicModel } from "../../types";
import Studio from "../studio/Studio";
import { boxOf, configuredWidth, contentWidth, diagramWidth, laneHeight, laneHeights, laneIndexAtY, laneTop, lanesBottom, modelExtents, withLayout } from "./geometry";
import { addRole, deleteRole, diagramMinWidth, laneMinHeight, moveNode, setDiagramWidth, setLaneHeight } from "./model-ops";

type M = ProcessLogicModel;
/** Модель с тремя дорожками (r1, r2 и «Без исполнителя») и фигурами, расставленными по центрам дорожек. */
const laid = (): M => withLayout(purchaseModel(), true);
const lanesOf = (m: M) => laneHeights(m);
const node = (m: M, id: string) => m.nodes.find((n) => n.id === id)!;
const center = (m: M, id: string) => boxOf(node(m, id)).y + boxOf(node(m, id)).h / 2;

describe("высота дорожек: геометрия", () => {
  it("без настроек все дорожки стандартные; верх каждой — сумма высот выше", () => {
    const m = laid();
    expect(lanesOf(m)).toEqual([LANE_H, LANE_H, LANE_H]);
    expect(laneTop(m, 0)).toBe(START_Y);
    expect(laneTop(m, 2)).toBe(START_Y + 2 * LANE_H);
    expect(lanesBottom(m)).toBe(START_Y + 3 * LANE_H);
  });

  it("настроенные высоты учитываются: верхи, нижняя граница, дорожка под точкой, высота мира диаграммы", () => {
    const base = laid();
    const m: M = { ...base, roles: base.roles.map((r, i) => (i === 0 ? { ...r, lane_height: 300 } : r)), process: { ...base.process, unassigned_lane_height: 200 } };
    expect(lanesOf(m)).toEqual([300, LANE_H, 200]);
    expect(laneTop(m, 1)).toBe(START_Y + 300);
    expect(laneTop(m, 2)).toBe(START_Y + 450);
    expect(lanesBottom(m)).toBe(START_Y + 650);
    expect(laneIndexAtY(m, START_Y + 299)).toBe(0);
    expect(laneIndexAtY(m, START_Y + 300)).toBe(1);
    expect(laneIndexAtY(m, START_Y + 460)).toBe(2);
    expect(laneIndexAtY(m, 5)).toBe(0); // выше первой дорожки — первая
    expect(laneIndexAtY(m, 5000)).toBe(2); // ниже последней — последняя
    expect(modelExtents(m).h).toBeGreaterThan(modelExtents(base).h);
  });
});

describe("setLaneHeight", () => {
  it("высота сохраняется в роли, кратна 10; дорожки ниже едут целиком, фигуры по центру дорожки остаются по центру", () => {
    const m = laid();
    const before = { a: center(m, "a"), b: center(m, "b"), c: center(m, "c") };
    const lane0 = laneIndexAt(m, "a");
    const grown = setLaneHeight(m, lane0, 237);
    expect(grown.roles[lane0].lane_height).toBe(240);
    expect(laneHeight(grown, lane0)).toBe(240);
    // фигура этой дорожки осталась по центру: центр сдвинулся на половину прироста
    expect(center(grown, "a")).toBeCloseTo(before.a + 45, 5);
    // фигуры дорожек ниже сдвинуты на весь прирост
    for (const id of ["b", "c"]) if (laneIndexAt(m, id) > lane0) expect(center(grown, id)).toBeCloseTo(before[id as "b" | "c"] + 90, 5);
  });

  it("фигура, поставленная не по центру, остаётся на месте", () => {
    const m = moveNode(laid(), "a", 400, START_Y + 10); // у самого верха дорожки
    const grown = setLaneHeight(m, laneIndexAt(m, "a"), 300);
    expect(boxOf(node(grown, "a")).y).toBe(START_Y + 10);
  });

  it("не ниже, чем нужно фигурам дорожки, и в допустимых пределах; стандартная высота — это отсутствие настройки", () => {
    const m = laid();
    const i = laneIndexAt(m, "a");
    const min = laneMinHeight(m, i);
    expect(min).toBeGreaterThanOrEqual(120);
    expect(laneHeight(setLaneHeight(m, i, 10), i)).toBe(Math.max(min, 120)); // не уже минимума
    expect(laneHeight(setLaneHeight(m, i, 9999), i)).toBe(600);
    const big = setLaneHeight(m, i, 300);
    const back = setLaneHeight(big, i, LANE_H);
    expect(back.roles[i].lane_height).toBeNull();
    // та же высота — модель не меняется
    expect(setLaneHeight(m, i, LANE_H)).toBe(m);
    expect(setLaneHeight(m, 99, 200)).toBe(m);
    expect(setLaneHeight(m, i, NaN)).toBe(m);
  });

  it("дорожка «Без исполнителя» хранит высоту в настройках процесса", () => {
    const m = laid();
    const last = m.roles.length;
    const grown = setLaneHeight(m, last, 220);
    expect(grown.process.unassigned_lane_height).toBe(220);
    expect(laneHeight(grown, last)).toBe(220);
    expect(setLaneHeight(grown, last, LANE_H).process.unassigned_lane_height).toBeNull();
  });

  it("новая роль и удаление роли сдвигают нижние дорожки на реальную высоту, а не на стандартную", () => {
    const base = laid();
    const m = setLaneHeight(base, 0, 300);
    const below = (mm: M) => mm.nodes.filter((n) => laneIndexAtY(mm, boxOf(n).y + boxOf(n).h / 2) === mm.roles.length).map((n) => boxOf(n).y);
    // «Без исполнителя» едет вниз на высоту новой дорожки (стандартную)
    const added = addRole(m).model;
    expect(below(added).every((y, k) => y === below(m)[k] + LANE_H)).toBe(true);
    // роль без фигур удаляется — дорожки ниже поднимаются на её высоту
    const withEmpty = addRole(m).model;
    const emptyRole = withEmpty.roles.at(-1)!;
    const widened = setLaneHeight(withEmpty, withEmpty.roles.length - 1, 260);
    const removed = deleteRole(widened, emptyRole.id).model;
    expect(below(removed)).toEqual(below(m));
  });
});

/** Дорожка, в которой стоит фигура. */
function laneIndexAt(m: M, id: string): number {
  return laneIndexAtY(m, center(m, id));
}

describe("редактор: размер дорожек", () => {
  const studio = (model: M) => {
    render(<Studio session={session(model)} busy={false} onSave={vi.fn(async () => true)} />);
    fireEvent.click(document.querySelector('[data-nav-bpmn="o1"]')!);
  };
  const svg = () => document.querySelector(".studio svg.bpe-svg")!;
  const toClient = (wx: number, wy: number): [number, number] => {
    const [, tx, ty, k] = document.querySelector('.studio svg.bpe-svg g[transform^="translate"]')!.getAttribute("transform")!.match(/translate\(([-\d.]+) ([-\d.]+)\) scale\(([-\d.]+)\)/)!.map(Number) as unknown as [number, number, number, number];
    return [wx * k + tx, wy * k + ty];
  };
  /** Высоты дорожек, как они нарисованы: большие прямоугольники фона от левого края подписи. */
  const drawnHeights = () => [...document.querySelectorAll(".studio svg.bpe-svg [data-lane-id]")].map((g) => Number(g.querySelector("rect")!.getAttribute("height")));

  it("у каждой дорожки есть ручка границы; перетаскивание меняет высоту дорожки, отпускание — один шаг истории", () => {
    studio(structuredModel());
    const handles = document.querySelectorAll("[data-lane-resize]");
    expect(handles.length).toBeGreaterThanOrEqual(2);
    const before = drawnHeights();
    const handle = document.querySelector('[data-lane-resize="0"]') as SVGRectElement;
    const [hx, hy, , hh] = ["x", "y", "width", "height"].map((a) => Number(handle.getAttribute(a)));
    const [sx, sy] = toClient(hx + 20, hy + hh / 2);
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: sx, clientY: sy });
    const [mx, my] = toClient(hx + 20, hy + hh / 2 + 60);
    fireEvent.pointerMove(svg(), { pointerId: 1, clientX: mx, clientY: my });
    // граница подсвечена, пока её тянут
    expect(document.querySelector('.studio svg.bpe-svg line[stroke-dasharray="6 4"]')).toBeTruthy();
    fireEvent.pointerUp(svg(), { pointerId: 1, clientX: mx, clientY: my });
    const after = drawnHeights();
    expect(after[0]).toBe(before[0] + 60);
    expect(after.slice(1)).toEqual(before.slice(1));
    // подсветка снята
    expect(document.querySelector('.studio svg.bpe-svg line[stroke-dasharray="6 4"]')).toBeNull();
    // шаг истории один: отмена возвращает прежнюю высоту
    fireEvent.click(screen.getByTitle(/Отменить/));
    expect(drawnHeights()).toEqual(before);
  });

  it("у выбранной дорожки есть поле «Высота дорожки»: значение применяется по Enter, «Стандартная» и «Всем дорожкам»", () => {
    studio(structuredModel());
    fireEvent.pointerDown(document.querySelector("[data-lane-id]")!, { button: 0, pointerId: 1 });
    fireEvent.pointerUp(svg(), { pointerId: 1 });
    const bar = screen.getByRole("toolbar", { name: "Размер дорожки" });
    const input = within(bar).getByLabelText("Высота дорожки, px") as HTMLInputElement;
    expect(input.value).toBe(String(LANE_H));
    expect((within(bar).getByText("Стандартная") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: "250" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(drawnHeights()[0]).toBe(250);
    expect((within(screen.getByRole("toolbar", { name: "Размер дорожки" })).getByLabelText("Высота дорожки, px") as HTMLInputElement).value).toBe("250");
    // всем дорожкам — той же высоты
    fireEvent.click(within(screen.getByRole("toolbar", { name: "Размер дорожки" })).getByText("Всем дорожкам"));
    expect(new Set(drawnHeights())).toEqual(new Set([250]));
    // «Стандартная» возвращает 150 у выбранной
    fireEvent.click(within(screen.getByRole("toolbar", { name: "Размер дорожки" })).getByText("Стандартная"));
    expect(drawnHeights()[0]).toBe(LANE_H);
  });
});

describe("ширина дорожек: операции", () => {
  it("без настройки ширина по содержимому, но не меньше 1400; настроенная — не меньше содержимого", () => {
    const m = laid();
    expect(configuredWidth(m)).toBeUndefined();
    expect(diagramWidth(m)).toBe(Math.max(contentWidth(m), 1400));
    expect(modelExtents(m).w).toBe(contentWidth(m)); // мир диаграммы без настройки — по содержимому
    const wide = setDiagramWidth(m, 3000);
    expect(configuredWidth(wide)).toBe(3000);
    expect(diagramWidth(wide)).toBe(3000);
    expect(modelExtents(wide).w).toBe(3000);
  });

  it("ширина кратна 10, ограничена сверху; уже содержимого не делается — прижимается к минимуму; null снимает настройку", () => {
    const m = laid();
    expect(configuredWidth(setDiagramWidth(m, 2337))).toBe(2340);
    expect(configuredWidth(setDiagramWidth(m, 99999))).toBe(20000);
    const min = diagramMinWidth(m);
    expect(min).toBeGreaterThanOrEqual(contentWidth(m));
    expect(configuredWidth(setDiagramWidth(m, 100))).toBe(min);
    expect(diagramWidth(setDiagramWidth(m, 100))).toBe(Math.max(min, contentWidth(m)));
    const back = setDiagramWidth(setDiagramWidth(m, 3000), null);
    expect(configuredWidth(back)).toBeUndefined();
    expect(back.diagram_widths).toBeUndefined();
    // то же значение — модель не меняется; снятие без настройки — тоже
    const wide = setDiagramWidth(m, 3000);
    expect(setDiagramWidth(wide, 3000)).toBe(wide);
    expect(setDiagramWidth(m, null)).toBe(m);
    expect(setDiagramWidth(m, NaN).diagram_widths).toBeUndefined();
  });

  it("ширина других диаграмм (ключи операций) при правке не теряется", () => {
    const m: M = { ...laid(), diagram_widths: { o7: 5000 } };
    const next = setDiagramWidth(m, 3000);
    expect(next.diagram_widths).toEqual({ o7: 5000, "": 3000 });
    expect(setDiagramWidth(next, null).diagram_widths).toEqual({ o7: 5000 });
  });

  it("новая фигура правее текущего края расширяет дорожки: настроенная ширина не мешает", () => {
    const m = setDiagramWidth(laid(), 1500);
    const far = moveNode(m, "a", 3000, START_Y + 40);
    expect(diagramWidth(far)).toBeGreaterThan(3000);
  });
});

describe("редактор: ширина дорожек", () => {
  const studio = (model: M) => {
    render(<Studio session={session(model)} busy={false} onSave={vi.fn(async () => true)} />);
    fireEvent.click(document.querySelector('[data-nav-bpmn="o1"]')!);
  };
  const svg = () => document.querySelector(".studio svg.bpe-svg")!;
  const toClient = (wx: number, wy: number): [number, number] => {
    const [, tx, ty, k] = document.querySelector('.studio svg.bpe-svg g[transform^="translate"]')!.getAttribute("transform")!.match(/translate\(([-\d.]+) ([-\d.]+)\) scale\(([-\d.]+)\)/)!.map(Number) as unknown as [number, number, number, number];
    return [wx * k + tx, wy * k + ty];
  };
  /** Правый край фона дорожек, как он нарисован. */
  const drawnRight = () => {
    const r = document.querySelector(".studio svg.bpe-svg [data-lane-id]")!.previousElementSibling as SVGRectElement;
    return Number(r.getAttribute("x")) + Number(r.getAttribute("width"));
  };

  it("правый край дорожек тянется: ширина растёт на сдвиг (кратно 10), подсветка видна пока тянут, один шаг истории", () => {
    studio(structuredModel());
    const before = drawnRight();
    const handle = document.querySelector("[data-lane-stretch]") as SVGRectElement;
    const [hx, hy, , hh] = ["x", "y", "width", "height"].map((a) => Number(handle.getAttribute(a)));
    const [sx, sy] = toClient(hx + 4, hy + hh / 2);
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: sx, clientY: sy });
    const [mx, my] = toClient(hx + 4 + 400, hy + hh / 2);
    fireEvent.pointerMove(svg(), { pointerId: 1, clientX: mx, clientY: my });
    expect(document.querySelector('.studio svg.bpe-svg line[stroke-dasharray="6 4"]')).toBeTruthy();
    fireEvent.pointerUp(svg(), { pointerId: 1, clientX: mx, clientY: my });
    expect(drawnRight()).toBe(before + 400);
    expect(document.querySelector('.studio svg.bpe-svg line[stroke-dasharray="6 4"]')).toBeNull();
    fireEvent.click(screen.getByTitle(/Отменить/));
    expect(drawnRight()).toBe(before);
  });

  it("уже содержимого дорожки не сжимаются: край упирается в самую правую фигуру", () => {
    studio(structuredModel());
    const handle = document.querySelector("[data-lane-stretch]") as SVGRectElement;
    const [hx, hy, , hh] = ["x", "y", "width", "height"].map((a) => Number(handle.getAttribute(a)));
    const [sx, sy] = toClient(hx + 4, hy + hh / 2);
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: sx, clientY: sy });
    const [mx, my] = toClient(hx + 4 - 5000, hy + hh / 2);
    fireEvent.pointerMove(svg(), { pointerId: 1, clientX: mx, clientY: my });
    fireEvent.pointerUp(svg(), { pointerId: 1, clientX: mx, clientY: my });
    // край уперся в самую правую задачу (с отступом), а не ушёл левее неё
    const rightmost = Math.max(...[...document.querySelectorAll(".studio [data-node-id] rect")].map((r) => Number(r.getAttribute("x")) + Number(r.getAttribute("width"))));
    expect(rightmost).toBeGreaterThan(0);
    expect(drawnRight()).toBeGreaterThanOrEqual(rightmost + 100);
  });

  it("у выбранной дорожки есть поле «Ширина дорожек»: значение применяется по Enter, «По содержимому» снимает настройку", () => {
    studio(structuredModel());
    fireEvent.pointerDown(document.querySelector("[data-lane-id]")!, { button: 0, pointerId: 1 });
    fireEvent.pointerUp(svg(), { pointerId: 1 });
    const bar = () => screen.getByRole("toolbar", { name: "Размер дорожки" });
    expect((within(bar()).getByText("По содержимому") as HTMLButtonElement).disabled).toBe(true);
    const input = within(bar()).getByLabelText("Ширина дорожек, px") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "3200" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(drawnRight()).toBe(3200);
    expect((within(bar()).getByText("По содержимому") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(within(bar()).getByText("По содержимому"));
    expect(drawnRight()).not.toBe(3200);
  });
});