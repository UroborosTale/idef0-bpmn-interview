import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import NewSessionPage from "./NewSessionPage";

function setup() {
  vi.spyOn(api, "templates").mockResolvedValue([]);
  const onCreated = vi.fn();
  render(<NewSessionPage onCreated={onCreated} />);
  return { onCreated };
}
const create = () => screen.getByRole("button", { name: /Создать|Распознать/ });

describe("новая сессия", () => {
  it("без названия — сообщение, запрос не уходит", () => {
    setup();
    const spy = vi.spyOn(api, "createSession");
    fireEvent.click(create());
    expect(screen.getByText("Укажите название процесса")).toBeTruthy();
    expect(spy).not.toHaveBeenCalled();
  });

  it("режим А: сессия создаётся с введёнными атрибутами", async () => {
    const { onCreated } = setup();
    const spy = vi.spyOn(api, "createSession").mockResolvedValue({ id: "s1" } as never);
    fireEvent.change(screen.getByPlaceholderText(/например, Согласование/), { target: { value: " Закупка " } });
    fireEvent.change(screen.getByPlaceholderText("ФИО или должность"), { target: { value: "Иванов" } });
    fireEvent.change(screen.getByDisplayValue("AS-IS (как есть)"), { target: { value: "TO-BE" } });
    fireEvent.click(create());
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("s1"));
    expect(spy.mock.calls[0][0]).toMatchObject({ mode: "A", meta: { processName: "Закупка", owner: "Иванов", modelType: "TO-BE", confidential: false } });
  });

  it("режим Г: пустая модель создаётся без текста интервью и LLM", async () => {
    const { onCreated } = setup();
    const blank = vi.spyOn(api, "createBlankSession").mockResolvedValue({ id: "s2" } as never);
    const normal = vi.spyOn(api, "createSession");
    fireEvent.click(screen.getByLabelText(/Режим Г/));
    fireEvent.change(screen.getByPlaceholderText(/например, Согласование/), { target: { value: "Найм" } });
    fireEvent.click(screen.getByRole("button", { name: "Создать пустую модель и открыть студию" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("s2"));
    expect(blank.mock.calls[0][0].meta.processName).toBe("Найм");
    expect(normal).not.toHaveBeenCalled();
  });

  it("код процесса приводится к виду B002.00.00 и уходит в meta; неверный код — сообщение без запроса", async () => {
    const { onCreated } = setup();
    const blank = vi.spyOn(api, "createBlankSession").mockResolvedValue({ id: "s3" } as never);
    fireEvent.click(screen.getByLabelText(/Режим Г/));
    fireEvent.change(screen.getByPlaceholderText(/например, Согласование/), { target: { value: "Найм" } });
    fireEvent.change(screen.getByPlaceholderText("например, B002"), { target: { value: "Б2" } });
    fireEvent.click(screen.getByRole("button", { name: "Создать пустую модель и открыть студию" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("s3"));
    expect(blank.mock.calls[0][0].meta.code).toBe("B002.00.00");

    // неверный код: запрос не уходит, показано пояснение
    const bad = vi.spyOn(api, "createBlankSession");
    fireEvent.change(screen.getByPlaceholderText("например, B002"), { target: { value: "D001" } });
    fireEvent.click(screen.getByRole("button", { name: "Создать пустую модель и открыть студию" }));
    await screen.findByText(/Код не по шаблону/);
    expect(bad).not.toHaveBeenCalled();
  });

  it("ошибка сервера показывается и кнопка снова доступна", async () => {
    setup();
    vi.spyOn(api, "createBlankSession").mockRejectedValue(new Error("база недоступна"));
    fireEvent.click(screen.getByLabelText(/Режим Г/));
    fireEvent.change(screen.getByPlaceholderText(/например, Согласование/), { target: { value: "Найм" } });
    fireEvent.click(screen.getByRole("button", { name: /Создать пустую/ }));
    await screen.findByText("база недоступна");
    expect((screen.getByRole("button", { name: /Создать пустую/ }) as HTMLButtonElement).disabled).toBe(false);
  });
});