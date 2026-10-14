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
  it("в палитре задача, подпроцесс, три события и два шлюза с подсказками", () => {
    render(<ShapePalette />);
    expect(PALETTE.map((p) => p.kind)).toEqual(["task", "subprocess", "event:start", "event:intermediate", "event:end", "gateway:exclusive", "gateway:parallel"]);
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
});
