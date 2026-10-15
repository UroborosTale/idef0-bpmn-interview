import { act, fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { purchaseModel, structuredModel } from "../../test/fixtures";
import type { ProcessLogicModel } from "../../types";
import Navigator from "./Navigator";

type M = ProcessLogicModel;

function nav(model: M, activeKey = "bpmn") {
  const onOpenDoc = vi.fn();
  const onSelectFn = vi.fn();
  const r = render(<Navigator model={model} activeKey={activeKey} selectedId={null} onOpenDoc={onOpenDoc} onSelectFn={onSelectFn} onAddFunction={vi.fn()} />);
  return { ...r, onOpenDoc, onSelectFn };
}

/** Строки дерева процессов: номер блока, код, название, отступ и класс. */
const rows = () =>
  [...document.querySelector(".nav-section")!.querySelectorAll(".nav-row")].map((r) => ({
    num: r.querySelector(".nav-num")?.textContent ?? "",
    code: r.querySelector(".nav-code")?.textContent ?? "",
    name: r.querySelector(".nav-name")?.textContent ?? "",
    pad: parseInt((r as HTMLElement).style.paddingLeft, 10),
    cls: r.className,
  }));
const count = () => document.querySelector(".nav-section")!.querySelectorAll(".nav-row").length;

describe("навигатор: иерархия по кодам процесса (модель с кодом)", () => {
  it("группа → B002.00.00 → подпроцессы B002.01.00 → операции B002.01.01 → диаграмма BPMN операции; без номеров блоков", () => {
    const m = structuredModel();
    m.process.group = "Управление корпоративными процессами";
    nav(m);
    // как в Business Studio: у функции номер блока и код («A1.1 B002.01.01»), у шага диаграммы — только номер («A1.1.1.1»)
    expect(rows().map((r) => [r.num, r.code, r.name, r.pad])).toEqual([
      ["", "B002.00.00", "Управление корпоративными процессами", 8], // папка
      ["", "B002.00.00", "Управление процессами", 22], // процесс
      ["A1", "B002.01.00", "Моделирование процесса", 36],
      ["A1.1", "B002.01.01", "Актуализация реестра", 50],
      ["A1.1.1", "B002.01.01", "Актуализация реестра", 64], // диаграмма BPMN операции: тот же код и название
      ["A1.1.1.1", "", "Открыть реестр", 78],
      ["A1.1.1.2", "", "Внести код процесса", 78],
      ["A1.2", "B002.01.02", "Проведение интервью", 50],
      ["A1.2.1", "B002.01.02", "Проведение интервью", 64],
      ["A2", "B002.02.00", "Анализ эффективности", 36],
      ["A2.1", "B002.02.01", "Анализ соответствия", 50],
      ["A2.1.1", "B002.02.01", "Анализ соответствия", 64],
    ]);

    // ни строки A0, ни общей схемы, ни A-номеров
    expect(document.querySelector("[data-nav-a0]")).toBeNull();
    expect(document.querySelector("[data-nav-scheme]")).toBeNull();
  });

  it("порядок строк следует коду: сначала подпроцесс, затем его операции", () => {
    nav(structuredModel());
    const fnCodes = [...document.querySelectorAll("[data-nav-fn] .nav-code")].map((c) => c.textContent);
    expect(fnCodes).toEqual([...fnCodes].sort());
    expect(rows().map((r) => r.code).slice(0, 3)).toEqual(["B002.00.00", "B002.01.00", "B002.01.01"]);
  });

  it("без группы процесс стоит на верхнем уровне; значки по уровням", () => {
    nav(structuredModel());
    expect(document.querySelector("[data-nav-group]")).toBeNull();
    expect(rows()[0]).toMatchObject({ code: "B002.00.00", name: "Управление процессами", pad: 8 });
    const kinds = [...document.querySelector(".nav-section")!.querySelectorAll(".nav-icon")].map((i) => i.getAttribute("class")!.replace("nav-icon nav-icon-", ""));
    expect(kinds).toEqual(["process", "subprocess", "operation", "bpmn", "step", "step", "operation", "bpmn", "subprocess", "operation", "bpmn"]);
    const withGroup = structuredModel();
    withGroup.process.group = "Группа";
    document.body.innerHTML = "";
    nav(withGroup);
    expect(document.querySelector(".nav-icon-folder")).toBeTruthy();
  });

  it("клики: процесс — IDEF0 процесса, строка диаграммы — BPMN операции, блок — выбор, двойной щелчок — декомпозиция", () => {
    const { onOpenDoc, onSelectFn } = nav(structuredModel());
    fireEvent.click(document.querySelector("[data-nav-process]")!);
    expect(onOpenDoc).toHaveBeenLastCalledWith(expect.objectContaining({ key: "idef0:root" }));
    fireEvent.click(document.querySelector('[data-nav-bpmn="o1"]')!);
    expect(onOpenDoc).toHaveBeenLastCalledWith(expect.objectContaining({ key: "bpmn:o1" }));
    fireEvent.click(document.querySelector('[data-nav-fn="o2"]')!);
    expect(onSelectFn).toHaveBeenCalledWith("o2");
    fireEvent.doubleClick(document.querySelector('[data-nav-fn="s1"]')!);
    expect(onOpenDoc).toHaveBeenLastCalledWith(expect.objectContaining({ key: "idef0:s1" }));
  });

  it("активная вкладка подсвечивается; диаграмма без шагов выглядит приглушённо", () => {
    nav(structuredModel(), "bpmn:o1");
    expect(document.querySelector('[data-nav-bpmn="o1"]')!.className).toMatch(/active-doc/);
    expect(document.querySelector('[data-nav-bpmn="o1"]')!.className).toMatch(/\bon\b/);
    expect(document.querySelector('[data-nav-bpmn="o2"]')!.className).not.toMatch(/\bon\b/); // у B002.01.02 шагов нет
    expect(document.querySelector('[data-nav-bpmn="o2"]')!.className).not.toMatch(/active-doc/);
    document.body.innerHTML = "";
    nav(structuredModel(), "idef0:root");
    expect(document.querySelector("[data-nav-process]")!.className).toMatch(/active-doc/);
  });

  it("сворачивание: операция скрывает диаграмму, подпроцесс — операции, процесс — всё ниже, группа — процесс", () => {
    const m = structuredModel();
    m.process.group = "Группа";
    nav(m);
    expect(count()).toBe(12);
    fireEvent.click(document.querySelector('[data-nav-fn="o1"] .nav-twisty')!); // операция
    expect(document.querySelector('[data-nav-bpmn="o1"]')).toBeNull();
    expect(count()).toBe(9);
    fireEvent.click(document.querySelector('[data-nav-fn="s1"] .nav-twisty')!); // подпроцесс
    expect(document.querySelector('[data-nav-fn="o1"]')).toBeNull();
    expect(count()).toBe(6);
    fireEvent.click(document.querySelector("[data-nav-process] .nav-twisty")!); // процесс
    expect(document.querySelector('[data-nav-fn="s2"]')).toBeNull();
    expect(count()).toBe(2); // группа и процесс
    fireEvent.click(document.querySelector("[data-nav-group]")!);
    expect(document.querySelector("[data-nav-process]")).toBeNull();
    fireEvent.click(document.querySelector("[data-nav-group]")!);
    expect(document.querySelector("[data-nav-process]")).toBeTruthy();
  });

  it("пустая модель с кодом: подсказка «Функций пока нет», у процесса нет значка раскрытия", () => {
    const m = structuredModel();
    m.nodes = [];
    m.flows = [];
    nav(m);
    expect(document.body.textContent).toContain("Функций пока нет");
    expect(document.querySelector("[data-nav-process] .nav-twisty")!.textContent).toBe("");
  });
});

describe("навигатор: модель без кода процесса — номера блоков", () => {
  it("процесс → диаграмма A0 → A1 → A2.1 → диаграмма BPMN операции (A2.1.1) и общая схема", () => {
    nav(purchaseModel());
    expect(rows().map((r) => [r.num, r.code, r.name])).toEqual([
      ["", "", "Закупка"],
      ["A0", "", "Закупка"],
      ["", "A1", "оформить заявку"],
      ["", "A2", "согласовать заявку"],
      ["", "A2.1", "проверить бюджет"],
      ["", "A2.1.1", "проверить бюджет"],
      ["", "A2.2", "принять решение"],
      ["", "A2.2.1", "принять решение"],
      ["", "A3", "оплатить счёт"],
      ["", "", "Схема процесса (BPMN)"],
    ]);
  });

  it("клики: процесс — паспорт, A0 — IDEF0, схема — общий BPMN", () => {
    const { onOpenDoc } = nav(purchaseModel());
    fireEvent.click(document.querySelector("[data-nav-process]")!);
    expect(onOpenDoc).toHaveBeenLastCalledWith(expect.objectContaining({ key: "report:passport" }));
    fireEvent.click(document.querySelector("[data-nav-a0]")!);
    expect(onOpenDoc).toHaveBeenLastCalledWith(expect.objectContaining({ key: "idef0:root" }));
    fireEvent.click(document.querySelector("[data-nav-scheme]")!);
    expect(onOpenDoc).toHaveBeenLastCalledWith(expect.objectContaining({ key: "bpmn" }));
  });

  it("A0 сворачивает подпроцессы, процесс — всё ниже", () => {
    nav(purchaseModel());
    expect(count()).toBe(10);
    fireEvent.click(document.querySelector("[data-nav-a0] .nav-twisty")!);
    expect(count()).toBe(3); // процесс, A0 и общая схема — функции скрыты
    fireEvent.click(document.querySelector("[data-nav-process] .nav-twisty")!);
    expect(document.querySelector("[data-nav-a0]")).toBeNull();
    expect(document.querySelector("[data-nav-scheme]")).toBeNull();
  });
});

describe("навигатор: показать выбранное в дереве", () => {
  const props = (selectedId: string | null, reveal?: { id: string | null; n: number }, activeKey = "bpmn") => (
    <Navigator model={structuredModel()} activeKey={activeKey} selectedId={selectedId} onOpenDoc={vi.fn()} onSelectFn={vi.fn()} onAddFunction={vi.fn()} reveal={reveal} />
  );
  const twisty = (id: string) => document.querySelector(`[data-nav-fn="${id}"] .nav-twisty`)!;
  const visible = (id: string) => !!document.querySelector(`[data-nav-fn="${id}"]`);

  it("выбор операции раскрывает свёрнутый подпроцесс и прокручивает к строке", () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    const { rerender } = render(props(null));
    fireEvent.click(twisty("s1"));
    expect(visible("o1")).toBe(false);
    rerender(props("o1"));
    expect(visible("o1")).toBe(true);
    expect(scroll).toHaveBeenCalledWith({ block: "nearest" });
    expect(document.querySelector('[data-nav-fn="o1"]')!.className).toMatch(/selected/);
  });

  it("выбор щелчком в самом навигаторе не прокручивает дерево (строка не уходит из-под двойного щелчка)", () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    vi.useFakeTimers();
    const { rerender } = render(props(null));
    scroll.mockClear();
    fireEvent.mouseDown(document.querySelector('[data-nav-fn="o2"]')!);
    rerender(props("o2")); // выбор сменился после щелчка по строке
    expect(scroll).not.toHaveBeenCalled();
    // выбор с диаграммы (позже и без щелчка в навигаторе) по-прежнему показывается прокруткой
    act(() => void vi.advanceTimersByTime(500));
    rerender(props("o3"));
    expect(scroll).toHaveBeenCalledWith({ block: "nearest" });
    vi.useRealTimers();
  });

  it("шаг диаграммы операции показывает в дереве саму операцию", () => {
    const { rerender } = render(props(null));
    fireEvent.click(twisty("s1"));
    rerender(props("b1")); // «Открыть реестр» — шаг операции o1
    expect(visible("o1")).toBe(true);
  });

  it("«Найти в навигаторе»: сбрасывает поиск, раскрывает свёрнутые разделы и ветки", () => {
    const { rerender } = render(props(null));
    fireEvent.click(twisty("s2"));
    fireEvent.click(document.querySelector(".nav-section-head")!); // свернуть «Процессы»
    fireEvent.change(document.querySelector('input[type="search"]')!, { target: { value: "реестр" } });
    expect(document.querySelector(".nav-results")).not.toBeNull();
    rerender(props(null, { id: "o3", n: 1 }));
    expect(document.querySelector(".nav-results")).toBeNull();
    expect(visible("o3")).toBe(true);
  });

  it("без объекта прокручивает к строке текущей диаграммы", () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    const { rerender } = render(props(null, undefined, "idef0:root"));
    scroll.mockClear();
    rerender(props(null, { id: null, n: 1 }, "idef0:root"));
    expect(scroll).toHaveBeenCalled();
  });
});

