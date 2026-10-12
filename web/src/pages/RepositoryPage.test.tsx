import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, type RepoListItem } from "../api/client";
import RepositoryPage from "./RepositoryPage";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const obj = (id: string, name: string, extra: Partial<RepoListItem> = {}): RepoListItem => ({
  id,
  class: "role",
  name,
  synonyms: [],
  description: null,
  owner: null,
  kind: "internal",
  created_at: "",
  updated_at: "",
  sessions: 0,
  entries: 0,
  uses: 0,
  ...extra,
});

const ROWS = [obj("o1", "Начальник отдела", { sessions: 2, entries: 2, uses: 5 }), obj("o2", "Руководитель отдела", { synonyms: ["Руководитель"], sessions: 1, entries: 1 }), obj("o3", "Секретарь")];

async function setup(rows = ROWS) {
  vi.spyOn(api, "listRepository").mockResolvedValue(rows);
  render(<RepositoryPage />);
  await screen.findByDisplayValue("Начальник отдела");
}
const rowOf = (name: string) => screen.getByDisplayValue(name).closest("tr") as HTMLElement;
const dialog = () => screen.getByRole("dialog");

describe("репозиторий: слияние и удаление через диалог", () => {
  it("слияние: окно со списком других объектов и пояснением, подтверждение недоступно без выбора", async () => {
    await setup();
    fireEvent.click(within(rowOf("Начальник отдела")).getByTitle("Объединить с другим объектом (дубли)"));
    const d = dialog();
    expect(within(d).getByText("Объединить «Начальник отдела» с…")).toBeTruthy();
    // сам объект в списке не предлагается; у вариантов видны синонимы и использование
    expect(within(d).queryByText("Начальник отдела", { selector: "b" })).toBeNull();
    expect(within(d).getByText(/синонимы: Руководитель · используется в 1 проц\./)).toBeTruthy();
    const confirm = within(d).getByRole("button", { name: "Объединить" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(within(d).getByText("Руководитель отдела"));
    expect(confirm.disabled).toBe(false);
    expect(within(d).getByText(/станет синонимом/).textContent).toMatch(/«Начальник отдела» станет синонимом «Руководитель отдела»\. Записи в 2 проц\./);
  });

  it("подтверждённое слияние уходит на сервер, окно закрывается, результат показан", async () => {
    await setup();
    const merge = vi.spyOn(api, "mergeRepositoryObject").mockResolvedValue({ object: ROWS[1], relinked: 2, skipped: 1 });
    fireEvent.click(within(rowOf("Начальник отдела")).getByTitle("Объединить с другим объектом (дубли)"));
    fireEvent.click(within(dialog()).getByText("Руководитель отдела"));
    fireEvent.click(within(dialog()).getByRole("button", { name: "Объединить" }));
    await waitFor(() => expect(merge).toHaveBeenCalledWith("o1", "o2"));
    expect(screen.queryByRole("dialog")).toBeNull();
    await screen.findByText(/Объединено с «Руководитель отдела»\. Записей перенесено: 2; утверждённых версий не менялось: 1\./);
  });

  it("поиск по списку, Esc и «Отмена» закрывают окно без действий", async () => {
    await setup();
    const merge = vi.spyOn(api, "mergeRepositoryObject");
    fireEvent.click(within(rowOf("Начальник отдела")).getByTitle("Объединить с другим объектом (дубли)"));
    fireEvent.change(within(dialog()).getByPlaceholderText("Поиск…"), { target: { value: "секрет" } });
    expect(within(dialog()).queryByText("Руководитель отдела")).toBeNull();
    expect(within(dialog()).getByText("Секретарь")).toBeTruthy();
    fireEvent.keyDown(dialog(), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(within(rowOf("Начальник отдела")).getByTitle("Объединить с другим объектом (дубли)"));
    fireEvent.click(within(dialog()).getByRole("button", { name: "Отмена" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(merge).not.toHaveBeenCalled();
  });

  it("используемый объект удаляется только с заменой: окно предлагает замену и сообщает, что будет", async () => {
    await setup();
    const del = vi.spyOn(api, "deleteRepositoryObject").mockResolvedValue(undefined as never);
    fireEvent.click(within(rowOf("Начальник отдела")).getByTitle("Удалить"));
    const d = dialog();
    expect(within(d).getByText("Заменить «Начальник отдела» на…")).toBeTruthy();
    expect(within(d).getByText(/используется в 2 проц\., поэтому удалить его можно только с заменой/)).toBeTruthy();
    fireEvent.click(within(d).getByText("Секретарь"));
    expect(within(d).getByText(/будет удалён, его название станет синонимом «Секретарь»/)).toBeTruthy();
    fireEvent.click(within(d).getByRole("button", { name: "Заменить и удалить" }));
    await waitFor(() => expect(del).toHaveBeenCalledWith("o1", "o3"));
    await screen.findByText("Объект заменён на «Секретарь» и удалён.");
  });

  it("неиспользуемый объект — простое подтверждение, фокус на «Отмена»", async () => {
    await setup();
    const del = vi.spyOn(api, "deleteRepositoryObject").mockResolvedValue(undefined as never);
    fireEvent.click(within(rowOf("Секретарь")).getByTitle("Удалить"));
    const d = dialog();
    expect(within(d).getByText(/Удалить «Секретарь» из репозитория\? Объект нигде не используется\./)).toBeTruthy();
    expect(document.activeElement).toBe(within(d).getByRole("button", { name: "Отмена" }));
    fireEvent.click(within(d).getByRole("button", { name: "Удалить" }));
    await waitFor(() => expect(del).toHaveBeenCalledWith("o3"));
    await screen.findByText("Объект удалён.");
  });

  it("единственный объект: заменить нечем — окно объясняет, что делать", async () => {
    await setup([obj("o1", "Начальник отдела", { sessions: 1, entries: 1 })]);
    fireEvent.click(within(rowOf("Начальник отдела")).getByTitle("Удалить"));
    expect(within(dialog()).getByText(/Нет другого объекта этого класса/)).toBeTruthy();
    expect((within(dialog()).getByRole("button", { name: "Заменить и удалить" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
