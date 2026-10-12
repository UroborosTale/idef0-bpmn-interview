import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { purchaseModel, session } from "../../test/fixtures";
import type { ProcessLogicModel } from "../../types";
import { setFrame } from "../idef0-editor/ops";
import Studio from "./Studio";

type M = ProcessLogicModel;
afterEach(cleanup);

function open(model: M = purchaseModel()) {
  const onSave = vi.fn(async (_: M) => true);
  render(<Studio session={session(model)} busy={false} onSave={onSave} />);
  fireEvent.click([...document.querySelectorAll(".doc-tab")].find((t) => t.firstChild?.textContent === "IDEF0 A0")!);
  return { onSave };
}
const cell = (f: string) => document.querySelector(`.studio [data-frame-field="${f}"]`);
const rename = () => document.querySelector<HTMLInputElement>("input.bpe-rename");
const button = (t: string) => screen.getByText(t, { selector: "button" });

describe("IDEF0: рамка листа и сетка", () => {
  it("по умолчанию есть рамка со штампом NODE / TITLE / NO. и клетчатая разметка", () => {
    open();
    expect(document.querySelector(".studio [data-frame]")).not.toBeNull();
    expect(document.querySelector(".studio [data-frame-grid]")!.children.length).toBeGreaterThan(20);
    expect(cell("nodeLabel")!.textContent).toContain("NODE:");
    expect(cell("node")!.textContent).toContain("A0");
    expect(cell("noLabel")!.textContent).toContain("NO.:");
  });

  it("каждая надпись штампа правится двойным щелчком; пустое значение возвращает автоматическое", async () => {
    const { onSave } = open();
    fireEvent.doubleClick(cell("title")!);
    fireEvent.change(rename()!, { target: { value: "Мой лист" } });
    fireEvent.keyDown(rename()!, { key: "Enter" });
    expect(cell("title")!.textContent).toContain("Мой лист");
    fireEvent.doubleClick(cell("nodeLabel")!);
    fireEvent.change(rename()!, { target: { value: "УЗЕЛ:" } });
    fireEvent.keyDown(rename()!, { key: "Enter" });
    expect(cell("nodeLabel")!.textContent).toContain("УЗЕЛ:");
    fireEvent.doubleClick(cell("title")!);
    fireEvent.change(rename()!, { target: { value: "" } });
    fireEvent.keyDown(rename()!, { key: "Enter" });
    expect(cell("title")!.textContent).not.toContain("Мой лист");
    await act(async () => fireEvent.click(screen.getByTitle("Сохранить (Ctrl+S)")));
    expect(onSave).toHaveBeenCalled();
    expect(onSave.mock.calls[0][0].idef0_frames?.[""]?.texts).toEqual({ nodeLabel: "УЗЕЛ:" });
  });

  it("кнопки «Сетка» и «Рамка» скрывают разметку; правки отменяются", () => {
    open();
    fireEvent.click(button("Сетка"));
    expect(document.querySelector(".studio [data-frame-grid]")).toBeNull();
    expect(document.querySelector(".studio [data-frame]")).not.toBeNull();
    fireEvent.click(button("Рамка"));
    expect(document.querySelector(".studio [data-frame]")).toBeNull();
    fireEvent.click(screen.getByTitle(/Отменить/));
    expect(document.querySelector(".studio [data-frame]")).not.toBeNull();
  });

  it("лист растягивается за любой край и угол, двигается за штамп; Авторазмер и отмена возвращают", () => {
    open();
    const rect = () => {
      const outer = [...document.querySelectorAll(".studio [data-frame] > rect")].find((r) => r.getAttribute("fill") === "none")!;
      return ["x", "y", "width", "height"].map((a) => Number(outer.getAttribute(a)));
    };
    const svg = document.querySelector(".studio svg.bpe-svg")!;
    const drag = (el: Element, dx: number, dy: number) => {
      fireEvent.pointerDown(el, { button: 0, pointerId: 5, clientX: 100, clientY: 100 });
      fireEvent.pointerMove(svg, { pointerId: 5, clientX: 100 + dx, clientY: 100 + dy });
      fireEvent.pointerUp(svg, { pointerId: 5, clientX: 100 + dx, clientY: 100 + dy });
    };
    const edge = (id: string) => document.querySelector(`.studio [data-frame-resize="${id}"]`)!;
    expect(["n", "s", "e", "w", "ne", "nw", "se", "sw"].every((id) => edge(id))).toBe(true);
    const [x0, y0, w0, h0] = rect();

    drag(edge("e"), 200, 0);
    expect(rect()[2]).toBeGreaterThan(w0);
    expect(rect()[0]).toBe(x0);

    const right = rect()[0] + rect()[2];
    drag(edge("w"), -100, 0); // за левый край: сторона уехала влево, правая осталась на месте
    const afterW = rect();
    expect(afterW[0]).toBeLessThan(x0);
    expect(afterW[0] + afterW[2]).toBe(right);

    drag(edge("n"), 0, -60);
    expect(rect()[1]).toBeLessThan(y0);
    drag(edge("se"), 0, 100);
    expect(rect()[3]).toBeGreaterThan(h0);

    const before = rect();
    drag(document.querySelector(".studio [data-frame-move]")!, 80, 60); // штамп двигает лист целиком
    const moved = rect();
    expect(moved[0]).toBeGreaterThan(before[0]);
    expect(moved[1]).toBeGreaterThan(before[1]);
    expect(moved[2]).toBe(before[2]);
    expect(moved[3]).toBe(before[3]);

    fireEvent.click(screen.getByTitle(/Отменить/)); // отмена возвращает положение
    expect(rect()).toEqual(before);
    fireEvent.click(button("Авторазмер"));
    expect(rect()).toEqual([x0, y0, w0, h0]);
  });

  it("лист не сжимается меньше минимального размера", () => {
    open();
    const svg = document.querySelector(".studio svg.bpe-svg")!;
    fireEvent.pointerDown(document.querySelector('.studio [data-frame-resize="se"]')!, { button: 0, pointerId: 6, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(svg, { pointerId: 6, clientX: -9000, clientY: -9000 });
    fireEvent.pointerUp(svg, { pointerId: 6, clientX: -9000, clientY: -9000 });
    const outer = [...document.querySelectorAll(".studio [data-frame] > rect")].find((r) => r.getAttribute("fill") === "none")!;
    expect(Number(outer.getAttribute("width"))).toBe(200);
    expect(Number(outer.getAttribute("height"))).toBe(230);
  });

  it("пунктирной линии на листе нет", () => {
    open();
    expect(document.querySelector(".studio [data-frame] [stroke-dasharray]")).toBeNull();
  });

  it("setFrame не хранит значения по умолчанию и не меняет модель без изменений", () => {
    const m = purchaseModel();
    expect(setFrame(m, "", { show: true })).toBe(m);
    const hidden = setFrame(m, "", { show: false });
    expect(hidden.idef0_frames).toEqual({ "": { show: false } });
    expect(setFrame(hidden, "", { show: true }).idef0_frames).toBeUndefined();
  });
});
