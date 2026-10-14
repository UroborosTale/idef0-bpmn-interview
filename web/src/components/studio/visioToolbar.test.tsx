import { act, fireEvent, render, screen } from "@testing-library/react";
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

  it("«Действия» как в Business Studio: команды Visio уходят оболочке, «Открыть в MS Visio» — отдельной командой", () => {
    mount();
    const run = (name: RegExp) => {
      fireEvent.click(screen.getByRole("button", { name: "Действия" }));
      fireEvent.click(screen.getByRole("menuitem", { name }));
    };
    run(/Выравнивание фигур/);
    run(/Распределение фигур/);
    run(/Привязка фигур/);
    run(/Параметры страницы/);
    run(/Изменить размеры по содержимому/);
    run(/Формат по образцу/);
    run(/Панорама и масштаб/);
    run(/Размер и положение/);
    run(/Печать/);
    const names = post.mock.calls.map((c) => c[0] as { t: string; name?: string }).filter((m) => m.t === "cmd").map((m) => m.name);
    expect(names).toEqual(["align", "distribute", "snapglue", "pagesetup", "fitcontent", "formatpainter", "panzoom", "sizepos", "print"]);
    run(/Открыть диаграмму в MS Visio/);
    expect(sent().some((m) => m.t === "open-visio")).toBe(true);
  });

  it("переходы и синхронизация: недоступные кнопки выключены, доступные вызывают студию; 100 % — масштаб 1", () => {
    const t = mount(toolbar({ onUp: vi.fn(), onPrev: vi.fn(), syncNav: false, onToggleSync: vi.fn() }));
    expect((screen.getByRole("button", { name: "Вниз" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Следующая диаграмма" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Вверх" }));
    fireEvent.click(screen.getByRole("button", { name: "Предыдущая диаграмма" }));
    fireEvent.click(screen.getByRole("button", { name: "Синхронизировать с текущей фигурой" }));
    expect(t.onUp).toHaveBeenCalled();
    expect(t.onPrev).toHaveBeenCalled();
    expect(t.onToggleSync).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Масштаб по умолчанию" }));
    expect(post).toHaveBeenCalledWith({ t: "zoom", value: 1 });
  });

  it("в окне приложения меню показывает оболочка (меню Windows поверх Visio): выбранный пункт выполняется", async () => {
    const listeners: ((e: { data: unknown }) => void)[] = [];
    (window as unknown as { chrome: unknown }).chrome = { webview: { postMessage: post, addEventListener: (_: string, h: (e: { data: unknown }) => void) => listeners.push(h), removeEventListener: () => undefined } };
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Действия" }));
    expect(screen.queryByRole("menu")).toBeNull(); // HTML-меню не рисуется — его закрыло бы окно Visio
    const req = post.mock.calls.map((c) => c[0] as { t: string; id?: string; items?: { id?: string; group?: string }[] }).find((m) => m.t === "menu")!;
    expect(req.items!.some((i) => i.id === "align")).toBe(true);
    expect(req.items!.some((i) => i.group === "Положение фигур")).toBe(true);
    await act(async () => listeners.forEach((h) => h({ data: { t: "menu-pick", id: req.id, item: "align" } })));
    expect(post).toHaveBeenCalledWith({ t: "cmd", name: "align" });
    // список масштабов — тоже меню оболочки
    fireEvent.click(screen.getByRole("button", { name: "Список масштабов" }));
    const zreq = post.mock.calls.map((c) => c[0] as { t: string; id?: string }).filter((m) => m.t === "menu").at(-1)!;
    await act(async () => listeners.forEach((h) => h({ data: { t: "menu-pick", id: zreq.id, item: "50" } })));
    expect(post).toHaveBeenCalledWith({ t: "zoom", value: 0.5 });
  });
});
