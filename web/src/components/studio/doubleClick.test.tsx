import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { purchaseModel, session, structuredModel } from "../../test/fixtures";
import type { ProcessLogicModel } from "../../types";
import Studio from "./Studio";

type M = ProcessLogicModel;
afterEach(cleanup);

function studio(model: M, open: () => void) {
  const onSave = vi.fn(async (_: M) => true);
  render(<Studio session={session(model)} busy={false} onSave={onSave} />);
  open();
  const save = () => act(async () => fireEvent.click(screen.getByTitle("Сохранить (Ctrl+S)")));
  return { onSave, save };
}
const openIdef0 = () => fireEvent.click([...document.querySelectorAll(".doc-tab")].find((t) => t.firstChild?.textContent === "IDEF0 A0")!);
const openBpmn = () => fireEvent.click(document.querySelector('[data-nav-bpmn="o1"]')!);
const svg = () => document.querySelector(".studio svg.bpe-svg")!;
const rename = () => document.querySelector<HTMLInputElement>("input.bpe-rename");
const blocks = () => document.querySelectorAll(".studio svg.bpe-svg [data-fn-id]").length;
/** Ввести значение в открытое поле и подтвердить Enter. */
const type = (value: string) => {
  const input = rename()!;
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: "Enter" });
};

