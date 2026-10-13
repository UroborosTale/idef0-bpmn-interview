import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { session, structuredModel } from "../../test/fixtures";
import { deleteNode } from "../bpmn-editor/model-ops";
import Navigator from "./Navigator";
import Studio from "./Studio";
import { addToSet, createSet, deleteSet, removeFromSet, renameSet } from "./set-ops";

describe("операции над наборами", () => {
  it("создание: несуществующие и не функции отбрасываются, id уникальны, имя не пустое", () => {
    const m = structuredModel();
    const a = createSet(m, "  Реестры ", ["o1", "нет", "b1", "o1"]);
    expect(a.model.object_sets).toEqual([{ id: "set1", name: "Реестры", members: ["o1"] }]);
    const b = createSet(a.model, "", []);
    expect(b.model.object_sets!.map((s) => [s.id, s.name])).toEqual([["set1", "Реестры"], ["set2", "Набор"]]);
  });

  it("переименование и удаление", () => {
    const { model, id } = createSet(structuredModel(), "А", ["o1"]);
    expect(renameSet(model, id, " Б ").object_sets![0].name).toBe("Б");
    expect(renameSet(model, id, "  ")).toBe(model);
    expect(deleteSet(model, id).object_sets).toEqual([]);
  });

  it("добавление: уже входящая (сама или через вложенность) не дублируется, вложенные члены поглощаются", () => {
    const { model, id } = createSet(structuredModel(), "А", ["o1", "o2"]);
    expect(addToSet(model, id, "o1")).toBe(model);
    const wide = addToSet(model, id, "s1");
    expect(wide.object_sets![0].members).toEqual(["s1"]); // o1 и o2 теперь входят через подпроцесс
    expect(addToSet(wide, id, "o2")).toBe(wide);
    expect(addToSet(model, id, "b1")).toBe(model); // шаг диаграммы — не функция
    expect(addToSet(model, "нет", "o3")).toBe(model);
  });

  it("убрать можно только перечисленную напрямую; удаление функции чистит наборы", () => {
    const { model, id } = createSet(structuredModel(), "А", ["s1", "o3"]);
    expect(removeFromSet(model, id, "o3").object_sets![0].members).toEqual(["s1"]);
    expect(removeFromSet(model, id, "o1").object_sets![0].members).toEqual(["s1", "o3"]); // o1 входит через s1, напрямую её нет
    expect(deleteNode(model, "o3").object_sets![0].members).toEqual(["s1"]);
    expect(deleteNode(model, "s1").object_sets![0].members).toEqual(["o3"]);
    expect(deleteNode(structuredModel(), "o3").object_sets).toBeUndefined(); // без наборов поле не появляется
  });
});

