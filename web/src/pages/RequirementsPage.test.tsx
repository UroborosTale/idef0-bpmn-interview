import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import RequirementsPage from "./RequirementsPage";

afterEach(() => vi.restoreAllMocks());

function setup() {
  const list = vi.spyOn(api, "listRequirements").mockResolvedValue([]);
  render(<RequirementsPage />);
  return { list };
}

describe("реестр требований: добавление", () => {
  it("источник обязателен и это видно до заполнения", async () => {
    setup();
    await waitFor(() => expect(api.listRequirements).toHaveBeenCalled());
    const source = screen.getByPlaceholderText(/Источник.*обязательно/);
    expect(source.hasAttribute("required")).toBe(true);
    expect(source.getAttribute("aria-required")).toBe("true");
    const add = screen.getByRole("button", { name: "Добавить" }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    expect(screen.getByText(/все три поля обязательны/)).toBeTruthy();
  });

  it("кнопка включается, когда заполнены код, формулировка и источник", async () => {
    setup();
    await waitFor(() => expect(api.listRequirements).toHaveBeenCalled());
    fireEvent.change(screen.getByPlaceholderText(/^Код/), { target: { value: "ISO9001-4.4.1.a" } });
    fireEvent.change(screen.getByPlaceholderText(/^Краткая формулировка/), { target: { value: "Процессы и их взаимодействие" } });
    const add = screen.getByRole("button", { name: "Добавить" }) as HTMLButtonElement;
    expect(add.disabled).toBe(true); // источника ещё нет
    fireEvent.change(screen.getByPlaceholderText(/^Источник/), { target: { value: "ISO 9001" } });
    expect(add.disabled).toBe(false);
    expect(screen.queryByText(/все три поля обязательны/)).toBeNull();
  });
});
