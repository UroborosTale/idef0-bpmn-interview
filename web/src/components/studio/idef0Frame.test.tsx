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

  it("края листа тянутся мышью: ширина, высота и угол; размер не меньше содержимого, отмена возвращает", () => {
    open();
    const sizeOf = () => {
      const outer = [...document.querySelectorAll(".studio [data-frame] > rect")].find((r) => r.getAttribute("fill") === "none")!;
      return [Number(outer.getAttribute("width")), Number(outer.getAttribute("height"))];
    };
    const svg = document.querySelector(".studio svg.bpe-svg")!;
    const [w0, h0] = sizeOf();
    const drag = (axis: string, dx: number, dy: number) => {
      fireEvent.pointerDown(document.querySelector(`.studio [data-frame-resize="${axis}"]`)!, { button: 0, pointerId: 5, clientX: 100, clientY: 100 });
      fireEvent.pointerMove(svg, { pointerId: 5, clientX: 100 + dx, clientY: 100 + dy });
      fireEvent.pointerUp(svg, { pointerId: 5, clientX: 100 + dx, clientY: 100 + dy });
    };
    drag("w", 200, 0);
    expect(sizeOf()[0]).toBeGreaterThan(w0);
    expect(sizeOf()[1]).toBe(h0);
    drag("h", 0, 150);
    expect(sizeOf()[1]).toBeGreaterThan(h0);
    drag("wh", -5000, -5000); // не меньше содержимого: размер снова автоматический
    expect(sizeOf()).toEqual([w0, h0]);
    fireEvent.click(screen.getByTitle(/Отменить/));
    expect(sizeOf()[1]).toBeGreaterThan(h0);
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