describe("IDEF0: двойной щелчок правит текст, а создаёт функцию только с Ctrl", () => {
  it("по пустому месту без Ctrl ничего не создаётся, а подсказка говорит, как добавить функцию", () => {
    studio(purchaseModel(), openIdef0);
    const before = blocks();
    fireEvent.doubleClick(svg());
    expect(blocks()).toBe(before);
    expect(rename()).toBeNull();
    expect(document.body.textContent).toMatch(/Ctrl \+ двойной щелчок/);
  });

  it("с Ctrl по пустому месту создаётся функция и сразу открывается правка её названия", () => {
    studio(purchaseModel(), openIdef0);
    const before = blocks();
    fireEvent.doubleClick(svg(), { ctrlKey: true });
    expect(blocks()).toBe(before + 1);
    expect(rename()!.value).toBe("Новая функция");
  });

  it("по функции открывается правка её названия и сохраняется по Enter", () => {
    studio(purchaseModel(), openIdef0);
    fireEvent.doubleClick(document.querySelector('.studio [data-fn-id="b"]')!);
    expect(rename()!.value).toBe("согласовать заявку");
    type("утвердить заявку");
    expect(rename()).toBeNull();
    expect(document.querySelector('.studio [data-fn-id="b"]')!.textContent).toContain("утвердить заявку");
  });

  it("по стрелке открывается правка её названия; запись справочника переименовывается, подпись меняется у всех стрелок", () => {
    studio(purchaseModel(), openIdef0);
    const sameDoc = () => [...document.querySelectorAll('.studio [data-arrow-key] text')].map((t) => t.textContent).filter((t) => t === "заявка" || t === "заказ");
    expect(sameDoc().length).toBeGreaterThan(0);
    fireEvent.doubleClick(document.querySelector('.studio [data-arrow-key="link:b:d1"]')!);
    expect(rename()!.value).toBe("заявка");
    type("заказ");
    expect(rename()).toBeNull();
    expect(document.querySelector('.studio [data-arrow-key="link:b:d1"] text')!.textContent).toBe("заказ");
    // документ один, поэтому на других его стрелках подпись тоже новая; старой нигде не осталось
    expect([...document.querySelectorAll(".studio [data-arrow-key] text")].some((t) => t.textContent === "заявка")).toBe(false);
  });

  it("Esc отменяет правку; пустое название не сохраняется", () => {
    studio(purchaseModel(), openIdef0);
    fireEvent.doubleClick(document.querySelector('.studio [data-arrow-key="link:b:d1"]')!);
    const input = rename()!;
    fireEvent.change(input, { target: { value: "чужое" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(document.querySelector('.studio [data-arrow-key="link:b:d1"] text')!.textContent).toBe("заявка");
    fireEvent.doubleClick(document.querySelector('.studio [data-arrow-key="link:b:d1"]')!);
    type("   ");
    expect(document.querySelector('.studio [data-arrow-key="link:b:d1"] text')!.textContent).toBe("заявка");
  });

  it("с Ctrl по стрелке правка названия не открывается (это добавление излома)", () => {
    studio(purchaseModel(), openIdef0);
    const before = blocks();
    fireEvent.doubleClick(document.querySelector('.studio [data-arrow-key="link:b:d1"]')!, { ctrlKey: true });
    expect(rename()).toBeNull();
    expect(blocks()).toBe(before); // и функция по Ctrl + двойному щелчку по стрелке не создаётся
  });

  it("переименование сохраняется в модель вместе со справочником", async () => {
    const s = studio(purchaseModel(), openIdef0);
    fireEvent.doubleClick(document.querySelector('.studio [data-arrow-key="link:b:d1"]')!);
    type("заказ");
    await s.save();
    expect(s.onSave.mock.calls[0][0].data.find((d) => d.id === "d1")!.name).toBe("заказ");
  });
});

describe("BPMN: двойной щелчок по стрелке правит условие, по фигуре — название", () => {
  it("по стрелке открывается поле условия ветки; значение сохраняется, пустое стирает условие", async () => {
    const s = studio(structuredModel(), openBpmn);
    fireEvent.doubleClick(document.querySelector('.studio [data-flow-id="bf2"]')!);
    expect(rename()!.placeholder).toMatch(/Условие/);
    type("если сумма больше 100 000");
    await s.save();
    expect(s.onSave.mock.calls[0][0].flows.find((f) => f.id === "bf2")!.condition).toBe("если сумма больше 100 000");
    fireEvent.doubleClick(document.querySelector('.studio [data-flow-id="bf2"]')!);
    expect(rename()!.value).toBe("если сумма больше 100 000");
    type("");
    await s.save();
    expect(s.onSave.mock.calls[1][0].flows.find((f) => f.id === "bf2")!.condition ?? null).toBeNull();
  });

  it("двойной щелчок по ручке отрезка выбранной стрелки — то же, что по самой стрелке (ручка лежит ровно посередине линии)", () => {
    studio(structuredModel(), openBpmn);
    fireEvent.pointerDown(document.querySelector('[data-flow-id="bf2"]')!, { button: 0, pointerId: 1 });
    fireEvent.pointerUp(svg(), { pointerId: 1 });
    fireEvent.doubleClick(document.querySelector('[data-flow-handle^="seg:"]')!);
    expect(rename()).not.toBeNull();
    expect(rename()!.placeholder).toMatch(/Условие/);
  });
  it("по фигуре — правка названия, как и раньше", () => {
    studio(structuredModel(), openBpmn);
    const task = [...document.querySelectorAll(".studio [data-node-id]")].find((g) => g.querySelector("rect"))!;
    fireEvent.doubleClick(task);
    expect(rename()).not.toBeNull();
  });

  it("с Ctrl по выбранной стрелке добавляется излом, а не правка текста", () => {
    studio(structuredModel(), openBpmn);
    fireEvent.pointerDown(document.querySelector('[data-flow-id="bf2"]')!, { button: 0, pointerId: 1 });
    fireEvent.pointerUp(svg(), { pointerId: 1 });
    fireEvent.doubleClick(document.querySelector('.studio [data-flow-id="bf2"]')!, { ctrlKey: true });
    expect(rename()).toBeNull();
    expect(document.querySelectorAll('[data-flow-handle^="corner:"]').length).toBeGreaterThanOrEqual(2);
    expect(within(screen.getByRole("toolbar", { name: "Действия со стрелкой" })).getByText("Сбросить маршрут")).toBeTruthy();
  });
});
