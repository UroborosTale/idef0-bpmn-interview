import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { fragments, purchaseModel } from "../../test/fixtures";
import { commit, field, renderWithModel } from "../../test/harness";
import { buildIdef0 } from "../idef0-editor/geometry";
import type { ProcessLogicModel } from "../../types";
import PropertiesPanel from "./PropertiesPanel";
import type { Selection } from "./selection";
import type { StudioDoc } from "./docs";

function panel(selection: Selection, model: ProcessLogicModel = purchaseModel(), kind: StudioDoc["kind"] = "bpmn") {
  const h = { onSelect: vi.fn(), onGoto: vi.fn(), onReveal: vi.fn(), onOpenDecomposition: vi.fn(), onOpenDoc: vi.fn(), onClose: vi.fn() };
  const r = renderWithModel(model, (m, onChange) => (
    <PropertiesPanel model={m} selection={selection} session={{ id: "s1", fragments, updatedAt: "t1" }} issues={[]} activeKind={kind} onChange={onChange} {...h} />
  ));
  return { ...r, ...h };
}
const title = () => document.querySelector(".props-head b")!.textContent;

describe("панель «Свойства»: процесс", () => {
  it("без выделения — атрибуты процесса и подсказки текущего документа", () => {
    const p = panel(null, purchaseModel(), "idef0");
    expect(title()).toBe("Свойства процесса");
    commit(field("Владелец процесса"), "Финансовый директор");
    expect(p.model().process.owner).toBe("Финансовый директор");
    expect(screen.getByText(/Потяните за ●/)).toBeTruthy();
    fireEvent.click(screen.getByText("Открыть паспорт процесса"));
    expect(p.onOpenDoc).toHaveBeenCalledWith(expect.objectContaining({ key: "report:passport" }));
  });

  it("выделение исчезнувшего объекта показывает процесс", () => {
    panel({ kind: "node", id: "нет-такого" });
    expect(title()).toBe("Свойства процесса");
  });

  it("закрытие панели", () => {
    const p = panel(null);
    fireEvent.click(screen.getByTitle("Скрыть панель"));
    expect(p.onClose).toHaveBeenCalled();
  });
});

