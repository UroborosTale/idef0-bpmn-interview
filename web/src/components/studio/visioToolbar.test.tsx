import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import VisioSlot from "./VisioSlot";

/** В настольном приложении студия говорит с оболочкой через window.chrome.webview; здесь оболочка подменена. */
let post: ReturnType<typeof vi.fn>;
beforeEach(() => {
  post = vi.fn();
  (window as unknown as { chrome: unknown }).chrome = { webview: { postMessage: post } };
});
afterEach(() => {
  delete (window as unknown as { chrome?: unknown }).chrome;
});

const toolbar = (over: Partial<Parameters<typeof VisioSlot>[0]["toolbar"]> = {}) => ({ propsOpen: true, onToggleProps: vi.fn(), onFind: vi.fn(), onClose: vi.fn(), ...over });
const mount = (t = toolbar()) => {
  render(<VisioSlot sessionId="s1" updatedAt="u1" diagram={{ kind: "bpmn", scope: null }} toolbar={t} />);
  return t;
};
const sent = () => post.mock.calls.map((c) => c[0] as { t: string });

describe("панель инструментов диаграммы в настольном приложении", () => {
  it("место холста сообщается оболочке; кнопки отправляют команды", () => {
    mount();
    expect(sent().some((m) => m.t === "slot")).toBe(true);
    fireEvent.click(screen.getByLabelText("Записать правки Visio"));
    fireEvent.click(screen.getByLabelText("Перечитать диаграмму"));
    fireEvent.click(screen.getByLabelText("Вписать в окно"));
    const ts = sent().map((m) => m.t);
    expect(ts).toContain("apply");
    expect(ts).toContain("reload");
    expect(ts).toContain("fit");
  });

  it("масштаб: выбор процентов отправляет долю, «По странице» — fit", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Список масштабов" }));
    fireEvent.click(screen.getByRole("option", { name: "150%" }));
    expect(post).toHaveBeenCalledWith({ t: "zoom", value: 1.5 });
    fireEvent.click(screen.getByRole("button", { name: "Список масштабов" }));
    fireEvent.click(screen.getByRole("option", { name: "По странице" }));
    expect(sent().filter((m) => m.t === "fit").length).toBeGreaterThan(0);
  });

  it("«Действия»: сетка, найти в навигаторе; меню закрывается; «Свойства» и «Закрыть» вызывают студию", () => {
    const t = mount();
    fireEvent.click(screen.getByRole("button", { name: "Действия" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Сетка/ }));
    expect(sent().some((m) => m.t === "grid")).toBe(true);
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Действия" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Найти в навигаторе" }));
    expect(t.onFind).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Свойства" }));
    expect(t.onToggleProps).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Закрыть/ }));
    expect(t.onClose).toHaveBeenCalled();
  });

  it("у последней вкладки кнопки «Закрыть» нет", () => {
    mount(toolbar({ onClose: undefined }));
    expect(screen.queryByRole("button", { name: /Закрыть/ })).toBeNull();
  });
});
