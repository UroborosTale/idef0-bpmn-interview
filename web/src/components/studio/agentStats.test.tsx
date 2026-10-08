import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, type AgentRoleStats, type AgentStatsReport } from "../../api/client";
import { session, structuredModel } from "../../test/fixtures";
import AgentStatsPanel, { statsHints } from "./AgentStatsPanel";
import Studio from "./Studio";

const role = (name: string, extra: Partial<AgentRoleStats["proposals"]> = {}, rest: Partial<AgentRoleStats> = {}): AgentRoleStats => ({
  role: name,
  proposals: { total: 0, pending: 0, applied: 0, rejected: 0, acceptance: null, introduced: 0, resolved: 0, topReasons: [], ...extra },
  tasks: { taken: 0, done: 0, created: 0 },
  questions: { added: 0, asked: 0, answered: 0, dismissed: 0 },
  reports: { total: 0, unread: 0, findings: 0, highImpact: 0 },
  ...rest,
});

afterEach(() => vi.restoreAllMocks());

describe("подсказки по инструкциям ролей", () => {
  it("мало решений и нормальные цифры — подсказок нет", () => {
    expect(statsHints([role("моделист", { total: 3, applied: 2, rejected: 1, acceptance: 2 / 3 })])).toEqual([]);
  });

  it("принято меньше половины при пяти и более решениях", () => {
    const h = statsHints([role("моделист", { total: 6, applied: 2, rejected: 4, acceptance: 1 / 3 })]);
    expect(h).toHaveLength(1);
    expect(h[0]).toContain("принято меньше половины");
    expect(h[0]).toContain("2 из 6");
    expect(statsHints([role("моделист", { total: 4, applied: 1, rejected: 3, acceptance: 0.25 })])).toEqual([]); // меньше пяти решений — рано судить
  });

  it("вносят больше замечаний, чем снимают; копятся ожидающие; повторяется причина отказа", () => {
    const h = statsHints([role("нормоконтролёр", { total: 12, pending: 11, introduced: 7, resolved: 2, topReasons: [{ reason: "Нет цитаты", count: 3 }] })]);
    expect(h.join("\n")).toContain("7 против 2");
    expect(h.join("\n")).toContain("11 предложений ждут решения");
    expect(h.join("\n")).toContain("«Нет цитаты»");
  });

  it("вопросы интервьюера, в основном снятые без ответа", () => {
    const h = statsHints([role("интервьюер", {}, { questions: { added: 6, asked: 0, answered: 0, dismissed: 4 } })]);
    expect(h[0]).toContain("4 из 6");
  });
});

describe("вкладка «Агенты»", () => {
  const report: AgentStatsReport = {
    scope: "session",
    roles: [
      role("моделист", { total: 6, pending: 1, applied: 2, rejected: 3, acceptance: 0.4, introduced: 1, resolved: 4, topReasons: [{ reason: "Нет цитаты в интервью", count: 2 }] }, { tasks: { taken: 2, done: 1, created: 1 } }),
      role("аналитик", {}, { reports: { total: 1, unread: 1, findings: 4, highImpact: 1 } }),
    ],
  };

  it("таблица по ролям, частые причины отказа и подсказки; переключатель «по всем сессиям» перезапрашивает сводку", async () => {
    const spy = vi.spyOn(api, "agentStats").mockResolvedValue(report);
    render(<AgentStatsPanel sessionId="s1" />);
    await waitFor(() => expect(document.querySelector('tr[data-role="моделист"]')).toBeTruthy());
    expect(spy).toHaveBeenCalledWith("s1", false);
    const cells = [...document.querySelector('tr[data-role="моделист"]')!.querySelectorAll("td")].map((c) => c.textContent);
    expect(cells).toEqual(["моделист", "6", "1", "2", "3", "40%", "1", "4", "2", "1", "0", "0", "0", "0", "0"]);
    expect([...document.querySelector('tr[data-role="аналитик"]')!.querySelectorAll("td")].map((c) => c.textContent).slice(-2)).toEqual(["1", "4"]);
    expect(screen.getByText("Нет цитаты в интервью")).toBeTruthy();
    expect(screen.getByText("Частые причины отказа")).toBeTruthy();
    expect(screen.getByLabelText("Что стоит поправить в инструкциях").textContent).toContain("Нет цитаты в интервью");
    fireEvent.click(screen.getByLabelText("по всем сессиям"));
    await waitFor(() => expect(spy).toHaveBeenLastCalledWith("s1", true));
    expect(screen.getByText(/по всем сессиям/, { selector: "span.muted" })).toBeTruthy();
    fireEvent.click(screen.getByText("Обновить"));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(3));
  });

  it("агенты ничего не присылали — подсказка; сбой запроса показывается текстом", async () => {
    vi.spyOn(api, "agentStats").mockResolvedValueOnce({ scope: "session", roles: [] });
    const { unmount } = render(<AgentStatsPanel sessionId="s1" />);
    expect(await screen.findByText(/Агенты пока ничего не присылали/)).toBeTruthy();
    unmount();
    vi.spyOn(api, "agentStats").mockRejectedValueOnce(new Error("нет связи"));
    render(<AgentStatsPanel sessionId="s1" />);
    expect(await screen.findByText(/Не удалось получить сводку: нет связи/)).toBeTruthy();
  });
});

