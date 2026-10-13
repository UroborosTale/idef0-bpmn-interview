import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { purchaseModel, session, structuredModel } from "../../test/fixtures";
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

describe("окно студии: утверждённая версия", () => {
  const approved = () => {
    const s = session();
    return { ...s, model: { ...s.model!, process: { ...s.model!.process, status: "approved" as const } } };
  };

  it("показывает причину и кнопку нового цикла правок; правки не принимаются", () => {
    const onReopen = vi.fn();
    render(<Studio session={approved()} busy={false} onSave={vi.fn(async () => true)} onReopen={onReopen} />);
    const banner = document.querySelector(".studio-lock")!;
    expect(banner.textContent).toMatch(/Версия утверждена и заблокирована/);
    fireEvent.click(screen.getByText("Открыть новый цикл правок"));
    expect(onReopen).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".studio")!.className).toMatch(/studio-readonly/);
    // свойства только для чтения: поля отключены
    fireEvent.pointerDown(document.querySelector('[data-node-id="b"]')!, { button: 0, pointerId: 1 });
    expect(field("Название").closest("fieldset")!.disabled).toBe(true);
    expect((screen.getByTitle(/Копия выбранной функции/) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTitle("Отменить (Ctrl+Z)") as HTMLButtonElement).disabled).toBe(true);
  });

  it("у черновика баннера нет", () => {
    render(<Studio session={session()} busy={false} onSave={vi.fn(async () => true)} />);
    expect(document.querySelector(".studio-lock")).toBeNull();
    expect(document.querySelector(".studio")!.className).not.toMatch(/studio-readonly/);
  });
});

describe("окно студии: навигатор следует за выбором", () => {
  it("выбор фигуры подсвечивает функцию в дереве, «Найти в навигаторе» открывает свёрнутые ветки", () => {
    render(<Studio session={session()} busy={false} onSave={vi.fn(async () => true)} />);
    fireEvent.pointerDown(document.querySelector('[data-node-id="b"]')!, { button: 0, pointerId: 1 });
    expect(document.querySelector('[data-nav-fn="b"]')!.className).toMatch(/selected/);
    fireEvent.click(document.querySelector(".nav-section-head")!); // свернуть «Процессы»
    expect(document.querySelector('[data-nav-fn="b"]')).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Найти в навигаторе" }));
    expect(document.querySelector('[data-nav-fn="b"]')!.className).toMatch(/selected/);
  });
});

describe("окно студии: клавиши навигатора", () => {
  it("F2 переименовывает функцию в общей истории (Ctrl+Z возвращает), на утверждённой версии — нельзя", () => {
    render(<Studio session={session()} busy={false} onSave={vi.fn(async () => true)} />);
    const row = () => document.querySelector('[data-nav-fn="b"]') as HTMLElement;
    fireEvent.click(row());
    fireEvent.keyDown(row(), { key: "F2" });
    const input = document.querySelector(".nav-rename") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "утвердить заявку" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(row().querySelector(".nav-name")!.textContent).toBe("утвердить заявку");
    fireEvent.keyDown(row(), { key: "z", ctrlKey: true });
    expect(row().querySelector(".nav-name")!.textContent).toBe("согласовать заявку");
  });

  it("на утверждённой версии F2 ничего не открывает", () => {
    const s = session();
    const locked = { ...s, model: { ...s.model!, process: { ...s.model!.process, status: "approved" as const } } };
    render(<Studio session={locked} busy={false} onSave={vi.fn(async () => true)} />);
    const row = document.querySelector('[data-nav-fn="b"]') as HTMLElement;
    fireEvent.click(row);
    fireEvent.keyDown(row, { key: "F2" });
    expect(document.querySelector(".nav-rename")).toBeNull();
  });
});

