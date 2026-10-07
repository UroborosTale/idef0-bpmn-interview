import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, type Proposal } from "../../api/client";
import { session, structuredModel } from "../../test/fixtures";
import type { ProcessLogicModel } from "../../types";
import ProposalsList from "./ProposalsList";
import Studio from "./Studio";

type M = ProcessLogicModel;

const proposal = (extra: Partial<Proposal> = {}): Proposal => ({
  id: "prop_1",
  sessionId: "s1",
  agent: "моделист",
  title: "Добавить шаг проверки реестра",
  rationale: "Фрагмент 3: «специалист проверяет реестр»",
  patch: { ops: [{ op: "add", collection: "nodes", value: { id: "n1", type: "task", name: "Проверить реестр", bpmn_scope: "o1", role_id: "r2" } }] },
  delta: { introduced: [], resolved: [] },
  status: "pending",
  reason: null,
  createdAt: "2026-10-07T10:00:00.000Z",
  stale: false,
  ...extra,
});

afterEach(() => vi.restoreAllMocks());

describe("предложения агентов: список", () => {
  const list = (proposals: Proposal[], model: M = structuredModel()) => {
    const onApply = vi.fn();
    const onReject = vi.fn();
    render(<ProposalsList model={model} proposals={proposals} onApply={onApply} onReject={onReject} />);
    return { onApply, onReject };
  };

  it("без предложений — подсказка, откуда они берутся", () => {
    list([]);
    expect(screen.getByText(/Агент \(Cline\) присылает правки через MCP-сервер/)).toBeTruthy();
  });

  it("карточка: название, агент, обоснование, правки по-русски, влияние на проверки", () => {
    const op = proposal({
      patch: { ops: [{ op: "update", collection: "nodes", id: "o2", patch: { role_id: "r2" } }] },
      title: "Назначить исполнителя",
    });
    list([op]);
    expect(screen.getByText("Назначить исполнителя")).toBeTruthy();
    expect(document.querySelector(".agent-badge")!.textContent).toBe("моделист");
    expect(screen.getByText(/специалист проверяет реестр/)).toBeTruthy();
    expect(screen.getByText(/Изменить шаг B002\.01\.02 «Проведение интервью»: исполнитель → r2/)).toBeTruthy();
    // у o2 нет исполнителя — предложение снимает это замечание и ничего не вносит
    expect(screen.getByText("снимает замечаний: 1")).toBeTruthy();
    expect(screen.getByText("вносит новых: 0")).toBeTruthy();
    expect((screen.getByText("Применить") as HTMLButtonElement).disabled).toBe(false);
  });

  it("предложение, которое вносит новые замечания, показывает их", () => {
    list([proposal({ patch: { ops: [{ op: "update", collection: "nodes", id: "b0", patch: { name: "Пункт протокола" } }] } })]);
    expect(screen.getByText("вносит новых: 1").getAttribute("title")).toMatch(/нужно сформулировать как факт/);
  });

  it("неприменимое к черновику: причины, «Применить» недоступно", () => {
    list([proposal({ patch: { ops: [{ op: "update", collection: "nodes", id: "нет", patch: { name: "Х" } }] } })]);
    expect(screen.getByText(/Нельзя применить к текущему черновику/)).toBeTruthy();
    expect(screen.getByText(/шаг «нет» не найден/)).toBeTruthy();
    expect((screen.getByText("Применить") as HTMLButtonElement).disabled).toBe(true);
  });

  it("метка «модель изменилась» у устаревших предложений", () => {
    list([proposal({ stale: true })]);
    expect(screen.getByText("модель изменилась")).toBeTruthy();
  });

  it("применить и отклонить с причиной", async () => {
    const { onApply, onReject } = list([proposal()]);
    await act(async () => fireEvent.click(screen.getByText("Применить")));
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ id: "prop_1" }));
    fireEvent.click(screen.getByText("Отклонить…"));
    fireEvent.change(screen.getByPlaceholderText("Почему отклоняете — агент это увидит"), { target: { value: "  Шаг уже есть  " } });
    await act(async () => fireEvent.click(screen.getByText("Отклонить")));
    expect(onReject).toHaveBeenCalledWith(expect.objectContaining({ id: "prop_1" }), "Шаг уже есть");
    fireEvent.click(screen.getByText("Отмена"));
    expect(screen.getByText("Отклонить…")).toBeTruthy();
  });
});

