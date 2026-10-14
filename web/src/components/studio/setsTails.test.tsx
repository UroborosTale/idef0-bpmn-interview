import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { setNodeIds } from "@shared/objectSets";
import { session, structuredModel } from "../../test/fixtures";
import { navRow, navTab } from "../../test/harness";
import DictionaryView from "./DictionaryView";
import RaciMatrix from "./RaciMatrix";
import Studio from "./Studio";
import { removeEntry } from "./dict-ops";
import { addEntryToSet, createSet, dropEntryFromSets, removeEntryFromSet } from "./set-ops";

const withSet = () => {
  const { model, id } = createSet(structuredModel(), "Раздел", ["s1"]);
  return { model, id };
};

describe("наборы: записи справочников", () => {
  it("добавление, повтор, убирание; пустой список записей убирает поле", () => {
    const { model, id } = withSet();
    const a = addEntryToSet(model, id, "roles", "r1");
    expect(a.object_sets![0].entries).toEqual(["roles:r1"]);
    expect(addEntryToSet(a, id, "roles", "r1")).toBe(a);
    expect(addEntryToSet(a, "нет", "roles", "r2")).toBe(a);
    const b = addEntryToSet(a, id, "data", "d1");
    expect(removeEntryFromSet(b, id, "roles", "r1").object_sets![0].entries).toEqual(["data:d1"]);
    expect(removeEntryFromSet(a, id, "roles", "r1").object_sets![0]).not.toHaveProperty("entries");
    expect(removeEntryFromSet(a, id, "roles", "r9")).toEqual(a);
  });

  it("удаление записи справочника убирает её из наборов; без наборов модель та же", () => {
    const { model, id } = withSet();
    const a = addEntryToSet(addEntryToSet(model, id, "roles", "r1"), id, "roles", "r2");
    expect(dropEntryFromSets(a, "roles", "r1").object_sets![0].entries).toEqual(["roles:r2"]);
    expect(removeEntry(a, "roles", "r2").object_sets![0]?.entries).toEqual(["roles:r1"]);
    const plain = structuredModel();
    expect(dropEntryFromSets(plain, "roles", "r1")).toBe(plain);
  });
});

describe("справочник: набор у записи и фильтр", () => {
  const view = (extra: Partial<React.ComponentProps<typeof DictionaryView>> = {}) => {
    const { model, id } = withSet();
    const m = addEntryToSet(model, id, "roles", "r2");
    const onSetOp = vi.fn();
    const onClearFilter = vi.fn();
    const r = render(<DictionaryView kind="roles" model={m} selectedId={null} onSelect={vi.fn()} onChange={vi.fn()} onGoto={vi.fn()} sets={m.object_sets!} onSetOp={onSetOp} onClearFilter={onClearFilter} {...extra} />);
    return { ...r, onSetOp, onClearFilter, set: m.object_sets![0] };
  };
  const rowNames = () => [...document.querySelectorAll(".dict-table tbody tr")].map((tr) => (tr.querySelector("td input") as HTMLInputElement | null)?.value).filter(Boolean);

  it("выбор в списке «Набор» добавляет запись в набор или убирает, показывает текущие наборы записи", () => {
    const v = view();
    const sel = (name: string) => screen.getByLabelText(`Набор для записи «${name}»`) as HTMLSelectElement;
    expect(sel("Специалист отдела").options[0].textContent).toBe("Раздел"); // r2 уже в наборе
    expect(sel("Начальник отдела").options[0].textContent).toBe("—");
    fireEvent.change(sel("Начальник отдела"), { target: { value: v.set.id } });
    expect(v.onSetOp).toHaveBeenLastCalledWith({ kind: "add-entry", setId: v.set.id, dict: "roles", id: "r1" });
    fireEvent.change(sel("Специалист отдела"), { target: { value: v.set.id } });
    expect(v.onSetOp).toHaveBeenLastCalledWith({ kind: "remove-entry", setId: v.set.id, dict: "roles", id: "r2" });
  });

  it("без наборов или без права правки колонки «Набор» нет", () => {
    view({ sets: [] });
    expect(screen.queryByText("Набор")).toBeNull();
    document.body.innerHTML = "";
    view({ onSetOp: undefined });
    expect(screen.queryByText("Набор")).toBeNull();
  });

  it("фильтр по набору: только записи набора, пояснение, «Снять фильтр»; пустой набор — сообщение", () => {
    const m = view().set;
    document.body.innerHTML = "";
    const v = view({ filterSet: m });
    expect(rowNames()).toEqual(["Специалист отдела"]);
    expect(document.querySelector("[data-dict-filter]")!.textContent).toMatch(/Фильтр по набору «Раздел».*1 из 3/);
    fireEvent.click(screen.getByText("Снять фильтр"));
    expect(v.onClearFilter).toHaveBeenCalled();
    document.body.innerHTML = "";
    view({ filterSet: { ...m, entries: [] } });
    expect(screen.getByText("В наборе нет записей этого справочника.")).toBeTruthy();
  });
});

