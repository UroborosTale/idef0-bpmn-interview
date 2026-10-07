import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { api, type RegistryProcess } from "../api/client";
import RegistryPage from "./RegistryPage";

const row = (id: string, name: string, extra: Partial<RegistryProcess> = {}): RegistryProcess => ({
  id,
  code: null,
  name,
  level: "L1",
  parent_process_id: null,
  classification: "main",
  owner: null,
  department: null,
  status: "draft",
  version: "0.1",
  review_date: null,
  session_id: null,
  created_at: "2026-10-01T10:00:00Z",
  updated_at: "2026-10-01T10:00:00Z",
  ...extra,
});

function setup(rows: RegistryProcess[] = [row("p1", "Закупка", { code: "P-001", owner: "Иванов", department: "Снабжение" }), row("p2", "Продажа", { status: "approved", classification: "support" })]) {
  const list = vi.spyOn(api, "listRegistry").mockResolvedValue(rows);
  vi.spyOn(api, "listSessions").mockResolvedValue([{ id: "s1", title: "Сессия закупки" } as never]);
  render(<RegistryPage />);
  return { list };
}

const rowOf = (name: string) => screen.getByText(name).closest("tr") as HTMLElement;

describe("реестр процессов", () => {
  it("список: код, название, уровень, класс, владелец, подразделение, статус", async () => {
    setup();
    await screen.findByText("Закупка");
    expect(rowOf("Закупка").textContent).toMatch(/P-001.*Закупка.*L1.*Основной.*Иванов.*Снабжение/);
    expect((within(rowOf("Закупка")).getByRole("combobox") as HTMLSelectElement).value).toBe("draft");
    expect(rowOf("Продажа").textContent).toMatch(/Обеспечивающий/);
  });

  it("пустой реестр", async () => {
    setup([]);
    await screen.findByText("Реестр пуст.");
  });

  it("фильтры уходят на сервер, пустой фильтр снимается", async () => {
    const { list } = setup();
    await screen.findByText("Закупка");
    fireEvent.change(screen.getByPlaceholderText("Поиск по названию/коду"), { target: { value: "закуп" } });
    await waitFor(() => expect(list).toHaveBeenLastCalledWith({ q: "закуп" }));
    fireEvent.change(screen.getByDisplayValue("Все статусы"), { target: { value: "approved" } });
    await waitFor(() => expect(list).toHaveBeenLastCalledWith({ q: "закуп", status: "approved" }));
    fireEvent.change(screen.getByPlaceholderText("Поиск по названию/коду"), { target: { value: "" } });
    await waitFor(() => expect(list).toHaveBeenLastCalledWith({ status: "approved" }));
  });

  it("смена статуса записывается и список перечитывается", async () => {
    const { list } = setup();
    const patch = vi.spyOn(api, "patchRegistryProcess").mockResolvedValue(row("p1", "Закупка") as never);
    await screen.findByText("Закупка");
    const calls = list.mock.calls.length;
    fireEvent.change(within(rowOf("Закупка")).getByRole("combobox"), { target: { value: "review" } });
    await waitFor(() => expect(patch).toHaveBeenCalledWith("p1", { status: "review" }));
    await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(calls));
  });

  it("удаление только после подтверждения", async () => {
    setup();
    const del = vi.spyOn(api, "deleteRegistryProcess").mockResolvedValue(undefined as never);
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    await screen.findByText("Закупка");
    fireEvent.click(within(rowOf("Закупка")).getByText("✕"));
    expect(del).not.toHaveBeenCalled();
    fireEvent.click(within(rowOf("Закупка")).getByText("✕"));
    await waitFor(() => expect(del).toHaveBeenCalledWith("p1"));
    expect(confirm.mock.calls[1][0]).toMatch(/«Закупка»/);
  });

  it("новый процесс: без названия кнопка неактивна; создаётся с введёнными полями", async () => {
    setup();
    const create = vi.spyOn(api, "createRegistryProcess").mockResolvedValue(row("p3", "Найм") as never);
    await screen.findByText("Закупка");
    fireEvent.click(screen.getByText("+ Добавить процесс"));
    const form = screen.getByText("Название*").closest(".card") as HTMLElement;
    const submit = form.querySelector("button.primary") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Название*"), { target: { value: "Найм" } });
    fireEvent.change(screen.getByLabelText("Код"), { target: { value: "P-777" } });
    fireEvent.change(screen.getByLabelText("Классификация"), { target: { value: "management" } });
    fireEvent.change(screen.getByLabelText("Связанная модель (сессия)"), { target: { value: "s1" } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({ name: "Найм", code: "P-777", level: "L2", classification: "management", owner: null, department: null, session_id: "s1" })
    );
    await waitFor(() => expect(screen.queryByText("Название*")).toBeNull()); // форма закрылась
  });

  it("вкладка «Связи и разрывы» загружает связи, предложения и разрывы", async () => {
    setup();
    const links = vi.spyOn(api, "listProcessLinks").mockResolvedValue([{ id: "l1", from_process_id: "p1", to_process_id: "p2", data_label: "счёт", confirmed: false }] as never);
    vi.spyOn(api, "suggestProcessLinks").mockResolvedValue([]);
    vi.spyOn(api, "processLinkGaps").mockResolvedValue([]);
    const confirmLink = vi.spyOn(api, "confirmProcessLink").mockResolvedValue(undefined as never);
    await screen.findByText("Закупка");
    fireEvent.click(screen.getByText("Связи и разрывы"));
    await screen.findByText(/Закупка → Продажа \(счёт\)/);
    expect(links).toHaveBeenCalled();
    fireEvent.click(screen.getByText("Подтвердить"));
    await waitFor(() => expect(confirmLink).toHaveBeenCalledWith("l1"));
  });
});
