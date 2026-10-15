import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { session } from "../../test/fixtures";
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
    expect(title()).toBe("Свойства процесса");
  });

  it("Ctrl+E в окне Visio (сообщение props) открывает скрытую панель свойств, как в Business Studio", () => {
    render(<Studio session={session()} busy={false} onSave={vi.fn(async () => true)} />);
    fireEvent.click(document.querySelector('[title="Скрыть панель"]')!);
    expect(document.querySelector(".props-head")).toBeNull();
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
});

