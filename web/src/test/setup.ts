import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// В jsdom нет части браузерного API, которым пользуются редакторы; поведение браузера здесь не проверяется.
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= NoopResizeObserver as unknown as typeof ResizeObserver;
Element.prototype.scrollTo ??= function () {};
// jsdom не знает PointerEvent и захват указателя: без них fireEvent.pointerDown теряет button/pointerId
if (typeof window.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
    }
  }
  window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
}
Element.prototype.setPointerCapture ??= function () {};
Element.prototype.releasePointerCapture ??= function () {};
Element.prototype.hasPointerCapture ??= () => false;

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});
