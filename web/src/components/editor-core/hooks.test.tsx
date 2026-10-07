import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HISTORY_LIMIT, handleCommonKeys, isTextInput, useDraftPersistence, useModelHistory } from "./hooks";

afterEach(() => vi.useRealTimers());

describe("история правок", () => {
  it("commit, undo, redo и признак несохранённых изменений", () => {
    const { result } = renderHook(() => useModelHistory(() => ({ v: 0 })));
    const a = { v: 1 };
    act(() => void result.current.commit(a));
    expect(result.current.draft).toBe(a);
    expect(result.current.dirty).toBe(true);
    act(() => result.current.undo());
    expect(result.current.draft.v).toBe(0);
    expect(result.current.dirty).toBe(false); // откат к сохранённой версии снимает пометку
    expect(result.current.canRedo).toBe(true);
    act(() => result.current.redo());
    expect(result.current.draft).toBe(a);
  });

  it("повторный commit той же модели не создаёт шаг истории", () => {
    const { result } = renderHook(() => useModelHistory(() => ({ v: 0 })));
    let changed = true;
    act(() => {
      changed = result.current.commit(result.current.draft);
    });
    expect(changed).toBe(false);
    expect(result.current.canUndo).toBe(false);
  });

  it("новая правка после отмены очищает «повторить»", () => {
    const { result } = renderHook(() => useModelHistory(() => ({ v: 0 })));
    act(() => void result.current.commit({ v: 1 }));
    act(() => result.current.undo());
    act(() => void result.current.commit({ v: 2 }));
    expect(result.current.canRedo).toBe(false);
  });

  it("сохранение и «отбросить правки»", () => {
    const { result } = renderHook(() => useModelHistory(() => ({ v: 0 })));
    const saved = { v: 1 };
    act(() => void result.current.commit(saved));
    act(() => result.current.markSaved(saved));
    expect(result.current.dirty).toBe(false);
    act(() => void result.current.commit({ v: 2 }));
    act(() => result.current.discard());
    expect(result.current.draft).toBe(saved);
    expect(result.current.canUndo).toBe(false);
  });

  it(`глубина истории ограничена (${HISTORY_LIMIT} шагов)`, () => {
    const { result } = renderHook(() => useModelHistory(() => ({ v: 0 })));
    for (let i = 1; i <= HISTORY_LIMIT + 20; i++) act(() => void result.current.commit({ v: i }));
    let undone = 0;
    while (result.current.canUndo) {
      act(() => result.current.undo());
      undone++;
    }
    expect(undone).toBe(HISTORY_LIMIT);
  });
});

describe("черновик в localStorage", () => {
  const key = "process-editor-draft:s1:studio";

  it("несохранённые правки записываются с задержкой и удаляются после сохранения", () => {
    vi.useFakeTimers();
    const { rerender } = renderHook((p: { draft: object; dirty: boolean }) => useDraftPersistence({ id: "s1:studio", base: "t1", draft: p.draft, dirty: p.dirty, restore: () => {} }), {
      initialProps: { draft: { v: 0 }, dirty: false },
    });
    rerender({ draft: { v: 1 }, dirty: true });
    expect(localStorage.getItem(key)).toBeNull();
    act(() => void vi.advanceTimersByTime(300));
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual({ base: "t1", model: { v: 1 } });
    rerender({ draft: { v: 1 }, dirty: false });
    act(() => void vi.advanceTimersByTime(300));
    expect(localStorage.getItem(key)).toBeNull();
  });

  it("черновик той же версии модели восстанавливается сам", () => {
    localStorage.setItem(key, JSON.stringify({ base: "t1", model: { v: 5 } }));
    const restore = vi.fn();
    const { result } = renderHook(() => useDraftPersistence({ id: "s1:studio", base: "t1", draft: { v: 0 }, dirty: true, restore }));
    expect(restore).toHaveBeenCalledWith({ v: 5 });
    expect(result.current.restored).toBe(true);
  });

  it("устаревший черновик не применяется без подтверждения", () => {
    localStorage.setItem(key, JSON.stringify({ base: "old", model: { v: 5 } }));
    const restore = vi.fn();
    const { result } = renderHook(() => useDraftPersistence({ id: "s1:studio", base: "new", draft: { v: 0 }, dirty: false, restore }));
    expect(restore).not.toHaveBeenCalled();
    expect(result.current.stale).toBe(true);
    act(() => result.current.restoreStale());
    expect(restore).toHaveBeenCalledWith({ v: 5 });
    expect(result.current.stale).toBe(false);
  });

  it("отключённое сохранение (редактор внутри студии) хранилище не трогает", () => {
    localStorage.setItem(key, JSON.stringify({ base: "t1", model: { v: 5 } }));
    const restore = vi.fn();
    renderHook(() => useDraftPersistence({ id: "s1:studio", base: "t1", draft: { v: 0 }, dirty: true, restore, enabled: false }));
    expect(restore).not.toHaveBeenCalled();
  });

  it("повреждённый черновик игнорируется", () => {
    localStorage.setItem(key, "{не json");
    const restore = vi.fn();
    expect(() => renderHook(() => useDraftPersistence({ id: "s1:studio", base: "t1", draft: {}, dirty: false, restore }))).not.toThrow();
    expect(restore).not.toHaveBeenCalled();
  });
});

describe("клавиши редакторов", () => {
  const ev = (key: string, mods: Partial<KeyboardEvent> = {}) => ({ key, ctrlKey: false, metaKey: false, shiftKey: false, preventDefault: vi.fn(), ...mods }) as unknown as React.KeyboardEvent;

  it("Ctrl+Z, Ctrl+Shift+Z, Ctrl+Y, Ctrl+S (и ⌘ на Mac)", () => {
    const a = { undo: vi.fn(), redo: vi.fn(), save: vi.fn() };
    expect(handleCommonKeys(ev("z", { ctrlKey: true }), a)).toBe(true);
    expect(handleCommonKeys(ev("Z", { ctrlKey: true, shiftKey: true }), a)).toBe(true);
    expect(handleCommonKeys(ev("y", { metaKey: true }), a)).toBe(true);
    expect(handleCommonKeys(ev("s", { ctrlKey: true }), a)).toBe(true);
    expect(handleCommonKeys(ev("s"), a)).toBe(false);
    expect([a.undo.mock.calls.length, a.redo.mock.calls.length, a.save.mock.calls.length]).toEqual([1, 2, 1]);
  });

  it("русская раскладка: Ctrl+Я и Ctrl+Ы тоже отменяют и сохраняют", () => {
    const a = { undo: vi.fn(), redo: vi.fn(), save: vi.fn() };
    handleCommonKeys(ev("я", { ctrlKey: true, code: "KeyZ" } as never), a);
    handleCommonKeys(ev("ы", { ctrlKey: true, code: "KeyS" } as never), a);
    expect(a.undo).toHaveBeenCalledTimes(1);
    expect(a.save).toHaveBeenCalledTimes(1);
  });

  it("текстовые поля распознаются", () => {
    expect(isTextInput(document.createElement("input"))).toBe(true);
    expect(isTextInput(document.createElement("select"))).toBe(true);
    expect(isTextInput(document.createElement("div"))).toBe(false);
    expect(isTextInput(null)).toBe(false);
  });
});