describe("студия: конфиденциальная сессия — доступ агентов решает аналитик", () => {
  const open = (meta: Record<string, unknown>) => {
    vi.spyOn(api, "listProposals").mockResolvedValue([]);
    vi.spyOn(api, "listTasks").mockResolvedValue([]);
    vi.spyOn(api, "listQuestions").mockResolvedValue([]);
    vi.spyOn(api, "listReports").mockResolvedValue([]);
    vi.spyOn(api, "agentStats").mockResolvedValue({ scope: "session", roles: [] });
    const s = session(structuredModel());
    s.meta = { ...s.meta, ...meta } as typeof s.meta;
    const patch = vi.spyOn(api, "patchSession").mockResolvedValue(s);
    render(<Studio session={s} busy={false} onSave={vi.fn(async () => true)} />);
    const tab = (name: string) => [...document.querySelectorAll(".problems-head button")].find((b) => b.textContent?.startsWith(name)) as HTMLElement;
    return { patch, tab, s };
  };

  it("обычная сессия: полосы доступа нет", async () => {
    const { tab } = open({});
    await act(async () => {});
    fireEvent.click(tab("Задания агенту"));
    expect(document.querySelector("[data-agent-access]")).toBeNull();
  });

  it("конфиденциальная: по умолчанию закрыта; разрешение требует подтверждения и сохраняется в мете; закрыть можно без вопросов", async () => {
    const { patch, tab, s } = open({ confidential: true });
    await act(async () => {});
    fireEvent.click(tab("Вопросы"));
    const bar = () => document.querySelector("[data-agent-access]") as HTMLElement;
    expect(bar().className).toContain("denied");
    expect(bar().textContent).toContain("доступа не имеют");
    // отказ в подтверждении ничего не меняет
    vi.spyOn(window, "confirm").mockReturnValueOnce(false);
    fireEvent.click(screen.getByText("Разрешить доступ агентам"));
    expect(patch).not.toHaveBeenCalled();
    vi.spyOn(window, "confirm").mockReturnValueOnce(true);
    fireEvent.click(screen.getByText("Разрешить доступ агентам"));
    await waitFor(() => expect(patch).toHaveBeenCalledWith(s.id, { meta: expect.objectContaining({ confidential: true, agentAccess: true }) }));
    await waitFor(() => expect(bar().className).toContain("allowed"));
    // полоса видна на вкладках агентов и не видна на проверках
    fireEvent.click(tab("Агенты"));
    expect(bar()).toBeTruthy();
    fireEvent.click(tab("Проверки"));
    expect(document.querySelector("[data-agent-access]")).toBeNull();
    fireEvent.click(tab("Отчёты"));
    fireEvent.click(screen.getByText("Закрыть доступ"));
    await waitFor(() => expect(patch).toHaveBeenLastCalledWith(s.id, { meta: expect.objectContaining({ agentAccess: false }) }));
    await waitFor(() => expect(bar().className).toContain("denied"));
  });

  it("уже разрешённая ранее сессия сразу показывает «доступ есть»", async () => {
    const { tab } = open({ confidential: true, agentAccess: true });
    await act(async () => {});
    fireEvent.click(tab("Предложения агентов"));
    expect((document.querySelector("[data-agent-access]") as HTMLElement).className).toContain("allowed");
  });
});