import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CommitInput, DraftBanner, Field, RenameOverlay } from "./fields";

describe("поле с фиксацией правки", () => {
  it("значение фиксируется по Enter/потере фокуса одним вызовом", () => {
    const onCommit = vi.fn();
    render(<CommitInput value="старое" onCommit={onCommit} />);
    const input = screen.getByDisplayValue("старое");
    fireEvent.change(input, { target: { value: "н" } });
    fireEvent.change(input, { target: { value: "новое" } });
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith("новое");
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("без изменений ничего не фиксируется; Escape возвращает прежнее", () => {
    const onCommit = vi.fn();
    render(<CommitInput value="x" onCommit={onCommit} />);
    const input = screen.getByDisplayValue("x");
    fireEvent.blur(input);
    fireEvent.change(input, { target: { value: "y" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect((input as HTMLInputElement).value).toBe("x");
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("обязательное поле не принимает пустое значение", () => {
    const onCommit = vi.fn();
    render(<CommitInput required value="Название" onCommit={onCommit} />);
    const input = screen.getByDisplayValue("Название");
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
    expect((input as HTMLInputElement).value).toBe("Название");
  });

  it("значение снаружи (отмена правки) обновляет поле", () => {
    const { rerender } = render(<CommitInput value="a" onCommit={() => {}} />);
    rerender(<CommitInput value="b" onCommit={() => {}} />);
    expect(screen.getByDisplayValue("b")).toBeTruthy();
  });

  it("многострочное поле", () => {
    const onCommit = vi.fn();
    render(<CommitInput multiline rows={2} value="" onCommit={onCommit} />);
    const ta = document.querySelector("textarea")!;
    expect(ta.rows).toBe(2);
    fireEvent.change(ta, { target: { value: "строка 1\nстрока 2" } });
    fireEvent.blur(ta);
    expect(onCommit).toHaveBeenCalledWith("строка 1\nстрока 2");
  });
});

describe("переименование на холсте", () => {
  it("Enter фиксирует обрезанное значение, Escape — отменяет", () => {
    const onCommit = vi.fn();
    const onDone = vi.fn();
    const view = { k: 1, tx: 0, ty: 0 };
    const box = { x: 0, y: 0, w: 100, h: 50 };
    const { unmount } = render(<RenameOverlay name="Задача" box={box} view={view} onCommit={onCommit} onDone={onDone} />);
    const input = screen.getByDisplayValue("Задача");
    fireEvent.change(input, { target: { value: "  Новая  " } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith("Новая");
    unmount();
    onCommit.mockClear();
    render(<RenameOverlay name="Задача" box={box} view={view} onCommit={onCommit} onDone={onDone} />);
    const again = screen.getByDisplayValue("Задача");
    fireEvent.change(again, { target: { value: "Другая" } });
    fireEvent.keyDown(again, { key: "Escape" });
    expect(onCommit).not.toHaveBeenCalled();
  });
});

describe("плашка черновика", () => {
  it("скрыта без черновика, кнопки устаревшего черновика", () => {
    const { container, rerender } = render(<DraftBanner restored={false} stale={false} onDiscard={() => {}} onDismiss={() => {}} />);
    expect(container.textContent).toBe("");
    const apply = vi.fn();
    rerender(<DraftBanner restored={false} stale onDiscard={() => {}} onDismiss={() => {}} onRestoreStale={apply} />);
    fireEvent.click(screen.getByText("Применить черновик"));
    expect(apply).toHaveBeenCalled();
    expect(screen.getByText("Отбросить черновик")).toBeTruthy();
  });

  it("текст не упоминает удалённую связку с Visio", () => {
    render(<DraftBanner restored={false} stale onDiscard={() => {}} onDismiss={() => {}} />);
    expect(document.body.textContent).not.toMatch(/Visio/);
  });
});

describe("подпись поля", () => {
  it("связана с полем ввода: поле находится по подписи, у составного поля — группа с именем", () => {
    render(
      <>
        <Field label="Название">
          <CommitInput value="x" onCommit={() => {}} />
        </Field>
        <Field label="Вид">
          <select>
            <option>a</option>
          </select>
        </Field>
        <Field label="Системы">
          <button>1С</button>
        </Field>
      </>
    );
    expect((screen.getByLabelText("Название") as HTMLInputElement).value).toBe("x");
    expect(screen.getByLabelText("Вид").tagName).toBe("SELECT");
    expect(screen.getByRole("group", { name: "Системы" })).toBeTruthy();
  });

  it("два поля с одинаковой подписью не путаются", () => {
    render(
      <>
        <Field label="Название">
          <input defaultValue="первое" />
        </Field>
        <Field label="Название">
          <input defaultValue="второе" />
        </Field>
      </>
    );
    expect((screen.getAllByLabelText("Название") as HTMLInputElement[]).map((i) => i.value)).toEqual(["первое", "второе"]);
  });
});