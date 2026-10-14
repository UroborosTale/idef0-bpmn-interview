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
});
