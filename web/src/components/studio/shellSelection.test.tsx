import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { session, structuredModel } from "../../test/fixtures";
import Studio from "./Studio";

/** Оболочка настольного приложения: window.chrome.webview с подпиской на сообщения, как в WebView2. */
let post: ReturnType<typeof vi.fn>;
let listeners: ((e: { data: unknown }) => void)[];
beforeEach(() => {
  post = vi.fn();
  listeners = [];
  (window as unknown as { chrome: unknown }).chrome = {
    webview: {
      postMessage: post,
      addEventListener: (_: string, h: (e: { data: unknown }) => void) => listeners.push(h),
      removeEventListener: (_: string, h: (e: { data: unknown }) => void) => (listeners = listeners.filter((x) => x !== h)),
    },
  };
});
afterEach(() => {
  delete (window as unknown as { chrome?: unknown }).chrome;
});

const fromShell = (data: unknown) => act(() => listeners.forEach((h) => h({ data })));
const title = () => document.querySelector(".props-head b")!.textContent;
const sent = () => post.mock.calls.map((c) => c[0] as { t: string; id?: string });

describe("выделение между студией и Visio", () => {
  it("фигура, выделенная в Visio, открывается в панели свойств; обратно она не отправляется", () => {
    render(<Studio session={session()} busy={false} onSave={vi.fn(async () => true)} />);
    expect(document.querySelector(".props-head")).toBeNull(); // как в Business Studio, свойства открываются по кнопке
    fromShell({ t: "props" });
    expect(title()).toBe("Свойства процесса");
    fromShell({ t: "visio-select", kind: "node", id: "b" });
    expect(title()).toBe("Свойства элемента");
    expect(sent().some((m) => m.t === "select")).toBe(false); // эха нет
  });

  it("шаг, выбранный в студии (навигатор), отправляется оболочке для выделения в Visio", () => {
    render(<Studio session={session()} busy={false} onSave={vi.fn(async () => true)} />);
    fireEvent.click(document.querySelector('[data-nav-fn="b1"]')!);
    expect(sent().filter((m) => m.t === "select").map((m) => m.id)).toContain("b1");
  });

  it("чужие и неполные сообщения игнорируются", () => {
    render(<Studio session={session()} busy={false} onSave={vi.fn(async () => true)} />);
    fromShell({ t: "что-то другое" });
    fromShell(null);
    expect(document.querySelector(".props-head")).toBeNull();
    fromShell({ t: "props" });
    expect(title()).toBe("Свойства процесса");
  });

  it("Ctrl+E в окне Visio (сообщение props) открывает скрытую панель свойств, как в Business Studio", () => {
    render(<Studio session={session()} busy={false} onSave={vi.fn(async () => true)} />);
    expect(document.querySelector(".props-head")).toBeNull(); // по умолчанию панель скрыта
    fromShell({ t: "props" });
    expect(document.querySelector(".props-head")).not.toBeNull();
  });

  it("правый щелчок по шагу в Visio: меню объекта с типом задачи и цикла; выбор типа записывается в модель", async () => {
    const onSave = vi.fn(async () => true);
    render(<Studio session={session()} busy={false} onSave={onSave} />);
    fromShell({ t: "shape-menu", kind: "node", id: "b1" });
    const req = post.mock.calls.map((c) => c[0] as { t: string; id?: string; items?: { label?: string; items?: { id: string; checked?: boolean }[] }[] }).find((m) => m.t === "menu")!;
    const labels = req.items!.map((i) => i.label).filter(Boolean);
    expect(labels).toEqual(expect.arrayContaining(["Тип задачи", "Тип цикла", "Вырезать", "Выделить все подобные", "Анализ использования объекта", "Свойства объекта"]));
    await act(async () => listeners.forEach((h) => h({ data: { t: "menu-pick", id: req.id, item: "subtype:user" } })));
    await act(async () => new Promise((r) => setTimeout(r, 10)));
    const saved = (onSave.mock.calls.at(-1) as unknown as [{ nodes: { id: string; subtype?: string }[] }])[0];
    expect(saved.nodes.find((n) => n.id === "b1")!.subtype).toBe("user");
  });

  it("правый щелчок по событию: «Тип события» и «Тип триггера» как в Business Studio; выбор записывается в модель", async () => {
    const onSave = vi.fn(async () => true);
    render(<Studio session={session(structuredModel())} busy={false} onSave={onSave} />);
    fromShell({ t: "shape-menu", kind: "node", id: "b0" });
    type Item = { label?: string; items?: { id: string; label: string; checked?: boolean }[] };
    const req = post.mock.calls.map((c) => c[0] as { t: string; id?: string; items?: Item[] }).find((m) => m.t === "menu")!;
    const ev = req.items!.find((i) => i.label === "Тип события")!;
    expect(ev.items!.map((i) => i.label)).toEqual(["Стартовое событие", "Промежуточное событие (Обработчик)", "Промежуточное событие (Инициатор)", "Конечное событие"]);
    expect(ev.items!.find((i) => i.checked)!.id).toBe("evtype:start");
    const trg = req.items!.find((i) => i.label === "Тип триггера")!;
    expect(trg.items!.map((i) => i.label)).toEqual(["Неопределенное", "Сообщение", "Таймер", "Условие", "Сигнал", "Множественное", "Параллельное множественное"]);
    expect(trg.items!.find((i) => i.checked)!.id).toBe("trigger:none");
    await act(async () => listeners.forEach((h) => h({ data: { t: "menu-pick", id: req.id, item: "trigger:timer" } })));
    await act(async () => new Promise((r) => setTimeout(r, 10)));
    const saved = (onSave.mock.calls.at(-1) as unknown as [{ nodes: { id: string; trigger?: { type: string } | null }[] }])[0];
    expect(saved.nodes.find((n) => n.id === "b0")!.trigger?.type).toBe("timer");
  });

  it("пункты меню фигуры «Гиперссылка…» и «Настроить показ параметров»: окна, запись в модель, Visio прячется на время окна", async () => {
    const onSave = vi.fn(async () => true);
    render(<Studio session={session(structuredModel())} busy={false} onSave={onSave} />);
    const menuFor = async (item: string) => {
      post.mockClear();
      fromShell({ t: "shape-menu", kind: "node", id: "b1" });
      const req = post.mock.calls.map((c) => c[0] as { t: string; id?: string; items?: { id?: string; label?: string }[] }).find((m) => m.t === "menu")!;
      expect(req.items!.map((i) => i.label)).toEqual(expect.arrayContaining(["Настроить показ параметров", "Гиперссылка…", "Сменить объект"]));
      await act(async () => listeners.forEach((h) => h({ data: { t: "menu-pick", id: req.id, item } })));
    };
    await menuFor("links");
    expect(screen.getByRole("dialog", { name: "Гиперссылки" })).toBeTruthy();
    expect(post.mock.calls.some((c) => (c[0] as { t: string; visible?: boolean }).t === "slot" && (c[0] as { visible?: boolean }).visible === false)).toBe(true);
    fireEvent.change(screen.getByLabelText("Адрес"), { target: { value: "https://example.org/reg" } });
    fireEvent.change(screen.getByLabelText("Описание"), { target: { value: "Регламент" } });
    fireEvent.click(screen.getByRole("button", { name: "ОК" }));
    await act(async () => new Promise((r) => setTimeout(r, 10)));
    const saved = () => (onSave.mock.calls.at(-1) as unknown as [{ nodes: { id: string; hyperlinks?: { address: string; description?: string }[]; param_display?: Record<string, { param: string; prefix?: string }> }[] }])[0].nodes.find((n) => n.id === "b1")!;
    expect(saved().hyperlinks).toEqual([{ address: "https://example.org/reg", description: "Регламент" }]);

    await menuFor("params");
    expect(screen.getByRole("dialog", { name: "Настройка показа параметров объекта" })).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Параметр 3"));
    fireEvent.change(screen.getByLabelText("Параметр для отображения"), { target: { value: "role" } });
    fireEvent.change(screen.getByLabelText("Префикс"), { target: { value: "Исп.: " } });
    fireEvent.click(screen.getByRole("button", { name: "ОК" }));
    await act(async () => new Promise((r) => setTimeout(r, 10)));
    expect(saved().param_display).toEqual({ p3: { param: "role", prefix: "Исп.: " } });
  });

  it("правый щелчок по пустому месту: вставить, выделить всё и команды страницы уходят оболочке", async () => {
    render(<Studio session={session()} busy={false} onSave={vi.fn(async () => true)} />);
    fromShell({ t: "shape-menu", kind: null, id: null });
    const req = post.mock.calls.map((c) => c[0] as { t: string; id?: string }).find((m) => m.t === "menu")!;
    await act(async () => listeners.forEach((h) => h({ data: { t: "menu-pick", id: req.id, item: "cmd:pagesetup" } })));
    expect(post).toHaveBeenCalledWith({ t: "cmd", name: "pagesetup" });
  });

  it("строка состояния при выбранном объекте показывает его название, статус и происхождение, как в Business Studio", () => {
    render(<Studio session={session()} busy={false} onSave={vi.fn(async () => true)} />);
    expect(document.querySelector("[data-status-object]")).toBeNull();
    fromShell({ t: "visio-select", kind: "node", id: "b" });
    const st = document.querySelector("[data-status-object]")!.textContent!;
    expect(st).toMatch(/подтверждён|гипотеза/);
    expect(st).toMatch(/из интервью|создан вручную/);
  });

  it("палитра существующих объектов: документ к выбранному шагу входом, программный продукт — отметкой; без шага — подсказка", async () => {
    sessionStorage.clear(); // вкладки студии из прошлых тестов не восстанавливаются: открыта общая схема BPMN
    const onSave = vi.fn(async () => true);
    render(<Studio session={session()} busy={false} onSave={onSave} />);
    const lastMenu = () => post.mock.calls.map((c) => c[0] as { t: string; id?: string; items?: { id?: string; label?: string; disabled?: boolean }[] }).filter((m) => m.t === "menu").at(-1)!;
    fireEvent.click(document.querySelector('[aria-label="Документы"]')!);
    expect(lastMenu().items![0]).toMatchObject({ disabled: true, label: "Сначала выберите шаг на диаграмме" });
    await act(async () => listeners.forEach((h) => h({ data: { t: "menu-closed", id: lastMenu().id } })));
    fromShell({ t: "visio-select", kind: "node", id: "b" });
    fireEvent.click(document.querySelector('[aria-label="Документы"]')!);
    const doc = lastMenu();
    await act(async () => listeners.forEach((h) => h({ data: { t: "menu-pick", id: doc.id, item: "in:d2" } })));
    await act(async () => new Promise((r) => setTimeout(r, 10)));
    let saved = (onSave.mock.calls.at(-1) as unknown as [{ nodes: { id: string; inputs: string[]; system_ids: string[] }[] }])[0];
    expect(saved.nodes.find((n) => n.id === "b")!.inputs).toContain("d2");
    fireEvent.click(document.querySelector('[aria-label="Программные продукты и базы данных"]')!);
    const sys = lastMenu();
    await act(async () => listeners.forEach((h) => h({ data: { t: "menu-pick", id: sys.id, item: "sys:s1" } })));
    await act(async () => new Promise((r) => setTimeout(r, 10)));
    saved = (onSave.mock.calls.at(-1) as unknown as [{ nodes: { id: string; inputs: string[]; system_ids: string[] }[] }])[0];
    expect(saved.nodes.find((n) => n.id === "b")!.system_ids).toContain("s1");
  });

  it("кнопка «Лист»: формат A3 и книжная ориентация записываются в настройки листа модели", async () => {
    sessionStorage.clear();
    const onSave = vi.fn(async () => true);
    render(<Studio session={session()} busy={false} onSave={onSave} />);
    const lastMenu = () => post.mock.calls.map((c) => c[0] as { t: string; id?: string; items?: { id?: string; checked?: boolean }[] }).filter((m) => m.t === "menu").at(-1)!;
    const pick = async (item: string) => {
      fireEvent.click(screen.getByRole("button", { name: "Лист" }));
      const req = lastMenu();
      await act(async () => listeners.forEach((h) => h({ data: { t: "menu-pick", id: req.id, item } })));
      await act(async () => new Promise((r) => setTimeout(r, 10)));
      return (onSave.mock.calls.at(-1) as unknown as [{ bpmn_frames?: Record<string, { show?: boolean; w?: number; h?: number }> }])[0];
    };
    let saved = await pick("frame");
    expect(saved.bpmn_frames![""].show).toBe(true); // общая схема BPMN: рамка по умолчанию скрыта
    saved = await pick("fmt:A3");
    expect(saved.bpmn_frames![""]).toMatchObject({ w: 1580, h: 1080 });
    saved = await pick("portrait");
    expect(saved.bpmn_frames![""]).toMatchObject({ w: 1080, h: 1580 });
    saved = await pick("auto");
    expect(saved.bpmn_frames![""].w).toBeUndefined();
  });
});

