import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { session, structuredModel } from "../../test/fixtures";
import { field } from "../../test/harness";
import { NodeShape, nodeStyle } from "../bpmn-editor/shapes";
import Studio from "./Studio";
import { resetKindStyle, setKindStyle } from "./style-ops";

afterEach(() => vi.useRealTimers());

describe("оформление по видам: операции над моделью", () => {
  it("значения хранятся только отличные от стандартных; одинаковые со стандартом и неверные отбрасываются", () => {
    const m = structuredModel();
    const a = setKindStyle(m, "task", { fill: "#FFEECC", font_size: 14 });
    expect(a.shape_styles).toEqual({ task: { fill: "#ffeecc", font_size: 14 } });
    const b = setKindStyle(a, "task", { fill: "красный", line: "#aa0000" });
    expect(b.shape_styles).toEqual({ task: { fill: "#ffeecc", line: "#aa0000", font_size: 14 } }); // неверный цвет игнорируется, прежнее остаётся
    expect(setKindStyle(b, "task", { fill: "#e8eef7" }).shape_styles!.task!.fill).toBeUndefined(); // стандартная заливка — поле убирается
    expect(setKindStyle(a, "task", { font_size: 99 }).shape_styles!.task!.font_size).toBe(14); // вне границ — прежний размер остаётся
    expect(setKindStyle(a, "task", { font_size: 12 }).shape_styles!.task).toEqual({ fill: "#ffeecc" }); // стандартный размер
  });

  it("сброс убирает вид, а когда стилей не осталось — и само поле", () => {
    const m = structuredModel();
    const both = setKindStyle(setKindStyle(m, "task", { fill: "#ffeecc" }), "gateway", { fill: "#ccffee" });
    expect(Object.keys(resetKindStyle(both, "task").shape_styles!)).toEqual(["gateway"]);
    expect("shape_styles" in resetKindStyle(resetKindStyle(both, "task"), "gateway")).toBe(false);
    expect(setKindStyle(m, "task", { fill: "#e8eef7" })).not.toHaveProperty("shape_styles"); // стандарт — ничего не пишется
  });
});

describe("оформление по видам: отрисовка", () => {
  it("фигура берёт заливку, линию, цвет и размер текста вида; выделение перекрывает цвет линии", () => {
    const m = setKindStyle(structuredModel(), "task", { fill: "#ffeecc", line: "#aa0000", text: "#0000bb", font_size: 16 });
    const node = m.nodes.find((n) => n.id === "b1")!;
    const draw = (selected: boolean) => render(<svg><NodeShape node={node} box={{ x: 0, y: 0, w: 100, h: 80 }} selected={selected} hot={false} style={nodeStyle(m, node)} /></svg>).container;
    const c = draw(false);
    const rect = c.querySelector("rect[rx]")!;
    expect(rect.getAttribute("fill")).toBe("#ffeecc");
    expect(rect.getAttribute("stroke")).toBe("#aa0000");
    const text = c.querySelector("text")!;
    expect(text.getAttribute("fill")).toBe("#0000bb");
    expect(text.getAttribute("font-size")).toBe("16");
    document.body.innerHTML = "";
    expect(draw(true).querySelector("rect[rx]")!.getAttribute("stroke")).toBe("#4338ca");
  });

  it("без стилей вид прежний", () => {
    const m = structuredModel();
    const node = m.nodes.find((n) => n.id === "b1")!;
    const c = render(<svg><NodeShape node={node} box={{ x: 0, y: 0, w: 100, h: 80 }} selected={false} hot={false} style={nodeStyle(m, node)} /></svg>).container;
    expect(c.querySelector("rect[rx]")!.getAttribute("fill")).toBe("#e8eef7");
    expect(c.querySelector("rect[rx]")!.getAttribute("stroke")).toBe("#000000");
    expect(c.querySelector("text")!.getAttribute("font-size")).toBe("12");
  });

  it("вид стиля события: начальное, промежуточное и конечное оформляются раздельно", () => {
    const m = setKindStyle(structuredModel(), "event_end", { fill: "#ccddff" });
    const end = m.nodes.find((n) => n.id === "b9")!;
    const start = m.nodes.find((n) => n.id === "b0")!;
    const fillOf = (n: typeof end) => render(<svg><NodeShape node={n} box={{ x: 0, y: 0, w: 36, h: 36 }} selected={false} hot={false} style={nodeStyle(m, n)} /></svg>).container.querySelector("circle")!.getAttribute("fill");
    expect(fillOf(end)).toBe("#ccddff");
    expect(fillOf(start)).toBe("#99ff66");
  });
});

describe("окно студии: оформление вида из панели свойств", () => {
  const open = () => render(<Studio session={session(structuredModel())} busy={false} onSave={vi.fn(async () => true)} />);
  const taskFills = () => [...document.querySelectorAll('[data-node-id] rect[rx="10"]')].map((r) => r.getAttribute("fill"));

  it("цвет у выбранной задачи меняется у всех задач после паузы; Ctrl+Z возвращает; «Сбросить» убирает", () => {
    vi.useFakeTimers();
    open();
    fireEvent.click(document.querySelector('[data-nav-bpmn="o1"]')!); // диаграмма BPMN операции: четыре шага, две задачи
    fireEvent.pointerDown(document.querySelector('[data-node-id="b1"]')!, { button: 0, pointerId: 1 });
    expect(screen.getByText("Относится ко всем фигурам вида «Задачи BPMN» на всех диаграммах.")).toBeTruthy();
    expect(taskFills()).toEqual(["#e8eef7", "#e8eef7"]);
    fireEvent.change(field("Заливка"), { target: { value: "#ffeecc" } });
    expect(taskFills()).toEqual(["#e8eef7", "#e8eef7"]); // до паузы в модель не записано
    act(() => void vi.advanceTimersByTime(600));
    expect(taskFills()).toEqual(["#ffeecc", "#ffeecc"]); // обе задачи диаграммы
    expect((screen.getByText("Сбросить к стандартному") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.keyDown(document.querySelector(".studio")!, { key: "z", ctrlKey: true });
    expect(taskFills()).toEqual(["#e8eef7", "#e8eef7"]);
    fireEvent.change(field("Заливка"), { target: { value: "#ffeecc" } });
    fireEvent.blur(field("Заливка")); // потеря фокуса записывает сразу
    expect(taskFills()).toEqual(["#ffeecc", "#ffeecc"]);
    fireEvent.click(screen.getByText("Сбросить к стандартному"));
    expect(taskFills()).toEqual(["#e8eef7", "#e8eef7"]);
  });

  it("на утверждённой версии поля оформления отключены", () => {
    const s = session(structuredModel());
    render(<Studio session={{ ...s, model: { ...s.model!, process: { ...s.model!.process, status: "approved" as const } } }} busy={false} onSave={vi.fn(async () => true)} />);
    fireEvent.click(document.querySelector('[data-nav-bpmn="o1"]')!);
    fireEvent.pointerDown(document.querySelector('[data-node-id="b1"]')!, { button: 0, pointerId: 1 });
    expect(field("Заливка").closest("fieldset")!.disabled).toBe(true);
  });
});
