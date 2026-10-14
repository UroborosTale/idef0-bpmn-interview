import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { session } from "../../test/fixtures";
import { commit, field } from "../../test/harness";
import type { ProcessLogicModel } from "../../types";
import Studio from "./Studio";

type M = ProcessLogicModel;

const open = (onSave = vi.fn(async (_: M) => true)) => {
  render(<Studio session={session()} busy={false} onSave={onSave} />);
  return onSave;
};
const bar = () => screen.getByRole("toolbar", { name: "Панель инструментов свойств" });
const inBar = (name: string) => [...bar().querySelectorAll("button")].find((b) => b.textContent?.trim() === name || b.getAttribute("aria-label") === name) as HTMLButtonElement;

afterEach(() => vi.restoreAllMocks());

describe("панель инструментов окна свойств", () => {
  it("«Записать правки» неактивна без правок, после правки сохраняет модель", () => {
    const onSave = open();
    expect(inBar("Записать правки").disabled).toBe(true);
    commit(field("Наименование"), "Новое название процесса");
    expect(inBar("Записать правки").disabled).toBe(false);
    fireEvent.click(inBar("Записать правки"));
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("«Перечитать» возвращает сохранённую модель после подтверждения и ничего не делает при отказе", () => {
    open();
    commit(field("Наименование"), "Черновик");
    vi.spyOn(window, "confirm").mockReturnValueOnce(false);
    fireEvent.click(inBar("Перечитать"));
    expect(field("Наименование").value).toBe("Черновик"); // отказ: правка осталась
    vi.spyOn(window, "confirm").mockReturnValueOnce(true);
    fireEvent.click(inBar("Перечитать"));
    expect(field("Наименование").value).not.toBe("Черновик");
    expect(inBar("Записать правки").disabled).toBe(true); // состояние снова «сохранено»
  });

  it("меню «Отчёты» открывает отчёт вкладкой и закрывается", () => {
    open();
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(inBar("Отчёты"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Паспорт процесса" }));
    expect(document.querySelector(".doc-tab.active")!.firstChild!.textContent).toBe("Паспорт процесса");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("меню «Действия»: пункты по выбранной функции недоступны без выбора; щелчок вне меню закрывает его", () => {
    open();
    fireEvent.click(inBar("Действия"));
    expect((screen.getByRole("menuitem", { name: "Дублировать" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("menuitem", { name: "Открыть декомпозицию" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("menuitem", { name: "Найти в навигаторе" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
