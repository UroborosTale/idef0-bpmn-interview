import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import { purchaseModel, session } from "../test/fixtures";
import type { SessionRecord } from "../types";
import WorkspacePage from "./WorkspacePage";

function setup(s: SessionRecord, props: { initialTab?: string } = {}) {
  vi.spyOn(api, "getSession").mockResolvedValue(s);
  vi.spyOn(api, "activeJob").mockResolvedValue(null as never);
  const onBack = vi.fn();
  const onTabChange = vi.fn();
  render(<WorkspacePage sessionId={s.id} onBack={onBack} onTabChange={onTabChange} {...props} />);
  return { onBack, onTabChange };
}
const activeTab = () => document.querySelector(".ws-tabs [aria-selected=true]")?.textContent;
const activeGroup = () => document.querySelector(".ws-groups [aria-selected=true]")?.textContent;

// вкладки, которые сами ходят в API при открытии (регламент и т. п.), получают пустой ответ — их содержимое здесь не проверяется
beforeEach(() => void vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }))));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("страница сессии", () => {
  it("загрузка, заголовок, кнопка «Назад»", async () => {
    const { onBack } = setup(session());
    expect(screen.getByText("Загрузка сессии…")).toBeTruthy();
    await screen.findByRole("heading", { name: "Закупка" });
    fireEvent.click(screen.getByText("← Назад"));
    expect(onBack).toHaveBeenCalled();
  });

  it("сессия с моделью открывается в студии", async () => {
    setup(session());
    await screen.findByRole("heading", { name: "Закупка" });
    await waitFor(() => expect(activeTab()).toBe("Студия"));
    expect(document.querySelector(".studio")).toBeTruthy();
    expect(activeGroup()).toBe("Модель");
  });

  it("прежние адреса редакторов (?tab=editor, idef0Editor, visio) ведут в студию", async () => {
    for (const tab of ["editor", "idef0Editor", "visio"]) {
      vi.restoreAllMocks();
      const { unmount } = render(<div />);
      unmount();
      setup(session(), { initialTab: tab });
      await screen.findByRole("heading", { name: "Закупка" });
      expect(activeTab(), tab).toBe("Студия");
      document.body.innerHTML = "";
    }
  });

  it("вкладка из адреса сохраняется; переключение сообщается адресу и открывает нужную группу", async () => {
    const { onTabChange } = setup(session(), { initialTab: "raci" });
    await screen.findByRole("heading", { name: "Закупка" });
    expect(activeTab()).toBe("RACI");
    expect(activeGroup()).toBe("Анализ");
    fireEvent.click(screen.getByRole("tab", { name: "Документы и выгрузка" }));
    expect(onTabChange).toHaveBeenLastCalledWith("regulation");
    expect(activeTab()).toBe("Регламент");
  });

  it("неизвестная вкладка в адресе игнорируется", async () => {
    setup(session(), { initialTab: "нет-такой" });
    await screen.findByRole("heading", { name: "Закупка" });
    await waitFor(() => expect(activeTab()).toBe("Студия"));
  });

  it("сессия без модели: панель загрузки текста, «Студия» просит запустить обработку", async () => {
    const s = { ...session(), model: null, status: "draft" as const, fragments: [], rawText: "" };
    setup(s, { initialTab: "studio" });
    await screen.findByRole("heading", { name: "Закупка" });
    expect(screen.getByText(/Модели ещё нет/)).toBeTruthy();
    expect(document.querySelector(".studio")).toBeNull();
  });

  it("счётчики в заголовках групп: открытые пробелы и ошибки", async () => {
    const s = session();
    s.validation = [{ id: "v1", notation: "BPMN", severity: "error", rule: "x", message: "ошибка", element_id: null }];
    setup(s);
    await screen.findByRole("heading", { name: "Закупка" });
    expect(screen.getByRole("tab", { name: "Проверки (2)" })).toBeTruthy(); // 1 пробел + 1 ошибка
  });

  it("режим интервью: начало, ответ владельца", async () => {
    const s = { ...session(), mode: "B" as const, status: "interviewing" as const, chat: [] };
    setup(s);
    const start = vi.spyOn(api, "interviewStart").mockResolvedValue({ ...s, chat: [{ id: "m1", role: "assistant", text: "Опишите процесс", ts: 1 }] });
    await screen.findByRole("heading", { name: "Закупка" });
    await waitFor(() => expect(activeTab()).toBe("Интервью"));
    fireEvent.click(screen.getByText("Начать интервью"));
    await screen.findByText("Опишите процесс");
    expect(start).toHaveBeenCalledWith(s.id);
  });

  it("устаревшие диаграммы: кнопка пересборки", async () => {
    const s = { ...session(), diagramsStale: true };
    setup(s);
    const rebuilt = vi.spyOn(api, "rebuildDiagrams").mockResolvedValue({ ...s, diagramsStale: false });
    await screen.findByRole("heading", { name: "Закупка" });
    fireEvent.click(screen.getByText(/Пересобрать диаграммы/));
    await waitFor(() => expect(rebuilt).toHaveBeenCalledWith(s.id));
    await waitFor(() => expect(screen.queryByText(/Пересобрать диаграммы/)).toBeNull());
  });

  it("сохранение из студии: модель и версия отправляются, затем диаграммы пересобираются", async () => {
    const s = session();
    setup(s);
    const put = vi.spyOn(api, "putModel").mockResolvedValue(s);
    const rebuild = vi.spyOn(api, "rebuildDiagrams").mockResolvedValue({ ...s, updatedAt: "2026-10-02T10:00:00Z" });
    await screen.findByRole("heading", { name: "Закупка" });
    await waitFor(() => expect(document.querySelector(".studio")).toBeTruthy());
    fireEvent.click(screen.getByText("Исполнители", { selector: ".nav-name" }));
    fireEvent.click(document.querySelector(".dict-table tbody tr")!);
    const desc = screen.getByLabelText("Описание");
    fireEvent.change(desc, { target: { value: "из страницы" } });
    fireEvent.blur(desc);
    await act(async () => fireEvent.click(screen.getByTitle("Сохранить (Ctrl+S)")));
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0][1]!.roles[0].description).toBe("из страницы");
    expect(put.mock.calls[0][2]).toBe(s.updatedAt); // защита от потерянных правок
    expect(rebuild).toHaveBeenCalledWith(s.id);
  });

  it("отказ сервера при сохранении (конфликт) показывается и не сбрасывает правки", async () => {
    const s = session(purchaseModel());
    setup(s);
    vi.spyOn(api, "putModel").mockRejectedValue(new Error("Модель изменилась после того, как вы начали правку"));
    await screen.findByRole("heading", { name: "Закупка" });
    await waitFor(() => expect(document.querySelector(".studio")).toBeTruthy());
    fireEvent.click(screen.getByText("Исполнители", { selector: ".nav-name" }));
    fireEvent.click(document.querySelector(".dict-table tbody tr")!);
    const desc = screen.getByLabelText("Описание");
    fireEvent.change(desc, { target: { value: "правка" } });
    fireEvent.blur(desc);
    await act(async () => fireEvent.click(screen.getByTitle("Сохранить (Ctrl+S)")));
    await screen.findByText(/Модель изменилась после того, как вы начали правку/);
    expect(document.querySelector(".statusbar")!.textContent).toMatch(/несохранённые/);
  });

  it("ошибка в одной вкладке не роняет страницу", async () => {
    setup(session(), { initialTab: "text" });
    await screen.findByRole("heading", { name: "Закупка" });
    expect(screen.getByRole("heading", { name: "Закупка" })).toBeTruthy();
    expect(activeTab()).toBe("Текст");
  });
});