describe("навигатор: фильтр по набору", () => {
  const modelWithSets = () => {
    const m = structuredModel();
    m.object_sets = [
      { id: "k1", name: "Подпроцесс 1", members: ["s1"] },
      { id: "k2", name: "Одна операция", members: ["o3"] },
      { id: "k3", name: "Пустой", members: [] },
    ];
    return m;
  };
  const nav = (activeSet: string | null, over: Partial<React.ComponentProps<typeof Navigator>> = {}) => {
    const h = { onActiveSet: vi.fn(), onSetOp: vi.fn() };
    const selectedId = (over as { selectedId?: string | null }).selectedId ?? null;
    const r = render(<Navigator model={modelWithSets()} activeKey="bpmn" selectedId={selectedId} onOpenDoc={vi.fn()} onSelectFn={vi.fn()} onAddFunction={vi.fn()} activeSet={activeSet} {...h} {...over} />);
    const fns = () => [...document.querySelectorAll("[data-nav-fn]")].map((r) => r.getAttribute("data-nav-fn"));
    return { ...r, ...h, fns };
  };

  it("без фильтра видны все функции; набор показывает членов и путь к ним", () => {
    expect(nav(null).fns()).toEqual(["s1", "o1", "o2", "s2", "o3"]);
    document.body.innerHTML = "";
    const a = nav("k1");
    expect(a.fns()).toEqual(["s1", "o1", "o2"]);
    expect(document.querySelector("[data-nav-filter]")!.textContent).toMatch(/Фильтр: Подпроцесс 1/);
    a.unmount();
    expect(nav("k2").fns()).toEqual(["s2", "o3"]); // родитель виден как путь
  });

  it("пустой набор: дерево пусто, есть пояснение, мастера структуры нет", () => {
    nav("k3");
    expect(document.querySelectorAll("[data-nav-fn]")).toHaveLength(0);
    expect(screen.getByText("В наборе нет функций")).toBeTruthy();
    expect(screen.queryByText("Мастер структуры")).toBeNull();
  });

  it("неизвестный набор в фильтре игнорируется", () => {
    expect(nav("нет").fns()).toHaveLength(5);
    expect(document.querySelector("[data-nav-filter]")).toBeNull();
  });

  it("выбранная функция вне набора: пояснение с названием; «Снять» убирает фильтр", () => {
    const a = nav("k1", { selectedId: "o3" } as never);
    expect(document.querySelector("[data-nav-filter-miss]")!.textContent).toMatch(/«Анализ соответствия» не входит в набор «Подпроцесс 1»/);
    fireEvent.click(screen.getByText("Снять"));
    expect(a.onActiveSet).toHaveBeenCalledWith(null);
  });

  it("поиск ищет только в наборе", () => {
    nav("k1");
    fireEvent.change(document.querySelector('input[type="search"]')!, { target: { value: "анализ" } });
    expect(document.querySelector(".nav-results")!.textContent).toMatch(/Ничего не найдено/);
  });

  it("раздел «Наборы»: счётчики, щелчок включает и выключает фильтр, меню набора", () => {
    const a = nav(null);
    const row = (id: string) => document.querySelector(`[data-nav-set="${id}"]`) as HTMLElement;
    expect([...document.querySelectorAll("[data-nav-set]")].map((r) => r.querySelector(".nav-count")!.textContent)).toEqual(["3", "1", "0"]);
    fireEvent.click(row("k1"));
    expect(a.onActiveSet).toHaveBeenLastCalledWith("k1");
    a.unmount();
    const b = nav("k1");
    fireEvent.click(row("k1"));
    expect(b.onActiveSet).toHaveBeenLastCalledWith(null);
    fireEvent.contextMenu(row("k2"));
    fireEvent.click(screen.getByText("Фильтровать по набору"));
    expect(b.onActiveSet).toHaveBeenLastCalledWith("k2");
    fireEvent.contextMenu(row("k2"));
    fireEvent.click(screen.getByText("Удалить набор…"));
    expect(b.onSetOp).toHaveBeenLastCalledWith({ kind: "delete", id: "k2" });
  });

  it("создание набора: «+» с выбранной функцией, Enter; Escape отменяет; переименование на месте", () => {
    const a = nav(null, { selectedId: "o1" } as never);
    fireEvent.click(screen.getByTitle("Новый набор (с выбранной функцией)"));
    const input = document.querySelector('[aria-label="Название нового набора"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: " Реестры " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(a.onSetOp).toHaveBeenLastCalledWith({ kind: "create", name: "Реестры", fnId: "o1" });

    fireEvent.click(screen.getByTitle("Новый набор (с выбранной функцией)"));
    fireEvent.keyDown(document.querySelector('[aria-label="Название нового набора"]')!, { key: "Escape" });
    expect(document.querySelector('[aria-label="Название нового набора"]')).toBeNull();
    expect(a.onSetOp).toHaveBeenCalledTimes(1);

    fireEvent.contextMenu(document.querySelector('[data-nav-set="k3"]')!);
    fireEvent.click(screen.getByText("Переименовать"));
    const rename = document.querySelector('[aria-label="Название набора"]') as HTMLInputElement;
    fireEvent.change(rename, { target: { value: "Новое имя" } });
    fireEvent.keyDown(rename, { key: "Enter" });
    expect(a.onSetOp).toHaveBeenLastCalledWith({ kind: "rename", id: "k3", name: "Новое имя" });
  });

  it("меню функции: добавить в набор, убрать из набора; вложенной в член набора «убрать» нет", () => {
    const a = nav(null);
    const fnRow = (id: string) => document.querySelector(`[data-nav-fn="${id}"]`) as HTMLElement;
    fireEvent.contextMenu(fnRow("o3"));
    expect(screen.queryByText("Убрать из набора «Одна операция»")).not.toBeNull(); // o3 перечислена напрямую
    expect(screen.queryByText("В набор «Подпроцесс 1»")).not.toBeNull();
    fireEvent.click(screen.getByText("В набор «Подпроцесс 1»"));
    expect(a.onSetOp).toHaveBeenLastCalledWith({ kind: "add", setId: "k1", fnId: "o3" });
    fireEvent.contextMenu(fnRow("o1"));
    expect(screen.queryByText("В набор «Подпроцесс 1»")).toBeNull(); // o1 уже входит через s1
    expect(screen.queryByText("Убрать из набора «Подпроцесс 1»")).toBeNull();
    expect(screen.queryByText("В набор «Пустой»")).not.toBeNull();
  });
});

describe("окно студии: наборы объектов", () => {
  const open = (extra: (m: ReturnType<typeof structuredModel>) => void = () => {}) => {
    const m = structuredModel();
    extra(m);
    return render(<Studio session={session(m)} busy={false} onSave={vi.fn(async () => true)} />);
  };
  const fnRow = (id: string) => document.querySelector(`[data-nav-fn="${id}"]`) as HTMLElement | null;

  it("набор из выбранной функции фильтрует дерево, запоминается и снимается; Ctrl+Z отменяет создание", () => {
    open();
    fireEvent.click(fnRow("o3")!);
    fireEvent.click(screen.getByTitle("Новый набор (с выбранной функцией)"));
    const input = document.querySelector('[aria-label="Название нового набора"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Анализ" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(document.querySelector("[data-nav-set]")!.textContent).toMatch(/Анализ/);
    expect(fnRow("o1")).toBeNull(); // фильтр включился сам
    expect(fnRow("o3")).not.toBeNull();
    expect(screen.getByText("BPMN набора (zip)")).toBeTruthy();
    fireEvent.click(screen.getByText("Снять"));
    expect(fnRow("o1")).not.toBeNull();
    fireEvent.keyDown(fnRow("o1")!, { key: "z", ctrlKey: true }); // создание набора — шаг общей истории
    expect(document.querySelector("[data-nav-set]")).toBeNull();
  });

  it("фильтр запоминается между открытиями окна; удаление набора с подтверждением снимает фильтр", () => {
    const first = open((m) => {
      m.object_sets = [{ id: "k1", name: "Подпроцесс 1", members: ["s1"] }];
    });
    fireEvent.click(document.querySelector('[data-nav-set="k1"]')!);
    expect(fnRow("o3")).toBeNull();
    first.unmount();
    open((m) => {
      m.object_sets = [{ id: "k1", name: "Подпроцесс 1", members: ["s1"] }];
    });
    expect(fnRow("o3")).toBeNull(); // тот же фильтр
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.contextMenu(document.querySelector('[data-nav-set="k1"]')!);
    fireEvent.click(screen.getByText("Удалить набор…"));
    expect(confirm).toHaveBeenCalled();
    expect(document.querySelector("[data-nav-set]")).toBeNull();
    expect(fnRow("o3")).not.toBeNull(); // фильтр снят вместе с набором
  });

  it("на утверждённой версии набор можно включить как фильтр, но нельзя править", () => {
    const s = session(structuredModel());
    const model = { ...s.model!, process: { ...s.model!.process, status: "approved" as const }, object_sets: [{ id: "k1", name: "Подпроцесс 1", members: ["s1"] }] };
    render(<Studio session={{ ...s, model }} busy={false} onSave={vi.fn(async () => true)} />);
    expect(screen.queryByTitle("Новый набор (с выбранной функцией)")).toBeNull();
    fireEvent.click(document.querySelector('[data-nav-set="k1"]')!);
    expect(fnRow("o3")).toBeNull();
    fireEvent.contextMenu(document.querySelector('[data-nav-set="k1"]')!);
    expect(screen.queryByText("Удалить набор…")).toBeNull();
    expect(screen.getByText("Снять фильтр")).toBeTruthy();
  });
});