describe("панель «Свойства»: функция", () => {
  it("заголовок с кодом IDEF0, разделы", () => {
    panel({ kind: "node", id: "c" });
    expect(title()).toBe("Свойства элемента");
    expect(document.querySelector(".prop-kind")!.textContent).toMatch(/Задача\s*A3/);
    const sections = [...document.querySelectorAll(".prop-section > summary")].map((s) => s.firstChild!.textContent);
    expect(sections).toEqual(["Общие", "Сроки и стоимость", "Триггеры блока", "Граничные события", "Потоки сообщений", "Ролевая модель", "Стороны блока IDEF0", "RACI", "Диаграммы", "Источник в интервью", "История"]);
  });

  it("правка атрибутов и исполнителя", () => {
    const p = panel({ kind: "node", id: "a" });
    commit(field("Длительность"), "2 дня");
    commit(field("Стоимость"), "1000 ₽");
    fireEvent.change(field("Исполнитель (дорожка BPMN, механизм IDEF0)"), { target: { value: "r2" } });
    expect(p.model().nodes[0]).toMatchObject({ duration: "2 дня", cost_estimate: "1000 ₽", role_id: "r2" });
  });

  it("стороны блока: прикрепить из справочника, создать новый, убрать", () => {
    const p = panel({ kind: "node", id: "a" });
    const inputs = field("Входы (Input) — слева");
    fireEvent.change(inputs, { target: { value: "d2" } });
    expect(p.model().nodes[0].inputs).toEqual(["d2"]);
    fireEvent.change(field("Выходы (Output) — справа"), { target: { value: "__new__" } });
    const created = screen.getByPlaceholderText("Название и Enter");
    fireEvent.change(created, { target: { value: "черновик заявки" } });
    fireEvent.keyDown(created, { key: "Enter" });
    const doc = p.model().data.find((d) => d.name === "черновик заявки")!;
    expect(p.model().nodes[0].outputs).toEqual(["d1", doc.id]);
    const box = field("Входы (Input) — слева").closest(".bpe-field")!;
    fireEvent.click(within(box as HTMLElement).getByTitle("Убрать"));
    expect(p.model().nodes[0].inputs).toEqual([]);
  });

  it("чип открывает карточку записи с возвратом к функции", () => {
    const p = panel({ kind: "node", id: "c" });
    fireEvent.click(screen.getByText("1С"));
    expect(p.onSelect).toHaveBeenCalledWith({ kind: "entry", dict: "systems", id: "s1", back: { kind: "node", id: "c" } });
  });

  it("кнопка «←» возвращает к предыдущему объекту", () => {
    const p = panel({ kind: "entry", dict: "systems", id: "s1", back: { kind: "node", id: "c" } });
    expect(title()).toBe("Карточка записи");
    fireEvent.click(screen.getByTitle("Вернуться к предыдущему объекту"));
    expect(p.onSelect).toHaveBeenCalledWith({ kind: "node", id: "c" });
  });

  it("переходы к диаграммам и декомпозиции", () => {
    const p = panel({ kind: "node", id: "b" });
    fireEvent.click(screen.getByText("Показать в BPMN"));
    fireEvent.click(screen.getByText("Показать в IDEF0 (A0)"));
    fireEvent.click(screen.getByText("Декомпозиция (2 функц.)"));
    expect(p.onReveal.mock.calls).toEqual([["b", "bpmn"], ["b", "idef0"]]);
    expect(p.onOpenDecomposition).toHaveBeenCalledWith("b");
  });

  it("вложенную функцию нельзя «показать в BPMN»", () => {
    panel({ kind: "node", id: "b1" });
    expect(screen.queryByText("Показать в BPMN")).toBeNull();
    expect(screen.getByText("Показать в IDEF0 (A2)")).toBeTruthy();
  });

  it("гипотезу можно подтвердить", () => {
    const m = purchaseModel();
    m.nodes[0] = { ...m.nodes[0], status: "hypothesis", confidence: 0.4 };
    const p = panel({ kind: "node", id: "a" }, m);
    expect(screen.getByText("гипотеза · 40%")).toBeTruthy();
    fireEvent.click(screen.getByText("Подтвердить (убрать «гипотезу»)"));
    expect(p.model().nodes[0]).toMatchObject({ status: "confirmed", confidence: 1 });
  });

  it("удаление функции с вложенными", () => {
    const p = panel({ kind: "node", id: "b" });
    fireEvent.click(screen.getByText("Удалить функцию и 2 вложенных"));
    expect(p.model().nodes.map((n) => n.id)).toEqual(["a", "c"]);
    expect(title()).toBe("Свойства процесса");
  });

  it("событие: без IDEF0 и сроков", () => {
    const m = purchaseModel();
    m.nodes.push({ ...m.nodes[0], id: "s", type: "event", subtype: "start", name: "Начало", source: [] });
    panel({ kind: "node", id: "s" }, m);
    expect(screen.queryByText("Стороны блока IDEF0")).toBeNull();
    expect(screen.queryByText("Сроки и стоимость")).toBeNull();
  });
});

describe("панель «Свойства»: связи и стрелки", () => {
  it("стрелка потока: условие, разворот, удаление", () => {
    const p = panel({ kind: "flow", id: "f2" });
    expect(field("Условие (необязательно)").value).toBe("если одобрено");
    commit(field("Условие (необязательно)"), "сумма > 100 000");
    fireEvent.click(screen.getByText("Развернуть стрелку"));
    expect(p.model().flows[1]).toMatchObject({ from: "c", to: "b", condition: "сумма > 100 000" });
    fireEvent.click(screen.getByText("Удалить стрелку"));
    expect(p.model().flows.map((f) => f.id)).toEqual(["f1", "f3"]);
  });

  it("стрелка IDEF0 «выход → управление»: пояснение, карточка документа, разрыв связи", () => {
    const arrow = buildIdef0(purchaseModel(), null).arrows.find((a) => a.kind === "controlLink")!;
    const p = panel({ kind: "arrow", arrow }, purchaseModel(), "idef0");
    expect(title()).toBe("Свойства стрелки");
    expect(document.body.textContent).toMatch(/Выход функции\s*A2\s*является управлением функции\s*A3/);
    expect(field("Название").value).toBe("решение");
    fireEvent.click(screen.getByText("Разорвать связь"));
    expect(p.model().nodes.find((n) => n.id === "c")!.control_data_ids).toEqual([]);
    expect(title()).toBe("Свойства процесса"); // стрелки больше нет — панель не показывает её свойства
  });
});