describe("окно студии: «Предыдущая», «Следующая», «Вверх», «Вниз»", () => {
  const structured = () => render(<Studio session={session(structuredModel())} busy={false} onSave={vi.fn(async () => true)} />);
  const btn = (name: RegExp | string) => screen.getByRole("button", { name }) as HTMLButtonElement;
  const active = () => document.querySelector(".doc-tab.active")!.firstChild!.textContent;

  it("«Предыдущая» и «Следующая» ходят по открытым диаграммам; кнопки отключены на краях истории", () => {
    structured();
    expect(btn(/Предыдущая/).disabled).toBe(true);
    expect(btn(/Следующая/).disabled).toBe(true);
    fireEvent.click(document.querySelector('[data-nav-fn="o1"]')!); // диаграмма подпроцесса, где стоит операция
    const first = active();
    expect(first).not.toBe("BPMN");
    fireEvent.click(document.querySelector('[data-nav-bpmn="o1"]')!); // диаграмма BPMN операции
    const second = active();
    expect(second).toMatch(/^BPMN /);
    fireEvent.click(btn(/Предыдущая/));
    expect(active()).toBe(first);
    fireEvent.click(btn(/Предыдущая/));
    expect(active()).toBe("BPMN");
    expect(btn(/Предыдущая/).disabled).toBe(true);
    fireEvent.click(btn(/Следующая/));
    fireEvent.click(btn(/Следующая/));
    expect(active()).toBe(second);
    expect(btn(/Следующая/).disabled).toBe(true);
  });

  it("новый переход после «Предыдущая» отбрасывает «вперёд»", () => {
    structured();
    fireEvent.click(document.querySelector('[data-nav-fn="o1"]')!);
    fireEvent.click(document.querySelector('[data-nav-bpmn="o1"]')!);
    fireEvent.click(btn(/Предыдущая/));
    expect(btn(/Следующая/).disabled).toBe(false);
    fireEvent.click(document.querySelector('[data-nav-fn="o3"]')!);
    expect(btn(/Следующая/).disabled).toBe(true);
  });

  it("Alt+← и Alt+→ работают как кнопки", () => {
    structured();
    fireEvent.click(document.querySelector('[data-nav-fn="o1"]')!);
    const before = active();
    fireEvent.keyDown(document.querySelector(".studio")!, { key: "ArrowLeft", altKey: true });
    expect(active()).toBe("BPMN");
    fireEvent.keyDown(document.querySelector(".studio")!, { key: "ArrowRight", altKey: true });
    expect(active()).toBe(before);
  });

  it("«Вверх»: от декомпозиции — к диаграмме, где стоит функция, и функция выделяется; на корне отключено", () => {
    structured();
    fireEvent.click(document.querySelector('[data-nav-fn="o1"]')!); // диаграмма IDEF0 подпроцесса s1
    expect(btn(/Вверх/).disabled).toBe(false);
    fireEvent.click(btn(/Вверх/));
    expect(active()).toBe("IDEF0 B002.00.00");
    expect(document.querySelector('[data-nav-fn="s1"]')!.className).toMatch(/selected/);
    expect(btn(/Вверх/).disabled).toBe(true);
    // с диаграммы BPMN операции — на диаграмму её подпроцесса
    fireEvent.click(document.querySelector('[data-nav-bpmn="o1"]')!);
    fireEvent.click(btn(/Вверх/));
    expect(active()).toBe("IDEF0 B002.01.00");
  });

  it("«Вниз»: выбранная функция открывает свою декомпозицию, а операция — диаграмму BPMN", () => {
    structured();
    expect(btn(/Вниз/).disabled).toBe(true);
    fireEvent.click(document.querySelector('[data-nav-fn="s1"]')!);
    fireEvent.click(document.querySelector('[data-nav-fn="s1"]')!);
    fireEvent.click(btn(/Вниз/));
    expect(active()).toBe("IDEF0 B002.01.00");
    fireEvent.click(document.querySelector('[data-nav-fn="o1"]')!);
    fireEvent.click(btn(/Вниз/));
    expect(active()).toBe("BPMN B002.01.01");
  });
});