describe("студия: предложения агентов", () => {
  const open = (proposals: Proposal[]) => {
    vi.spyOn(api, "listProposals").mockResolvedValue(proposals);
    const resolve = vi.spyOn(api, "resolveProposal").mockResolvedValue(proposal());
    const onSave = vi.fn(async (_: M) => true);
    render(<Studio session={session(structuredModel())} busy={false} onSave={onSave} />);
    return { resolve, onSave };
  };
  const ribbon = () => [...document.querySelectorAll(".ribbon-buttons button")].find((b) => b.textContent?.startsWith("Предложения")) as HTMLElement;

  it("счётчик на кнопке ленты; нажатие открывает вкладку предложений", async () => {
    open([proposal()]);
    await waitFor(() => expect(ribbon().textContent).toBe("Предложения (1)"));
    expect(ribbon().className).toContain("attention");
    fireEvent.click(ribbon());
    expect(document.querySelector(".problems-head .active")!.textContent).toContain("Предложения агентов");
    expect(screen.getByText("Добавить шаг проверки реестра")).toBeTruthy();
  });

  it("без предложений кнопка спокойная, а сбой связи не мешает работе", async () => {
    vi.spyOn(api, "listProposals").mockRejectedValue(new Error("нет связи"));
    render(<Studio session={session(structuredModel())} busy={false} onSave={vi.fn(async () => true)} />);
    await act(async () => {});
    expect(ribbon().textContent).toBe("Предложения");
    expect(ribbon().className).not.toContain("attention");
    expect(document.querySelector(".studio")).toBeTruthy();
  });

  it("«Применить» кладёт правки в черновик (шагом истории), отмечает решение; сохраняет аналитик", async () => {
    const { resolve, onSave } = open([proposal()]);
    await waitFor(() => expect(ribbon().textContent).toBe("Предложения (1)"));
    fireEvent.click(ribbon());
    await act(async () => fireEvent.click(screen.getByText("Применить")));
    expect(resolve).toHaveBeenCalledWith("prop_1", { status: "applied" });
    expect(document.querySelector(".statusbar")!.textContent).toContain("есть несохранённые изменения");
    // правки можно отменить, как любые другие
    fireEvent.click(screen.getByTitle("Отменить (Ctrl+Z)"));
    expect(document.querySelector(".statusbar")!.textContent).toContain("сохранено");
    fireEvent.click(screen.getByTitle("Повторить (Ctrl+Y)"));
    await act(async () => fireEvent.click(screen.getByTitle("Сохранить (Ctrl+S)")));
    const saved = onSave.mock.calls[0][0];
    expect(saved.nodes.find((n) => n.id === "n1")).toMatchObject({ name: "Проверить реестр", bpmn_scope: "o1", status: "hypothesis" });
    // у нового шага появилась позиция на диаграмме
    expect(saved.nodes.find((n) => n.id === "n1")!.layout).toBeTruthy();
  });

  it("«Отклонить» передаёт причину агенту", async () => {
    const { resolve } = open([proposal()]);
    await waitFor(() => expect(ribbon().textContent).toBe("Предложения (1)"));
    fireEvent.click(ribbon());
    fireEvent.click(screen.getByText("Отклонить…"));
    fireEvent.change(screen.getByPlaceholderText("Почему отклоняете — агент это увидит"), { target: { value: "Шаг уже есть" } });
    await act(async () => fireEvent.click(screen.getByText("Отклонить")));
    expect(resolve).toHaveBeenCalledWith("prop_1", { status: "rejected", reason: "Шаг уже есть" });
    expect(document.querySelector(".statusbar")!.textContent).toContain("сохранено"); // модель не менялась
  });
});