describe("RACI по набору", () => {
  const raci = (filter: boolean) => {
    const { model, id } = withSet();
    const onClear = vi.fn();
    render(<RaciMatrix model={model} dirty={false} sessionId="s1" onChange={vi.fn()} filterSet={filter ? { id, name: "Раздел", nodeIds: setNodeIds(model, id) } : null} onClearFilter={onClear} />);
    return { id, onClear };
  };
  const fnRows = () => [...document.querySelectorAll(".raci-table tbody tr")].map((tr) => tr.querySelector("td")!.textContent);

  it("без набора все функции, с набором — только функции набора; xlsx и «Показать все» работают по набору", () => {
    raci(false);
    expect(fnRows()).toHaveLength(5);
    expect(document.querySelector('a[href*="export/xlsx"]')!.getAttribute("href")).not.toContain("set=");
    document.body.innerHTML = "";
    const r = raci(true);
    expect(fnRows().map((t) => t!.replace(/^\S+\s/, ""))).toEqual(["Моделирование процесса", "Актуализация реестра", "Проведение интервью"]);
    expect(screen.getByText(/Матрица RACI — набор «Раздел»/)).toBeTruthy();
    expect(document.querySelector('a[href*="export/xlsx"]')!.getAttribute("href")).toContain(`set=${r.id}`);
    fireEvent.click(screen.getByText("Показать все функции"));
    expect(r.onClear).toHaveBeenCalled();
  });
});

describe("окно студии: хвосты наборов", () => {
  it("запись справочника попадает в набор из таблицы, фильтр сужает справочник и RACI, всё в общей истории", () => {
    const { model, id } = withSet();
    render(<Studio session={session(model)} busy={false} onSave={vi.fn(async () => true)} />);
    // справочник «Исполнители»: добавить запись в набор
    fireEvent.click(navRow("Исполнители"));
    fireEvent.change(screen.getByLabelText("Набор для записи «Директор»"), { target: { value: id } });
    navTab("Деятельность"); // наборы — на вкладке «Деятельность»
    expect(document.querySelector(`[data-nav-set="${id}"] .nav-count`)!.textContent).toBe("4"); // три функции подпроцесса + запись
    // фильтр по набору: справочник показывает только запись набора
    fireEvent.click(document.querySelector(`[data-nav-set="${id}"]`)!);
    const names = () => [...document.querySelectorAll(".dict-table tbody tr")].map((tr) => (tr.querySelector("td input") as HTMLInputElement | null)?.value).filter(Boolean);
    expect(names()).toEqual(["Директор"]);
    // RACI: только функции набора
    fireEvent.click(navRow("Матрица RACI"));
    expect(document.querySelectorAll(".raci-table tbody tr")).toHaveLength(3);
    fireEvent.click(screen.getByRole("tab", { name: "Выгрузка и печать" })); // выгрузки — на второй вкладке ленты
    expect(screen.getByText("BPMN набора (zip)")).toBeTruthy();
    // отмена возвращает прежнее состояние набора
    fireEvent.keyDown(document.querySelector(".studio")!, { key: "z", ctrlKey: true });
    navTab("Деятельность");
    expect(document.querySelector(`[data-nav-set="${id}"] .nav-count`)!.textContent).toBe("3");
  });
});
