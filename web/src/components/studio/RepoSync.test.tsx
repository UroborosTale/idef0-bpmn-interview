import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RepoObject } from "../../api/types";

const obj: RepoObject & { usage: [] } = { id: "o1", class: "data", name: "Заявка", synonyms: [], description: "Исходное", owner: null, kind: "document", created_at: "", updated_at: "", usage: [] };
const getRepositoryObject = vi.fn();
const patchRepositoryObject = vi.fn();
vi.mock("../../api/client", () => ({ api: { getRepositoryObject: (...a: unknown[]) => getRepositoryObject(...a), patchRepositoryObject: (...a: unknown[]) => patchRepositoryObject(...a) } }));

import RepoSync, { repoDiff } from "./RepoSync";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("связь записи с репозиторием", () => {
  it("repoDiff: пустое и отсутствующее значение одинаковы; отличия перечисляются; у систем вид не сравнивается", () => {
    expect(repoDiff({ name: "Заявка", description: "", owner: undefined, kind: "document" }, { name: "Заявка", description: null, owner: null, kind: "document" })).toEqual([]);
    expect(repoDiff({ name: "Заявка v2", description: "Другое", owner: "ИТ", kind: "data" }, obj)).toEqual(["name", "description", "owner", "kind"]);
    expect(repoDiff({ name: "SAP" }, { name: "SAP", description: null, owner: null, kind: "x" })).toEqual([]);
  });

  it("значения совпадают — просто сообщение, без кнопок", async () => {
    getRepositoryObject.mockResolvedValue(obj);
    render(<RepoSync sessionId="s1" repoId="o1" entry={{ name: "Заявка", description: "Исходное", owner: null, kind: "document" }} stamp="t" onTake={() => {}} />);
    await screen.findByText(/Значения совпадают/);
    expect(screen.queryByText("Обновить объект в репозитории")).toBeNull();
  });

  it("запись изменили: показано, что отличается; «Обновить объект» отправляет только изменённые поля и исключает текущую сессию", async () => {
    getRepositoryObject.mockResolvedValue(obj);
    patchRepositoryObject.mockResolvedValue({ object: obj, updated: 2, skipped: 0 });
    render(<RepoSync sessionId="s1" repoId="o1" entry={{ name: "Заявка на закупку", description: "Исходное", owner: "Закупки", kind: "document" }} stamp="t" onTake={() => {}} />);
    await screen.findByText(/Запись отличается/);
    expect(document.querySelector(".repo-diff")!.textContent).toContain("«Заявка» → здесь «Заявка на закупку»");
    fireEvent.click(screen.getByText("Обновить объект в репозитории"));
    await waitFor(() => expect(patchRepositoryObject).toHaveBeenCalled());
    expect(patchRepositoryObject).toHaveBeenCalledWith("o1", { name: "Заявка на закупку", owner: "Закупки" }, true, "s1");
    await screen.findByText(/применены в других процессах: 2/);
  });

  it("«Взять из репозитория» возвращает значения объекта", async () => {
    getRepositoryObject.mockResolvedValue(obj);
    const onTake = vi.fn();
    render(<RepoSync sessionId="s1" repoId="o1" entry={{ name: "Другое", description: "Исходное", owner: null, kind: "document" }} stamp="t" onTake={onTake} />);
    fireEvent.click(await screen.findByText("Взять из репозитория"));
    expect(onTake).toHaveBeenCalledWith({ name: "Заявка" });
  });

  it("объект удалён — предупреждение", async () => {
    getRepositoryObject.mockRejectedValue(new Error("404"));
    render(<RepoSync sessionId="s1" repoId="o1" entry={{ name: "Заявка" }} stamp="t" onTake={() => {}} />);
    await screen.findByText(/Объект репозитория удалён/);
  });
});
