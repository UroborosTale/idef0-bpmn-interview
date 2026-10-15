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

  it("сетка заполняет весь лист после растягивания вверх, влево и вправо: линии идут от края до края", () => {
    open();
    const svg = document.querySelector(".studio svg.bpe-svg")!;
    const drag = (id: string, dx: number, dy: number) => {
      fireEvent.pointerDown(document.querySelector(`.studio [data-frame-resize="${id}"]`)!, { button: 0, pointerId: 7, clientX: 100, clientY: 100 });
      fireEvent.pointerMove(svg, { pointerId: 7, clientX: 100 + dx, clientY: 100 + dy });
      fireEvent.pointerUp(svg, { pointerId: 7, clientX: 100 + dx, clientY: 100 + dy });
    };
    drag("n", 0, -120);
    drag("w", -140, 0);
    drag("e", 220, 0);
    const outer = [...document.querySelectorAll(".studio [data-frame] > rect")].find((r) => r.getAttribute("fill") === "none")!;
    const [x, y, w, h] = ["x", "y", "width", "height"].map((a) => Number(outer.getAttribute(a)));
    const lines = [...document.querySelectorAll(".studio [data-frame-grid] line")];
    const vertical = lines.filter((l) => l.getAttribute("x1") === l.getAttribute("x2"));
    const horizontal = lines.filter((l) => l.getAttribute("y1") === l.getAttribute("y2"));
    expect(vertical.length).toBeGreaterThan(0);
    expect(horizontal.length).toBeGreaterThan(0);
    for (const l of vertical) {
      expect(Number(l.getAttribute("y1"))).toBe(y); // от верхнего края листа
      expect(Number(l.getAttribute("y2"))).toBe(y + h - 23); // до штампа
    }
    for (const l of horizontal) {
      expect(Number(l.getAttribute("x1"))).toBe(x); // от левого края листа
      expect(Number(l.getAttribute("x2"))).toBe(x + w); // до правого
    }
  });

  it("формат листа: A4 задаёт размер, поворот меняет ориентацию, «Лист: авто» возвращает; блоки вне листа отмечаются", () => {
    open();
    const outer = () => {
      const r = [...document.querySelectorAll(".studio [data-frame] > rect")].find((e) => e.getAttribute("fill") === "none")!;
      return [Number(r.getAttribute("width")), Number(r.getAttribute("height"))];
    };
    const select = screen.getByLabelText("Формат листа") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "A4" } });
    expect(outer()).toEqual([1120, 760 + 23]); // поле 760 + штамп 23
    expect((screen.getByLabelText("Формат листа") as HTMLSelectElement).value).toBe("A4");
    fireEvent.click(screen.getByTitle("Повернуть лист: альбомная ↔ книжная"));
    expect(outer()).toEqual([760, 1120 + 23]);
    fireEvent.change(screen.getByLabelText("Формат листа"), { target: { value: "A3" } });
    expect(outer()).toEqual([1080, 1580 + 23]); // книжная ориентация сохраняется при смене формата
    fireEvent.change(screen.getByLabelText("Формат листа"), { target: { value: "auto" } });
    expect(document.querySelector(".bpe-warn")).toBeNull();

    // уменьшенный лист не вмещает функции
    const svg = document.querySelector(".studio svg.bpe-svg")!;
    fireEvent.pointerDown(document.querySelector('.studio [data-frame-resize="se"]')!, { button: 0, pointerId: 8, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(svg, { pointerId: 8, clientX: -9000, clientY: -9000 });
    fireEvent.pointerUp(svg, { pointerId: 8, clientX: -9000, clientY: -9000 });
    expect(document.querySelector(".bpe-warn")!.textContent).toMatch(/Вне листа: \d+/);
    fireEvent.click(button("Авторазмер"));
    expect(document.querySelector(".bpe-warn")).toBeNull();
  });

  it("лист не сжимается меньше минимального размера", () => {
    open();
    const svg = document.querySelector(".studio svg.bpe-svg")!;
    fireEvent.pointerDown(document.querySelector('.studio [data-frame-resize="se"]')!, { button: 0, pointerId: 6, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(svg, { pointerId: 6, clientX: -9000, clientY: -9000 });
    fireEvent.pointerUp(svg, { pointerId: 6, clientX: -9000, clientY: -9000 });
    const outer = [...document.querySelectorAll(".studio [data-frame] > rect")].find((r) => r.getAttribute("fill") === "none")!;
    expect(Number(outer.getAttribute("width"))).toBe(440); // по ширине помещается штамп
    expect(Number(outer.getAttribute("height"))).toBe(200 + 23);
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

describe("студия: кнопка импорта в ленте", () => {
  it("«Импорт…» открывает приём правок из внешних редакторов", () => {
    const onOpenImport = vi.fn();
    render(<Studio session={session(purchaseModel())} busy={false} onSave={vi.fn(async () => true)} onOpenImport={onOpenImport} />);
    fireEvent.click(screen.getByText("Импорт…"));
    expect(onOpenImport).toHaveBeenCalledTimes(1);
  });

  it("без обработчика кнопки импорта нет", () => {
    render(<Studio session={session(purchaseModel())} busy={false} onSave={vi.fn(async () => true)} />);
    expect(screen.queryByText("Импорт…")).toBeNull();
  });
});

describe("студия: печать листа IDEF0", () => {
  const links = () => ({ pdf: screen.getByText("Лист в PDF").closest("a")!, print: screen.getByText("Печать…").closest("a")! });

  it("на диаграмме IDEF0 в ленте есть PDF и страница печати; бумага добавляется в адрес, по умолчанию — по формату листа", () => {
    open();
    expect(links().pdf.getAttribute("href")).toMatch(/\/export\/idef0\/decomposition\.pdf$/);
    expect(links().print.getAttribute("href")).toMatch(/\/export\/idef0\/decomposition\.print\.html$/);
    fireEvent.change(screen.getByLabelText("Бумага для печати"), { target: { value: "A3" } });
    expect(links().pdf.getAttribute("href")).toMatch(/decomposition\.pdf\?paper=A3$/);
    expect(links().print.getAttribute("href")).toMatch(/decomposition\.print\.html\?paper=A3$/);
    fireEvent.change(screen.getByLabelText("Бумага для печати"), { target: { value: "" } });
    expect(links().pdf.getAttribute("href")).not.toContain("paper=");
  });

  it("несохранённые правки: ссылки отключены — печатается сохранённая версия", () => {
    open();
    fireEvent.click(button("Рамка")); // правка модели — черновик стал «грязным»
    expect(links().pdf.className).toContain("disabled-link");
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    links().print.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
  });

  it("на диаграмме BPMN печать своя — кнопками по рисунку с экрана, а не ссылками на сервер", () => {
    render(<Studio session={session(purchaseModel())} busy={false} onSave={vi.fn(async () => true)} />);
    expect(screen.getByText("Лист в PDF").closest("a")).toBeNull();
    expect(screen.getByText("Печать листа BPMN")).toBeTruthy();
  });
});
