import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { purchaseModel, session } from "../../test/fixtures";
import { api } from "../../api/client";
import type { ProcessLogicModel } from "../../types";
import { setSheetFrame } from "../editor-core/sheet-ops";
import Studio from "./Studio";

type M = ProcessLogicModel;
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** Студия открывается на общей схеме BPMN процесса. */
function open(model: M = purchaseModel()) {
  const onSave = vi.fn(async (_: M) => true);
  render(<Studio session={session(model)} busy={false} onSave={onSave} />);
  expect(document.querySelector(".studio svg.bpe-svg")).not.toBeNull();
  return { onSave };
}
const frame = () => document.querySelector(".studio [data-frame]");
const cell = (f: string) => document.querySelector(`.studio [data-frame-field="${f}"]`);
const rename = () => document.querySelector<HTMLInputElement>("input.bpe-rename");
const button = (t: string) => screen.getByText(t, { selector: "button" });
const outer = () => {
  const r = [...document.querySelectorAll(".studio [data-frame] > rect")].find((e) => e.getAttribute("fill") === "none")!;
  return ["x", "y", "width", "height"].map((a) => Number(r.getAttribute(a)));
};

describe("BPMN: рамка листа", () => {
  it("по умолчанию рамки нет; «Рамка» в меню «Лист» включает её со штампом процесса, и это сохраняется", async () => {
    const { onSave } = open();
    expect(frame()).toBeNull();
    expect((button("Сетка") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button("Рамка"));
    expect(frame()).not.toBeNull();
    expect(document.querySelector(".studio [data-frame-grid]")).not.toBeNull();
    expect(cell("title")!.textContent).toContain(purchaseModel().process.name);
    await act(async () => fireEvent.click(screen.getByTitle("Сохранить (Ctrl+S)")));
    expect(onSave.mock.calls[0][0].bpmn_frames).toEqual({ "": { show: true } });
    expect(onSave.mock.calls[0][0].idef0_frames).toBeUndefined(); // рамки IDEF0 не трогаем
  });

  it("лист с полем вокруг диаграммы: правый край не совпадает с краем дорожек", () => {
    open(setSheetFrame(purchaseModel(), "bpmn_frames", "", { show: true }));
    const lanes = [...document.querySelectorAll(".studio [data-lane-id] rect, .studio [data-lane-resize]")].map((r) => Number(r.getAttribute("x") ?? 0) + Number(r.getAttribute("width") ?? 0));
    const [x, , w] = outer();
    expect(x + w).toBeGreaterThan(Math.max(0, ...lanes));
  });

  it("штамп правится двойным щелчком; лист растягивается за край и двигается за штамп; отмена возвращает", () => {
    open(setSheetFrame(purchaseModel(), "bpmn_frames", "", { show: true }));
    fireEvent.doubleClick(cell("title")!);
    fireEvent.change(rename()!, { target: { value: "Лист закупки" } });
    fireEvent.keyDown(rename()!, { key: "Enter" });
    expect(cell("title")!.textContent).toContain("Лист закупки");

    const svg = document.querySelector(".studio svg.bpe-svg")!;
    const drag = (el: Element, dx: number, dy: number) => {
      fireEvent.pointerDown(el, { button: 0, pointerId: 5, clientX: 100, clientY: 100 });
      fireEvent.pointerMove(svg, { pointerId: 5, clientX: 100 + dx, clientY: 100 + dy });
      fireEvent.pointerUp(svg, { pointerId: 5, clientX: 100 + dx, clientY: 100 + dy });
    };
    const [x0, y0, w0, h0] = outer();
    drag(document.querySelector('.studio [data-frame-resize="e"]')!, 200, 0);
    expect(outer()).toEqual([x0, y0, w0 + 200, h0]);
    drag(document.querySelector(".studio [data-frame-move]")!, 60, 40);
    expect(outer()).toEqual([x0 + 60, y0 + 40, w0 + 200, h0]);
    fireEvent.click(screen.getByTitle(/Отменить/));
    expect(outer()).toEqual([x0, y0, w0 + 200, h0]);
    fireEvent.click(button("Авторазмер"));
    expect(outer()).toEqual([x0, y0, w0, h0]);
  });

  it("уменьшенный лист: фигуры вне листа отмечаются", () => {
    open(setSheetFrame(purchaseModel(), "bpmn_frames", "", { show: true }));
    const svg = document.querySelector(".studio svg.bpe-svg")!;
    fireEvent.pointerDown(document.querySelector('.studio [data-frame-resize="se"]')!, { button: 0, pointerId: 8, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(svg, { pointerId: 8, clientX: -9000, clientY: -9000 });
    fireEvent.pointerUp(svg, { pointerId: 8, clientX: -9000, clientY: -9000 });
    expect(document.querySelector(".bpe-warn")!.textContent).toMatch(/Вне листа: \d+/);
  });

  it("setSheetFrame: у BPMN по умолчанию рамки нет — show:false не хранится, show:true хранится", () => {
    const m = purchaseModel();
    expect(setSheetFrame(m, "bpmn_frames", "", { show: false })).toBe(m);
    const on = setSheetFrame(m, "bpmn_frames", "op1", { show: true });
    expect(on.bpmn_frames).toEqual({ op1: { show: true } });
    expect(setSheetFrame(on, "bpmn_frames", "op1", { show: false }).bpmn_frames).toBeUndefined();
    // у IDEF0 наоборот
    expect(setSheetFrame(m, "idef0_frames", "", { show: true })).toBe(m);
  });
});

describe("студия: печать листа BPMN", () => {
  it("«Печать…» открывает страницу печати включённого листа: бумага и ориентация по выбору", () => {
    open(setSheetFrame(purchaseModel(), "bpmn_frames", "", { show: true }));
    const blobs: Blob[] = [];
    URL.createObjectURL = vi.fn((b: Blob) => (blobs.push(b), "blob:print"));
    const win = vi.spyOn(window, "open").mockReturnValue({} as Window);
    fireEvent.change(screen.getByLabelText("Бумага для печати"), { target: { value: "A3" } });
    fireEvent.click(button("Печать…"));
    expect(win).toHaveBeenCalledWith("blob:print", "_blank");
    expect(blobs[0].type).toBe("text/html");
  });

  it("«Лист в PDF» отправляет рисунок листа на сервер и скачивает PDF; ошибка сервера видна в ленте", async () => {
    open(setSheetFrame(purchaseModel(), "bpmn_frames", "", { show: true }));
    URL.createObjectURL = vi.fn(() => "blob:pdf");
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {}); // скачивание: переход по ссылке в jsdom не нужен
    const pdf = vi.spyOn(api, "sheetPdf").mockResolvedValue(new Blob(["%PDF"], { type: "application/pdf" }));
    await act(async () => fireEvent.click(button("Лист в PDF")));
    const body = pdf.mock.calls[0][1];
    expect(body.paper).toBe("A4");
    expect(body.svg).toMatch(/^<svg/);
    expect(body.svg).toContain("data-frame"); // рамка листа в рисунке
    expect(body.title).toContain(purchaseModel().process.name);

    pdf.mockRejectedValue(new Error("PDF-рендеринг недоступен"));
    await act(async () => fireEvent.click(button("Лист в PDF")));
    expect(screen.getByText(/PDF-рендеринг недоступен/)).toBeTruthy();
  });
});
