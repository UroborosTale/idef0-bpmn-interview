import { createEvent, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { functionCodes } from "@shared/codes";
import { validateModel } from "@shared/validate";
import { structuredModel } from "../../test/fixtures";
import type { ProcessLogicModel } from "../../types";
import Navigator from "./Navigator";
import StructureWizard from "./StructureWizard";
import { addChildFunction, applyStructure, deleteImpact, moveFunction, moveProblem, outlineFromModel, parseOutline, previewMove, remapCodes, shiftFunction } from "./structure-ops";

type M = ProcessLogicModel;
const codeOf = (m: M, id: string) => functionCodes(m).get(id);

describe("список структуры из модели (предзаполнение мастера)", () => {
  it("подпроцессы без отступа, операции с отступом; шаги диаграмм операций не попадают", () => {
    const m = structuredModel();
    const text = outlineFromModel(m);
    const { items } = parseOutline(text);
    const fns = m.nodes.filter((n) => (n.type === "task" || n.type === "subprocess") && !n.bpmn_scope);
    expect(items.filter((i) => i.level === 0).map((i) => i.name)).toEqual(fns.filter((n) => !n.idef0_parent).map((n) => n.name));
    expect(items.filter((i) => i.level === 1).map((i) => i.name).sort()).toEqual(fns.filter((n) => n.idef0_parent).map((n) => n.name).sort());
    // действия диаграмм операций — не структура: их в списке быть не должно
    const step = m.nodes.find((n) => n.bpmn_scope)!;
    expect(text).not.toContain(step.name);
    // список читается тем же разбором без ошибок формы
    expect(items.length).toBe(fns.length);
  });

  it("пустая модель — пустой список", () => {
    expect(outlineFromModel({ ...structuredModel(), nodes: [] })).toBe("");
  });
});

describe("перенос функций: коды по Соглашению пересчитываются", () => {
  it("операция внутри подпроцесса: порядок меняется, код следует за порядком", () => {
    const m = structuredModel();
    const next = moveFunction(m, "o2", { kind: "before", id: "o1" });
    expect(codeOf(next, "o2")).toBe("B002.01.01");
    expect(codeOf(next, "o1")).toBe("B002.01.02");
    expect(next.nodes.filter((n) => n.bpmn_scope === "o1")).toHaveLength(m.nodes.filter((n) => n.bpmn_scope === "o1").length); // шаги диаграммы на месте
  });

  it("в другой подпроцесс: родитель меняется, раскладка IDEF0 сбрасывается, шаги диаграммы остаются у операции", () => {
    const m = structuredModel();
    const next = moveFunction(m, "o2", { kind: "into", id: "s2" });
    expect(next.nodes.find((n) => n.id === "o2")!.idef0_parent).toBe("s2");
    expect(next.nodes.find((n) => n.id === "o2")!.idef0_layout ?? null).toBeNull();
    expect(codeOf(next, "o2")).toBe("B002.02.02");
    expect(next.nodes.find((n) => n.id === "b1")!.bpmn_scope).toBe("o1");
  });

  it("подпроцесс целиком (с операциями) меняется местами с другим", () => {
    const next = moveFunction(structuredModel(), "s2", { kind: "before", id: "s1" });
    expect(codeOf(next, "s2")).toBe("B002.01.00");
    expect(codeOf(next, "o3")).toBe("B002.01.01");
    expect(codeOf(next, "o1")).toBe("B002.02.01");
  });

  it("нельзя: на себя, внутрь себя, подпроцесс внутрь подпроцесса (глубже операции функций нет), не на функцию", () => {
    const m = structuredModel();
    expect(moveProblem(m, "o1", { kind: "before", id: "o1" })).toMatch(/саму на себя/);
    expect(moveProblem(m, "s1", { kind: "into", id: "o1" })).toMatch(/внутрь самой себя|Соглашению/);
    expect(moveProblem(m, "s1", { kind: "into", id: "s2" })).toMatch(/Соглашению/);
    expect(moveProblem(m, "o1", { kind: "into", id: "o2" })).toMatch(/Соглашению/);
    expect(moveProblem(m, "o1", { kind: "before", id: "b1" })).toMatch(/только функция/);
    expect(moveProblem(m, "b1", { kind: "before", id: "o1" })).toMatch(/только функции/);
    expect(moveProblem(m, "o1", { kind: "after", id: "o2" })).toBeNull();
    expect(moveFunction(m, "s1", { kind: "into", id: "s2" })).toBe(m); // невозможный перенос модель не меняет
  });

  it("операцию можно вынести на верхний уровень (станет подпроцессом) и без кода процесса глубина не ограничена", () => {
    const m = structuredModel();
    const top = moveFunction(m, "o2", { kind: "after", id: "s1" });
    expect(top.nodes.find((n) => n.id === "o2")!.idef0_parent).toBeNull();
    const plain = { ...m, process: { ...m.process, code: null } } as M;
    expect(moveProblem(plain, "s1", { kind: "into", id: "s2" })).toBeNull();
  });

  it("предпросмотр: «было → стало»; для невозможного переноса — null", () => {
    const m = structuredModel();
    expect(previewMove(m, "o1", { kind: "after", id: "o2" })).toEqual({ from: "B002.01.01", to: "B002.01.02" });
    expect(previewMove(m, "s1", { kind: "into", id: "s2" })).toBeNull();
  });

  it("ссылки на коды в поставщике/потребителе и во внешних пулах переписываются на новые", () => {
    const m = structuredModel();
    m.data[1] = { ...m.data[1], supplier: "B002.01.01", consumer: "B002.01.02, B002.02.01" };
    m.pools = [{ id: "pl1", name: "Партнёр", code: "B002.01.02" }] as M["pools"];
    const next = moveFunction(m, "o2", { kind: "before", id: "o1" });
    expect(next.data[1].supplier).toBe("B002.01.02");
    expect(next.data[1].consumer).toBe("B002.01.01, B002.02.01");
    expect(next.pools![0].code).toBe("B002.01.01");
    expect(remapCodes(m, m)).toBe(m);
  });

  it("сдвиг вверх/вниз среди равных; на краю модель не меняется", () => {
    const m = structuredModel();
    expect(shiftFunction(m, "o1", -1)).toBe(m);
    expect(shiftFunction(m, "o2", 1)).toBe(m);
    expect(codeOf(shiftFunction(m, "o1", 1), "o1")).toBe("B002.01.02");
    expect(codeOf(shiftFunction(m, "s2", -1), "s2")).toBe("B002.01.00");
  });

  it("после переноса модель не получает новых ошибок проверок", () => {
    const m = structuredModel();
    const before = validateModel(m).filter((i) => i.severity === "error").length;
    const next = moveFunction(m, "o2", { kind: "into", id: "s2" });
    expect(validateModel(next).filter((i) => i.severity === "error").length).toBeLessThanOrEqual(before);
  });
});

describe("добавление и удаление функций", () => {
  it("дочерняя функция получает следующий код в подпроцессе", () => {
    const r = addChildFunction(structuredModel(), "s1");
    expect(codeOf(r.model, r.id)).toBe("B002.01.03");
    expect(r.model.nodes.find((n) => n.id === r.id)!.idef0_parent).toBe("s1");
  });

  it("оценка удаления: подпроцесс забирает операции, шаги диаграмм и стрелки; операция — свои шаги", () => {
    const m = structuredModel();
    expect(deleteImpact(m, "o1")).toEqual({ functions: 1, steps: 4, flows: 3 });
    expect(deleteImpact(m, "s1")).toEqual({ functions: 3, steps: 4, flows: 3 });
    expect(deleteImpact(m, "o3")).toEqual({ functions: 1, steps: 0, flows: 0 });
  });
});

describe("разбор списка структуры", () => {
  it("уровни по отступам, коды и маркеры отбрасываются", () => {
    const { items } = parseOutline("A\n  - B002.01.01 Операция один\n  1.2. Операция два\nБ\n\tОперация три");
    expect(items.map((i) => [i.level, i.name])).toEqual([
      [0, "A"],
      [1, "Операция один"],
      [1, "Операция два"],
      [0, "Б"],
      [1, "Операция три"],
    ]);
  });

  it("замечания: уровень глубже операции, повтор названия, подпроцесс без операций, число блоков", () => {
    const text = "Первый\n  Операция\n    Слишком глубоко\nПервый\n";
    const { items, problems } = parseOutline(text);
    expect(items.find((i) => i.name === "Слишком глубоко")!.level).toBe(1);
    const all = problems.join("\n");
    expect(all).toMatch(/глубже операции/);
    expect(all).toMatch(/повторяет строку/);
    expect(all).toMatch(/нет операций/);
    expect(all).toMatch(/рекомендуется 3–6 блоков/);
  });

  it("корректный список из трёх подпроцессов — без замечаний", () => {
    const { problems } = parseOutline("Один\n  а1\nДва\n  б1\nТри\n  в1");
    expect(problems).toEqual([]);
    expect(parseOutline("").items).toEqual([]);
  });
});

describe("создание структуры по списку", () => {
  const blank = (): M => ({ ...structuredModel(), nodes: [], flows: [], assignments: [], data: [], process: { ...structuredModel().process, code: null } });

  it("коды процесса и группа, функции получают коды Соглашения, заготовки диаграмм — у каждой операции", () => {
    const { items } = parseOutline("Моделирование\n  Реестр\n  Интервью\nАнализ\n  Соответствие");
    const m = applyStructure(blank(), items, { code: "b2", group: " Управление ", skeletons: true });
    expect(m.process.code).toBe("B002.00.00");
    expect(m.process.group).toBe("Управление");
    const codes = functionCodes(m);
    const byName = (name: string) => m.nodes.find((n) => n.name === name && !n.bpmn_scope)!;
    expect([byName("Моделирование"), byName("Реестр"), byName("Интервью"), byName("Анализ"), byName("Соответствие")].map((n) => codes.get(n.id))).toEqual(["B002.01.00", "B002.01.01", "B002.01.02", "B002.02.00", "B002.02.01"]);
    for (const op of ["Реестр", "Интервью", "Соответствие"]) expect(m.nodes.filter((n) => n.bpmn_scope === byName(op).id).length).toBe(3);
    expect(m.nodes.filter((n) => n.bpmn_scope === byName("Моделирование").id)).toHaveLength(0);
    expect(new Set(m.nodes.map((n) => n.id)).size).toBe(m.nodes.length); // идентификаторы уникальны
  });

  it("без заготовок диаграмм шагов нет; к имеющимся функциям добавляется, не затирая их", () => {
    const base = structuredModel();
    const m = applyStructure(base, parseOutline("Новый\n  Операция").items, {});
    expect(m.nodes.length).toBe(base.nodes.length + 2);
    expect(m.process.code).toBe(base.process.code);
    expect(codeOf(m, m.nodes.find((n) => n.name === "Новый")!.id)).toBe("B002.03.00");
  });
});

describe("навигатор: перетаскивание и контекстное меню", () => {
  function setup(extra: Partial<React.ComponentProps<typeof Navigator>> = {}) {
    const onMoveFunction = vi.fn();
    const onFunctionAction = vi.fn();
    const r = render(
      <Navigator model={structuredModel()} activeKey="bpmn" selectedId={null} onOpenDoc={vi.fn()} onSelectFn={vi.fn()} onAddFunction={vi.fn()} onMoveFunction={onMoveFunction} onFunctionAction={onFunctionAction} {...extra} />,
    );
    return { ...r, onMoveFunction, onFunctionAction };
  }
  const row = (id: string) => document.querySelector(`[data-nav-fn="${id}"]`) as HTMLElement;
  // в jsdom у события dragover нет координат — задаём вручную (высота строки там 0, поэтому берётся 20)
  const over = (el: HTMLElement, clientY: number) => {
    const ev = createEvent.dragOver(el);
    Object.defineProperty(ev, "clientY", { value: clientY });
    fireEvent(el, ev);
  };

  it("перетаскивание: подсветка места и новые коды, затем перенос по отпусканию", () => {
    const { onMoveFunction } = setup();
    fireEvent.dragStart(row("o2"));
    over(row("o1"), 0); // верхняя треть — «перед»
    expect(row("o1").className).toMatch(/drop-before/);
    expect(row("o1").getAttribute("data-drop-preview")).toBe("B002.01.02 → B002.01.01");
    fireEvent.drop(row("o1"));
    expect(onMoveFunction).toHaveBeenCalledWith("o2", { kind: "before", id: "o1" });
    expect(row("o1").className).not.toMatch(/drop-/);
  });

  it("середина строки подпроцесса — «внутрь»; на недопустимое место перенос не предлагается", () => {
    const { onMoveFunction } = setup();
    fireEvent.dragStart(row("o3"));
    over(row("s1"), 10);
    expect(row("s1").className).toMatch(/drop-into/);
    fireEvent.drop(row("s1"));
    expect(onMoveFunction).toHaveBeenCalledWith("o3", { kind: "into", id: "s1" });
    onMoveFunction.mockClear();
    fireEvent.dragStart(row("s1"));
    over(row("o3"), 10);
    fireEvent.drop(row("o3"));
    expect(onMoveFunction).not.toHaveBeenCalled(); // подпроцесс внутрь операции — нельзя
  });

  it("без обработчика переноса строки не перетаскиваются", () => {
    render(<Navigator model={structuredModel()} activeKey="bpmn" selectedId={null} onOpenDoc={vi.fn()} onSelectFn={vi.fn()} onAddFunction={vi.fn()} />);
    expect(row("o1").getAttribute("draggable")).toBe("false");
  });

  it("меню операции: действия вызываются, края списка блокируют сдвиг", () => {
    const { onFunctionAction, onMoveFunction } = setup();
    fireEvent.contextMenu(row("o1"));
    expect(screen.getByRole("menu")).toBeTruthy();
    expect((screen.getByText("Переместить вверх") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText("Переместить вниз"));
    expect(onMoveFunction).toHaveBeenCalledWith("o1", { kind: "after", id: "o2" });
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.contextMenu(row("o1"));
    fireEvent.click(screen.getByText("Дублировать"));
    expect(onFunctionAction).toHaveBeenLastCalledWith("duplicate", "o1");
    fireEvent.contextMenu(row("o1"));
    fireEvent.click(screen.getByText("Удалить…"));
    expect(onFunctionAction).toHaveBeenLastCalledWith("delete", "o1");
  });

  it("заготовка диаграммы предлагается только операции без шагов; в подпроцессе — добавить операцию", () => {
    const { onFunctionAction } = setup();
    fireEvent.contextMenu(row("o1"));
    expect(screen.queryByText("Создать заготовку диаграммы BPMN")).toBeNull(); // шаги уже есть
    fireEvent.contextMenu(row("o2"));
    fireEvent.click(screen.getByText("Создать заготовку диаграммы BPMN"));
    expect(onFunctionAction).toHaveBeenLastCalledWith("skeleton", "o2");
    fireEvent.contextMenu(row("s1"));
    fireEvent.click(screen.getByText("Добавить операцию"));
    expect(onFunctionAction).toHaveBeenLastCalledWith("add-child", "s1");
  });

  it("меню процесса открывает мастер структуры", () => {
    const onWizard = vi.fn();
    setup({ onWizard });
    fireEvent.contextMenu(document.querySelector("[data-nav-process]")!);
    fireEvent.click(screen.getByText("Мастер структуры…"));
    expect(onWizard).toHaveBeenCalled();
  });
});

describe("мастер структуры", () => {
  const empty = (): M => ({ ...structuredModel(), nodes: [], flows: [], assignments: [], process: { ...structuredModel().process, code: null } });

  it("предпросмотр с кодами, замечания и создание структуры", () => {
    const onApply = vi.fn();
    const onClose = vi.fn();
    render(<StructureWizard model={empty()} onApply={onApply} onClose={onClose} />);
    const create = screen.getByText("Создать структуру") as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText("B002 или B002.00.00"), { target: { value: "b2" } });
    fireEvent.change(screen.getByLabelText("Структура процесса"), { target: { value: "Один\n  Операция а\nДва\n  Операция б" } });
    expect([...document.querySelectorAll(".wizard-preview li")].map((li) => li.textContent!.replace(/\s+/g, " ").trim())).toEqual(["B002.01.00 Один", "B002.01.01 Операция а", "B002.02.00 Два", "B002.02.01 Операция б"]);
    expect(screen.getByText("Будет записан как B002.00.00.")).toBeTruthy();
    expect(document.querySelector(".wizard-problems")!.textContent).toMatch(/рекомендуется 3–6 блоков/); // замечание не блокирует
    expect(create.disabled).toBe(false);
    fireEvent.click(create);
    const next = onApply.mock.calls[0][0] as M;
    expect(next.process.code).toBe("B002.00.00");
    expect(next.nodes.filter((n) => n.bpmn_scope)).toHaveLength(6); // заготовка у обеих операций: 3 шага
    expect(onClose).toHaveBeenCalled();
  });

  it("код не по шаблону блокирует создание; Escape и клик по фону закрывают", () => {
    const onClose = vi.fn();
    render(<StructureWizard model={empty()} onApply={vi.fn()} onClose={onClose} />);
    fireEvent.change(screen.getByPlaceholderText("B002 или B002.00.00"), { target: { value: "ерунда" } });
    fireEvent.change(screen.getByLabelText("Структура процесса"), { target: { value: "Один\n  а" } });
    expect(screen.getByText(/Код не по шаблону/)).toBeTruthy();
    expect((screen.getByText("Создать структуру") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.mouseDown(document.querySelector(".wizard-backdrop")!);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("«Вставить пример» заполняет список", () => {
    render(<StructureWizard model={empty()} onApply={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText("Вставить пример"));
    expect(document.querySelectorAll(".wizard-preview li").length).toBeGreaterThan(5);
  });
});
