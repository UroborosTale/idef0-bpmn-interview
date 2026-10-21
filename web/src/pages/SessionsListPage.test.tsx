import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import SessionsListPage from "./SessionsListPage";

const row = {
  id: "s1",
  title: "Закупка",
  mode: "A" as const,
  status: "ready" as const,
  meta: { processName: "Закупка", modelType: "AS-IS" as const, decompositionDepth: 2, notations: ["IDEF0", "BPMN"] as const },
  updatedAt: "2026-10-01T10:00:00Z",
  gapsOpen: 0,
  hasErrors: false,
  diagramsStale: false,
};

describe("список сессий: удаление", () => {
  beforeEach(() => {
    vi.spyOn(api, "listSessions").mockResolvedValue([row as never]);
    vi.spyOn(api, "deleteSession").mockResolvedValue(undefined);
  });

  it("спрашивает подтверждение в диалоге приложения, отмена ничего не удаляет", async () => {
    render(<SessionsListPage onOpen={vi.fn()} onCreateNew={vi.fn()} />);
    await screen.findByText("Закупка");
    fireEvent.click(screen.getByText("Удалить"));
    const dialog = screen.getByRole("dialog", { name: "Удалить сессию" });
    expect(within(dialog).getByText(/безвозвратно/)).toBeTruthy();
    fireEvent.click(within(dialog).getByText("Отмена"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(api.deleteSession).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Удалить"));
    fireEvent.click(within(screen.getByRole("dialog")).getByText("Удалить"));
    await waitFor(() => expect(api.deleteSession).toHaveBeenCalledWith("s1"));
  });
});
