import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { purchaseModel } from "../../test/fixtures";
import { renderWithModel } from "../../test/harness";
import { validateModel } from "@shared/validate";
import DictionaryView from "./DictionaryView";
import Navigator from "./Navigator";
import PassportView from "./PassportView";
import ProblemsPanel from "./ProblemsPanel";
import RaciMatrix from "./RaciMatrix";

describe("справочник (таблица)", () => {
  const view = (onSelect = vi.fn(), onGoto = vi.fn()) =>
    renderWithModel(purchaseModel(), (m, onChange) => <DictionaryView kind="data" model={m} selectedId="d2" onSelect={onSelect} onChange={onChange} onGoto={onGoto} />);

  it("строки, выбранная запись, описание", () => {
    const m = purchaseModel();
    m.data[0].description = "Форма З-1";
    render(<DictionaryView kind="data" model={m} selectedId="d2" onSelect={() => {}} onChange={() => {}} onGoto={() => {}} />);
    const rows = document.querySelectorAll(".dict-table tbody tr");
    expect(rows).toHaveLength(4);
    expect(rows[1].className).toMatch(/dict-selected/);
    expect((rows[0].querySelector(".dict-desc input") as HTMLInputElement).value).toBe("Форма З-1");
  });

  it("добавление по Enter, щелчок по строке выбирает запись", () => {
    const onSelect = vi.fn();
    const r = view(onSelect);
    const input = screen.getByPlaceholderText(/Новая запись/);
    fireEvent.change(input, { target: { value: "акт приёмки" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(r.model().data.at(-1)!.name).toBe("акт приёмки");
    fireEvent.click(document.querySelectorAll(".dict-table tbody tr")[2]);
    expect(onSelect).toHaveBeenCalledWith("d3");
  });

  it("поиск и раскрытие «где используется» с переходом", () => {
    const onGoto = vi.fn();
    view(vi.fn(), onGoto);
    fireEvent.change(screen.getByPlaceholderText("Поиск…"), { target: { value: "реш" } });
    const rows = document.querySelectorAll(".dict-table tbody tr");
    expect(rows).toHaveLength(1);
    fireEvent.click(within(rows[0] as HTMLElement).getByText(/3/));
    fireEvent.click(screen.getByText("оплатить счёт"));
    expect(onGoto).toHaveBeenCalledWith("c");
  });

  it("переименование в ячейке", () => {
    const r = view();
    const cell = screen.getByDisplayValue("счёт");
    fireEvent.change(cell, { target: { value: "счёт поставщика" } });
    fireEvent.blur(cell);
    expect(r.model().data[1].name).toBe("счёт поставщика");
  });
});

describe("матрица RACI", () => {
  it("переключение отметки и заполнение по исполнителям", () => {
    const r = renderWithModel(purchaseModel(), (m, onChange) => <RaciMatrix model={m} dirty={false} sessionId="s1" onChange={onChange} />);
    expect(screen.getByText(/Нарушены правила у 4 функц/)).toBeTruthy();
    fireEvent.click(screen.getByText("Заполнить по исполнителям"));
    const raci = r.model().raci;
    expect(raci.filter((x) => x.type === "A")).toHaveLength(3); // a, b, c — у вложенных исполнителя нет
    const first = document.querySelector(".raci-table tbody tr")!;
    fireEvent.click(within(first as HTMLElement).getAllByText("C")[1]);
    expect(r.model().raci).toContainEqual({ node_id: "a", role_id: "r2", type: "C" });
  });

  it("экспорт недоступен при несохранённых правках", () => {
    render(<RaciMatrix model={purchaseModel()} dirty sessionId="s1" onChange={() => {}} />);
    expect((screen.getByText("Экспорт .xlsx") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("паспорт процесса", () => {
  it("внешние входы и выходы считаются по функциям верхнего уровня", () => {
    render(<PassportView model={purchaseModel()} onChange={() => {}} />);
    const col = (t: string) => screen.getByText(t).closest("section")!.textContent;
    expect(col("Входы процесса")).toMatch(/счёт/);
    expect(col("Входы процесса")).not.toMatch(/заявка/);
    expect(col("Выходы процесса")).toMatch(/оплата/);
    expect(document.querySelectorAll(".passport-table tbody tr")).toHaveLength(5);
  });

  it("атрибуты правятся на месте", () => {
    const r = renderWithModel(purchaseModel(), (m, onChange) => <PassportView model={m} onChange={onChange} />);
    fireEvent.change(document.querySelector(".passport-field:nth-child(2) input")!, { target: { value: "П-01" } });
    expect(r.model().process.code).toBe("П-01");
  });
});

describe("навигатор", () => {
  it("дерево функций с кодами, выбор и декомпозиция", () => {
    const onSelectFn = vi.fn();
    const onOpenDoc = vi.fn();
    render(<Navigator model={purchaseModel()} activeKey="bpmn" selectedId="b1" onOpenDoc={onOpenDoc} onSelectFn={onSelectFn} onAddFunction={() => {}} />);
    const rows = [...document.querySelectorAll("[data-nav-fn]")];
    expect(rows.map((r) => r.querySelector(".nav-code")!.textContent)).toEqual(["A1", "A2", "A2.1", "A2.2", "A3"]);
    expect(rows[2].className).toMatch(/selected/);
    fireEvent.click(rows[4]);
    expect(onSelectFn).toHaveBeenCalledWith("c");
    fireEvent.doubleClick(rows[1]);
    expect(onOpenDoc).toHaveBeenCalledWith(expect.objectContaining({ key: "idef0:b" }));
  });

  it("счётчики справочников и сворачивание ветки", () => {
    render(<Navigator model={purchaseModel()} activeKey="bpmn" selectedId={null} onOpenDoc={() => {}} onSelectFn={() => {}} onAddFunction={() => {}} />);
    expect(screen.getByText("Документы и данные").parentElement!.textContent).toMatch(/4$/);
    fireEvent.click(document.querySelectorAll("[data-nav-fn]")[1].querySelector(".nav-twisty")!);
    expect(document.querySelectorAll("[data-nav-fn]")).toHaveLength(3);
  });
});

describe("поиск в навигаторе", () => {
  const nav = (onOpenEntry = vi.fn(), onSelectFn = vi.fn()) => {
    render(<Navigator model={purchaseModel()} activeKey="bpmn" selectedId={null} onOpenDoc={() => {}} onSelectFn={onSelectFn} onAddFunction={() => {}} onOpenEntry={onOpenEntry} />);
    return { search: (q: string) => fireEvent.change(screen.getByLabelText("Поиск в навигаторе"), { target: { value: q } }) };
  };

  it("находит функции по названию и коду, записи справочников — по названию", () => {
    const onOpenEntry = vi.fn();
    const onSelectFn = vi.fn();
    const { search } = nav(onOpenEntry, onSelectFn);
    search("заявк");
    const hits = [...document.querySelectorAll("[data-nav-hit]")].map((h) => h.getAttribute("data-nav-hit"));
    expect(hits).toEqual(["a", "b", "data:d1"]); // две функции и документ «заявка»
    fireEvent.click(document.querySelector('[data-nav-hit="b"]')!);
    expect(onSelectFn).toHaveBeenCalledWith("b");
    fireEvent.click(document.querySelector('[data-nav-hit="data:d1"]')!);
    expect(onOpenEntry).toHaveBeenCalledWith("data", "d1");
    search("A21");
    expect([...document.querySelectorAll("[data-nav-hit]")].map((h) => h.getAttribute("data-nav-hit"))).toEqual(["b1"]);
  });

  it("ничего не найдено; Escape и пустой запрос возвращают дерево", () => {
    const { search } = nav();
    search("zzz");
    expect(screen.getByText("Ничего не найдено")).toBeTruthy();
    fireEvent.keyDown(screen.getByLabelText("Поиск в навигаторе"), { key: "Escape" });
    expect(document.querySelectorAll("[data-nav-fn]").length).toBe(5);
  });
});

describe("нижняя панель проверок", () => {
  it("замечания текущей модели, фильтр, переход; вкладка пробелов", () => {
    const m = purchaseModel();
    const issues = validateModel(m);
    const onGoto = vi.fn();
    render(<ProblemsPanel model={m} issues={issues} onGoto={onGoto} />);
    expect(document.querySelectorAll(".problem-row")).toHaveLength(issues.length);
    fireEvent.click(screen.getByText("предупреждения").querySelector("input") ?? screen.getByText(/предупреждения/));
    expect(document.querySelectorAll(".problem-row")).toHaveLength(issues.filter((i) => i.severity === "error").length);
    fireEvent.click(screen.getByText(/Пробелы интервью/));
    fireEvent.click(screen.getByText("Сколько длится оформление заявки?"));
    expect(onGoto).toHaveBeenCalledWith({ elementId: "a", notation: "BPMN" });
  });
});
