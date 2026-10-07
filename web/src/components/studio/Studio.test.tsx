import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { purchaseModel, session } from "../../test/fixtures";
import { commit, field } from "../../test/harness";
import type { ProcessLogicModel } from "../../types";
import Studio from "./Studio";

type M = ProcessLogicModel;

/** Окно студии целиком: одна модель на все вкладки, общая история, одно сохранение. */
function studio(onSave = vi.fn(async (_: M) => true)) {
  const r = render(<Studio session={session()} busy={false} onSave={onSave} />);
  const nav = (text: string) => fireEvent.click([...document.querySelectorAll(".nav-row")].find((n) => n.textContent?.trim().startsWith(text))!);
  const tabs = () => [...document.querySelectorAll(".doc-tab")].map((t) => t.firstChild!.textContent);
  const active = () => document.querySelector(".doc-tab.active")!.firstChild!.textContent;
  const status = () => document.querySelector(".statusbar")!.lastElementChild!.textContent;
  const title = () => document.querySelector(".props-head b")!.textContent;
  return { ...r, onSave, nav, tabs, active, status, title };
}

describe("окно студии", () => {
  it("открывается с диаграммами BPMN и IDEF0 A0, свойствами процесса и проверками", () => {
    const s = studio();
    expect(s.tabs()).toEqual(["BPMN", "IDEF0 A0"]);
    expect(s.active()).toBe("BPMN");
    expect(s.title()).toBe("Свойства процесса");
    expect(s.status()).toMatch(/сохранено/);
    expect(document.querySelector(".statusbar")!.textContent).toMatch(/функций 5 · шагов BPMN 3 · связей 3 · исполнителей 2/);
    expect(document.querySelectorAll(".problem-row").length).toBeGreaterThan(0);
  });

  it("щелчок по фигуре BPMN показывает её свойства", () => {
    const s = studio();
    fireEvent.pointerDown(document.querySelector('[data-node-id="b"]')!, { button: 0, pointerId: 1 });
    expect(s.title()).toBe("Свойства элемента");
    expect(field("Название").value).toBe("согласовать заявку");
    expect(document.querySelector('[data-nav-fn="b"]')!.className).toMatch(/selected/);
  });

  it("навигатор: функция открывает свою диаграмму декомпозиции и выделяется", () => {
    const s = studio();
    fireEvent.click(document.querySelector('[data-nav-fn="b1"]')!);
    expect(s.active()).toBe("IDEF0 A2");
    expect(s.title()).toBe("Свойства элемента");
    expect(field("Название").value).toBe("проверить бюджет");
  });

  it("справочник → карточка → правка → сохранение одной кнопкой", async () => {
    const s = studio();
    s.nav("Исполнители");
    expect(s.active()).toBe("Исполнители");
    expect(s.title()).toBe("Свойства процесса");
    fireEvent.click(document.querySelectorAll(".dict-table tbody tr")[1]);
    expect(s.title()).toBe("Карточка записи");
    commit(field("Подразделение"), "Бухгалтерия");
    expect(s.status()).toMatch(/несохранённые/);
    expect((screen.getByTitle("Сохранить (Ctrl+S)") as HTMLButtonElement).disabled).toBe(false);
    await act(async () => fireEvent.click(screen.getByTitle("Сохранить (Ctrl+S)")));
    expect(s.onSave).toHaveBeenCalledTimes(1);
    expect(s.onSave.mock.calls[0][0].roles[1].owner).toBe("Бухгалтерия");
    expect(s.status()).toMatch(/сохранено/);
  });

  it("неудачное сохранение оставляет правки несохранёнными", async () => {
    const s = studio(vi.fn(async () => false));
    s.nav("Исполнители");
    fireEvent.click(document.querySelectorAll(".dict-table tbody tr")[0]);
    commit(field("Описание"), "x");
    await act(async () => fireEvent.click(screen.getByTitle("Сохранить (Ctrl+S)")));
    expect(s.status()).toMatch(/несохранённые/);
  });

  it("отмена и повтор из ленты действуют на правки любой вкладки", () => {
    const s = studio();
    s.nav("Информационные системы");
    fireEvent.click(document.querySelectorAll(".dict-table tbody tr")[0]);
    commit(field("Название"), "1С:Бухгалтерия");
    expect(document.querySelector(".nav")!.textContent).toMatch(/Информационные системы/);
    fireEvent.click(screen.getByTitle("Отменить (Ctrl+Z)"));
    expect(field("Название").value).toBe("1С");
    expect(s.status()).toMatch(/сохранено/);
    fireEvent.click(screen.getByTitle("Повторить (Ctrl+Y)"));
    expect(field("Название").value).toBe("1С:Бухгалтерия");
  });

  it("Ctrl+Z на вкладке справочника", () => {
    const s = studio();
    s.nav("Исполнители");
    fireEvent.click(document.querySelectorAll(".dict-table tbody tr")[0]);
    commit(field("Описание"), "описание");
    fireEvent.keyDown(document.querySelector(".dict")!, { key: "z", ctrlKey: true });
    expect(field("Описание").value).toBe("");
    expect(s.status()).toMatch(/сохранено/);
  });

  it("правка на одной вкладке видна на другой (одна модель)", () => {
    const s = studio();
    fireEvent.pointerDown(document.querySelector('[data-node-id="a"]')!, { button: 0, pointerId: 1 });
    commit(field("Название"), "подготовить заявку");
    s.nav("Паспорт процесса");
    expect(document.querySelector(".passport-table")!.textContent).toMatch(/подготовить заявку/);
    s.nav("Исполнители");
    fireEvent.click(screen.getByText("▸ 2"));
    // строка раскрыта в таблице и открыта карточкой в панели — имя шага уже новое в обоих местах
    expect(document.querySelector(".dict-usage")!.textContent).toMatch(/подготовить заявку/);
    expect(document.querySelector(".props")!.textContent).toMatch(/подготовить заявку/);
  });

  it("удаление функции закрывает вкладку её декомпозиции", () => {
    const s = studio();
    fireEvent.doubleClick(document.querySelector('[data-nav-fn="b"]')!);
    expect(s.active()).toBe("IDEF0 A2");
    fireEvent.click(document.querySelector('[data-nav-fn="b"]')!);
    fireEvent.click(screen.getByText("Удалить функцию и 2 вложенных"));
    expect(s.tabs()).not.toContain("IDEF0 A2");
    expect(document.querySelector('[data-nav-fn="b1"]')).toBeNull();
  });

  it("смена вкладки сбрасывает выделение к свойствам процесса", () => {
    const s = studio();
    fireEvent.pointerDown(document.querySelector('[data-node-id="b"]')!, { button: 0, pointerId: 1 });
    fireEvent.click([...document.querySelectorAll(".doc-tab")][1]);
    expect(s.title()).toBe("Свойства процесса");
  });

  it("панели скрываются из ленты", () => {
    studio();
    fireEvent.click(screen.getByText("Свойства"));
    expect(document.querySelector(".props")).toBeNull();
    fireEvent.click(screen.getByText("Навигатор"));
    expect(document.querySelector(".nav")).toBeNull();
    expect((document.querySelector(".studio-body") as HTMLElement).style.gridTemplateColumns).toBe("minmax(0, 1fr)");
  });

  it("проверки пересчитываются по ходу правки, щелчок открывает элемент", () => {
    studio();
    const before = document.querySelectorAll(".problem-row").length;
    fireEvent.click(document.querySelector('[data-nav-fn="a"]')!);
    commit(field("Название"), "заявка"); // отглагольное название нарушает правило стиля
    expect(document.querySelectorAll(".problem-row").length).not.toBe(before);
  });

  it("несохранённые правки переживают перезагрузку (черновик)", async () => {
    vi.useFakeTimers();
    const s = studio();
    s.nav("Исполнители");
    fireEvent.click(document.querySelectorAll(".dict-table tbody tr")[0]);
    commit(field("Описание"), "из черновика");
    act(() => void vi.advanceTimersByTime(400));
    vi.useRealTimers();
    s.unmount();
    const again = studio();
    await waitFor(() => expect(document.querySelector(".bpe-banner")?.textContent).toMatch(/Восстановлены несохранённые правки/));
    expect(again.status()).toMatch(/несохранённые/);
  });

  it("модель на сервере сменилась (повторная обработка) — без правок студия её подхватывает", () => {
    const onSave = vi.fn(async () => true);
    const { rerender } = render(<Studio session={session()} busy={false} onSave={onSave} />);
    const m = purchaseModel();
    m.process.name = "Закупка (новая версия)";
    rerender(<Studio session={{ ...session(m), updatedAt: "2026-10-02T10:00:00Z" }} busy={false} onSave={onSave} />);
    expect(document.querySelector(".statusbar")!.textContent).toMatch(/Закупка \(новая версия\)/);
  });

  it("«Дублировать»: кнопка активна только при выбранной функции, копия выбирается и открывается", () => {
    const s = studio();
    const btn = () => screen.getByText("Дублировать") as HTMLButtonElement;
    expect(btn().disabled).toBe(true);
    fireEvent.pointerDown(document.querySelector('[data-node-id="a"]')!, { button: 0, pointerId: 1 });
    expect(btn().disabled).toBe(false);
    fireEvent.click(btn());
    expect(field("Название").value).toBe("оформить заявку (копия)");
    expect(s.status()).toMatch(/несохранённые/);
    fireEvent.click(screen.getByTitle("Отменить (Ctrl+Z)"));
    expect(document.querySelector('[data-node-id="n6"]')).toBeNull();
  });

  it("Ctrl+D и стрелки на диаграмме BPMN", () => {
    const s = studio();
    const canvas = document.querySelector(".bpe")!;
    fireEvent.pointerDown(document.querySelector('[data-node-id="a"]')!, { button: 0, pointerId: 1 });
    const x0 = Number(document.querySelector('[data-node-id="a"] rect')!.getAttribute("x"));
    fireEvent.keyDown(canvas, { key: "ArrowRight" });
    fireEvent.keyDown(canvas, { key: "ArrowRight", shiftKey: true });
    const x1 = Number(document.querySelector('[data-node-id="a"] rect')!.getAttribute("x"));
    expect(x1 - x0).toBe(60);
    fireEvent.keyDown(canvas, { key: "d", code: "KeyD", ctrlKey: true });
    expect(field("Название").value).toBe("оформить заявку (копия)");
    expect(s.title()).toBe("Свойства элемента");
  });

  it("«На весь экран» переключает режим окна", () => {
    studio();
    const el = document.querySelector(".studio")!;
    expect(el.className).not.toMatch(/full/);
    fireEvent.click(screen.getByText("На весь экран"));
    expect(el.className).toMatch(/full/);
    fireEvent.click(screen.getByText("Свернуть окно"));
    expect(el.className).not.toMatch(/full/);
  });

  it("экспорт «эта диаграмма»: на вкладке справочника — понятное сообщение", () => {
    studio();
    fireEvent.click([...document.querySelectorAll(".nav-row")].find((n) => n.textContent?.startsWith("Исполнители"))!);
    fireEvent.click(screen.getByText("SVG"));
    expect(screen.getByRole("alert").textContent).toMatch(/Откройте диаграмму/);
  });

  it("пустая модель: подсказка на холсте, диаграмма не падает", () => {
    const empty = purchaseModel();
    empty.nodes = [];
    empty.flows = [];
    empty.roles = [];
    render(<Studio session={session(empty)} busy={false} onSave={vi.fn(async () => true)} />);
    expect(screen.getByText("Диаграмма пуста")).toBeTruthy();
  });
});