describe("навигатор: клавиши и запоминание состояния", () => {
  const setup = (selectedId: string | null, over: Partial<React.ComponentProps<typeof Navigator>> = {}) => {
    const h = { onMoveFunction: vi.fn(), onFunctionAction: vi.fn(), onRenameFunction: vi.fn() };
    const r = render(<Navigator model={structuredModel()} activeKey="bpmn" selectedId={selectedId} onOpenDoc={vi.fn()} onSelectFn={vi.fn()} onAddFunction={vi.fn()} {...h} {...over} />);
    const row = (id: string) => document.querySelector(`[data-nav-fn="${id}"]`) as HTMLElement;
    return { ...r, ...h, row };
  };

  it("F2 переименовывает на месте: Enter сохраняет, Escape отменяет", () => {
    const s = setup("o1");
    fireEvent.keyDown(s.row("o1"), { key: "F2" });
    const input = document.querySelector(".nav-rename") as HTMLInputElement;
    expect(input.value).toBe("Актуализация реестра");
    fireEvent.change(input, { target: { value: "  Обновление реестра " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(s.onRenameFunction).toHaveBeenCalledWith("o1", "Обновление реестра");
    expect(document.querySelector(".nav-rename")).toBeNull();

    fireEvent.keyDown(s.row("o1"), { key: "F2" });
    const second = document.querySelector(".nav-rename") as HTMLInputElement;
    fireEvent.change(second, { target: { value: "Другое" } });
    fireEvent.keyDown(second, { key: "Escape" });
    expect(s.onRenameFunction).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".nav-rename")).toBeNull();
  });

  it("потеря фокуса сохраняет новое название, пустое и прежнее — нет", () => {
    const s = setup("o1");
    fireEvent.keyDown(s.row("o1"), { key: "F2" });
    fireEvent.blur(document.querySelector(".nav-rename")!);
    expect(s.onRenameFunction).not.toHaveBeenCalled();
    fireEvent.keyDown(s.row("o1"), { key: "F2" });
    const input = document.querySelector(".nav-rename") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Новое" } });
    fireEvent.blur(input);
    expect(s.onRenameFunction).toHaveBeenCalledWith("o1", "Новое");
  });

  it("Delete удаляет выбранную функцию, Ctrl+↑ и Ctrl+↓ переставляют среди равных", () => {
    const s = setup("o2");
    fireEvent.keyDown(s.row("o2"), { key: "Delete" });
    expect(s.onFunctionAction).toHaveBeenCalledWith("delete", "o2");
    fireEvent.keyDown(s.row("o2"), { key: "ArrowUp", ctrlKey: true });
    expect(s.onMoveFunction).toHaveBeenCalledWith("o2", { kind: "before", id: "o1" });
    fireEvent.keyDown(s.row("o2"), { key: "ArrowDown", ctrlKey: true }); // o2 последняя в подпроцессе — вниз некуда
    expect(s.onMoveFunction).toHaveBeenCalledTimes(1);
  });

  it("без выбранной функции, в поле ввода и без обработчика клавиши ничего не делают", () => {
    const s = setup(null);
    fireEvent.keyDown(s.row("o1"), { key: "Delete" });
    expect(s.onFunctionAction).not.toHaveBeenCalled();
    const t = setup("o1", { onFunctionAction: undefined });
    fireEvent.keyDown(t.row("o1"), { key: "Delete" });
    expect(t.onFunctionAction).not.toHaveBeenCalled();
    const search = document.querySelector('input[type="search"]')!;
    fireEvent.keyDown(search, { key: "Delete" });
    expect(t.onFunctionAction).not.toHaveBeenCalled();
  });

  it("Ctrl+F переводит фокус в строку поиска", () => {
    const s = setup("o1");
    fireEvent.keyDown(s.row("o1"), { key: "f", ctrlKey: true });
    expect(document.activeElement).toBe(document.querySelector('input[type="search"]'));
  });

  it("свёрнутые ветки и закрытые разделы запоминаются по ключу", () => {
    const a = setup(null, { storageKey: "sess-1" });
    fireEvent.click(a.row("s1").querySelector(".nav-twisty")!);
    fireEvent.click(document.querySelector(".nav-section-head")!); // закрыть «Процессы»
    a.unmount();
    const b = setup(null, { storageKey: "sess-1" });
    expect(document.querySelector('[data-nav-fn="s1"]')).toBeNull(); // раздел «Процессы» остался закрытым
    b.unmount();
    const c = setup(null, { storageKey: "sess-2" }); // другая сессия — своё состояние
    expect(c.row("s1")).not.toBeNull();
    expect(c.row("o1")).not.toBeNull();
  });
});

describe("навигатор: меню строки, как в Business Studio", () => {
  it("«Добавить рядом» добавляет функцию на тот же уровень; «Отчёты» открывают отчёт; «Свойства» открывают панель", () => {
    const onAddFunction = vi.fn();
    const onOpenDoc = vi.fn();
    const onProperties = vi.fn();
    const m = structuredModel();
    render(<Navigator model={m} activeKey="bpmn" selectedId={null} onOpenDoc={onOpenDoc} onSelectFn={vi.fn()} onAddFunction={onAddFunction} onProperties={onProperties} />);
    const fnRow = document.querySelector('[data-nav-fn="o1"]')!;
    fireEvent.contextMenu(fnRow, { clientX: 10, clientY: 10 });
    const item = (label: string) => [...document.querySelectorAll(".nav-menu-item")].find((b) => b.textContent!.startsWith(label)) as HTMLButtonElement;
    fireEvent.click(item("Добавить рядом"));
    expect(onAddFunction).toHaveBeenCalledWith(m.nodes.find((n) => n.id === "o1")!.idef0_parent ?? null);
    fireEvent.contextMenu(fnRow, { clientX: 10, clientY: 10 });
    fireEvent.click(item("Регламент процесса"));
    expect(onOpenDoc).toHaveBeenCalledWith(expect.objectContaining({ key: "report:regulation" }));
    fireEvent.contextMenu(fnRow, { clientX: 10, clientY: 10 });
    fireEvent.click(item("Свойства"));
    expect(onProperties).toHaveBeenCalledWith("o1");
  });
});

