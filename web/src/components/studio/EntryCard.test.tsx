import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { fragments, purchaseModel } from "../../test/fixtures";
import { commit, field, renderWithModel } from "../../test/harness";
import EntryCard from "./EntryCard";
import type { DictKind } from "./docs";

const card = (dict: DictKind, id: string, onGoto = vi.fn(), model = purchaseModel()) =>
  renderWithModel(model, (m, onChange) => <EntryCard model={m} dict={dict} id={id} sessionId="s1" fragments={fragments} stamp="t1" onChange={onChange} onGoto={onGoto} />);

describe("карточка записи справочника", () => {
  it("исполнитель: подразделение, описание, переименование", () => {
    const r = card("roles", "r1");
    expect(document.querySelector(".prop-kind")!.textContent).toBe("Исполнитель · Исполнители");
    commit(field("Подразделение"), "Отдел закупок");
    commit(field("Описание"), "  Инициирует закупку  ");
    commit(field("Название"), "Заявитель");
    expect(r.model().roles[0]).toMatchObject({ name: "Заявитель", owner: "Отдел закупок", description: "Инициирует закупку" });
    expect(r.changes()).toBe(3);
  });

  it("очистка поля записывает null, а не пустую строку", () => {
    const m = purchaseModel();
    m.systems[0].description = "Учёт";
    const r = card("systems", "s1", vi.fn(), m);
    commit(field("Описание"), "");
    expect(r.model().systems[0].description).toBeNull();
  });

  it("пустое название не принимается", () => {
    const r = card("data", "d1");
    commit(field("Название"), " ");
    expect(r.changes()).toBe(0);
    expect(field("Название").value).toBe("заявка");
  });

  it("поля по виду справочника", () => {
    card("controls", "c1");
    expect(field("Реквизиты")).toBeTruthy();
    expect(field("Вид").value).toBe("regulation");
  });

  it("KPI и риск: свои поля, «относится ко всему процессу»", () => {
    const m = purchaseModel();
    m.process.kpi = [{ id: "k1", name: "Срок", source: [] }];
    m.process.risks = [{ id: "rk1", name: "Просрочка", source: [] }];
    const r = card("kpi", "k1", vi.fn(), m);
    commit(field("Целевое значение"), "5");
    commit(field("Периодичность измерения"), "ежемесячно");
    expect(r.model().process.kpi[0]).toMatchObject({ target: "5", period: "ежемесячно" });
    expect(screen.getByText(/ко всему процессу/)).toBeTruthy();
    r.unmount();
    const r2 = card("risks", "rk1", vi.fn(), m);
    fireEvent.change(field("Уровень риска"), { target: { value: "high" } });
    expect(r2.model().process.risks[0].level).toBe("high");
  });

  it("«где используется»: переход к шагу; неиспользуемая запись помечается", () => {
    const onGoto = vi.fn();
    card("data", "d3", onGoto);
    const section = screen.getByText("Где используется").closest("details")!;
    expect(within(section).getAllByRole("button")).toHaveLength(3);
    fireEvent.click(within(section).getByText("оплатить счёт"));
    expect(onGoto).toHaveBeenCalledWith("c");
  });

  it("неиспользуемая запись", () => {
    const m = purchaseModel();
    m.systems.push({ id: "s2", name: "Excel", source: [] });
    card("systems", "s2", vi.fn(), m);
    expect(screen.getByText(/нигде не используется/)).toBeTruthy();
  });

  it("исполнитель: число отметок RACI; документ: интерфейс процесса", () => {
    card("roles", "r1");
    expect(screen.getByText(/В матрице RACI: 2/)).toBeTruthy();
  });

  it("документ — вход процесса", () => {
    card("data", "d2");
    expect(screen.getByText(/Интерфейсы процесса: вход/)).toBeTruthy();
  });

  it("источник в интервью: цитата и собеседник", () => {
    card("roles", "r1");
    expect(screen.getByText(/«Инициатор оформляет заявку»/)).toBeTruthy();
    expect(screen.getByText(/владелец процесса, фрагмент 1/)).toBeTruthy();
  });

  it("удаление с подтверждением", () => {
    const r = card("roles", "r2");
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    fireEvent.click(screen.getByText("Удалить запись"));
    expect(r.changes()).toBe(0);
    fireEvent.click(screen.getByText("Удалить запись"));
    expect(confirm.mock.calls[1][0]).toMatch(/используется в 1 элем/);
    expect(r.model().roles.map((x) => x.id)).toEqual(["r1"]);
    expect(screen.getByText("Запись удалена.")).toBeTruthy();
  });

  it("история загружается при раскрытии и показывает изменения", async () => {
    const spy = vi.spyOn(api, "entryHistory").mockResolvedValue([
      { seq: 1, version: "0.1", ts: "2026-10-01T10:00:00Z", author: "аналитик", note: "", event: "created", changes: [] },
      { seq: 2, version: "0.2", ts: "2026-10-02T10:00:00Z", author: "аналитик", note: "правка", event: "changed", changes: [{ field: "owner", from: null, to: "Бухгалтерия" }] },
    ]);
    card("roles", "r2");
    expect(spy).not.toHaveBeenCalled();
    const details = screen.getByText("История").closest("details")!;
    details.open = true;
    fireEvent(details, new Event("toggle"));
    await waitFor(() => expect(screen.getByText("Появилась")).toBeTruthy());
    expect(spy).toHaveBeenCalledWith("s1", "roles", "r2");
    expect(screen.getByText(/Подразделение: пусто → «Бухгалтерия»/)).toBeTruthy();
    // новые события сверху
    const items = details.querySelectorAll("li");
    expect(items[0].textContent).toMatch(/Изменена/);
  });

  it("ошибка загрузки истории показывается, а не роняет карточку", async () => {
    vi.spyOn(api, "entryHistory").mockRejectedValue(new Error("сеть недоступна"));
    card("data", "d1");
    const details = screen.getByText("История").closest("details")!;
    details.open = true;
    fireEvent(details, new Event("toggle"));
    await waitFor(() => expect(screen.getByText(/сеть недоступна/)).toBeTruthy());
  });
});
