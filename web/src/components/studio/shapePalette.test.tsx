import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ShapePalette, { PALETTE } from "./ShapePalette";

/** В настольном приложении студия говорит с оболочкой через window.chrome.webview; здесь оболочка подменена. */
let post: ReturnType<typeof vi.fn>;
beforeEach(() => {
  post = vi.fn();
  (window as unknown as { chrome: unknown }).chrome = { webview: { postMessage: post } };
});
afterEach(() => {
  delete (window as unknown as { chrome?: unknown }).chrome;
});

describe("палитра фигур", () => {
  it("в палитре задача, подпроцесс, три события и семь шлюзов с подсказками", () => {
    render(<ShapePalette />);
    expect(PALETTE.map((p) => p.kind)).toEqual(["task", "subprocess", "event:start", "event:intermediate", "event:end", "gateway:exclusive", "gateway:parallel", "gateway:inclusive", "gateway:event_based", "gateway:complex", "gateway:event_based_start", "gateway:parallel_event_based"]);
    for (const p of PALETTE) expect(screen.getByRole("button", { name: p.title })).toBeTruthy();
  });

  it("щелчок без движения отправляет команду «drop» с dragged = false (фигура в центр)", () => {
    render(<ShapePalette />);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Задача" }), { clientX: 20, clientY: 20 });
    fireEvent.pointerUp(document, { clientX: 21, clientY: 21 });
    expect(post).toHaveBeenCalledWith({ t: "drop", kind: "task", dragged: false });
  });

  it("перетаскивание дальше порога отправляет dragged = true; Escape отменяет, ничего не отправляя", () => {
    render(<ShapePalette />);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Шлюз «или» (исключающий)" }), { clientX: 20, clientY: 20 });
    fireEvent.pointerUp(document, { clientX: 400, clientY: 300 });
    expect(post).toHaveBeenCalledWith({ t: "drop", kind: "gateway:exclusive", dragged: true });
    post.mockClear();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Конечное событие" }), { clientX: 20, clientY: 20 });
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.pointerUp(document, { clientX: 400, clientY: 300 });
    expect(post).not.toHaveBeenCalled();
  });

  it("тип события выбирается в списке рядом с фигурой и попадает в команду «drop»", () => {
    render(<ShapePalette />);
    fireEvent.click(screen.getByRole("button", { name: "Тип: Промежуточное событие" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Таймер" }));
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Промежуточное событие" }), { clientX: 20, clientY: 20 });
    fireEvent.pointerUp(document, { clientX: 20, clientY: 20 });
    expect(post).toHaveBeenCalledWith({ t: "drop", kind: "event:intermediate:timer", dragged: false });
    // у конечного события — свои типы, среди них эскалация; «Без типа» возвращает простое событие
    fireEvent.click(screen.getByRole("button", { name: "Тип: Конечное событие" }));
    expect(screen.getByRole("menuitemradio", { name: "Эскалация" })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Неопределенное" }));
    post.mockClear();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Конечное событие" }), { clientX: 20, clientY: 20 });
    fireEvent.pointerUp(document, { clientX: 20, clientY: 20 });
    expect(post).toHaveBeenCalledWith({ t: "drop", kind: "event:end", dragged: false });
  });

  it("соединительная линия включает инструмент Visio, повторный щелчок возвращает указатель", () => {
    render(<ShapePalette />);
    const b = screen.getByRole("button", { name: "Соединительная линия" });
    fireEvent.click(b);
    expect(post).toHaveBeenLastCalledWith({ t: "tool", tool: "connector" });
    fireEvent.click(b);
    expect(post).toHaveBeenLastCalledWith({ t: "tool", tool: "pointer" });
  });
});
