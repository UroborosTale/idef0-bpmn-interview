import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { purchaseModel, structuredModel } from "../../test/fixtures";
import type { ProcessLogicModel } from "../../types";
import Navigator from "./Navigator";

type M = ProcessLogicModel;

function nav(model: M, activeKey = "bpmn") {
  const onOpenDoc = vi.fn();
  const onSelectFn = vi.fn();
  const r = render(<Navigator model={model} activeKey={activeKey} selectedId={null} onOpenDoc={onOpenDoc} onSelectFn={onSelectFn} onAddFunction={vi.fn()} />);
  return { ...r, onOpenDoc, onSelectFn };
}

/** Строки дерева процессов: номер блока, код, название, отступ и класс. */
const rows = () =>
  [...document.querySelector(".nav-section")!.querySelectorAll(".nav-row")].map((r) => ({
    num: r.querySelector(".nav-num")?.textContent ?? "",
    code: r.querySelector(".nav-code")?.textContent ?? "",
    name: r.querySelector(".nav-name")?.textContent ?? "",
    pad: parseInt((r as HTMLElement).style.paddingLeft, 10),
    cls: r.className,
  }));
const count = () => document.querySelector(".nav-section")!.querySelectorAll(".nav-row").length;

describe("навигатор: иерархия по кодам процесса (модель с кодом)", () => {
  it("группа → B002.00.00 → подпроцессы B002.01.00 → операции B002.01.01 → диаграмма BPMN операции; без номеров блоков", () => {
    const m = structuredModel();
    m.process.group = "Управление корпоративными процессами";
    nav(m);
    expect(rows().map((r) => [r.num, r.code, r.name, r.pad])).toEqual([
      ["", "B002.00.00", "Управление корпоративными процессами", 8], // папка
      ["", "B002.00.00", "Управление процессами", 22], // процесс
      ["", "B002.01.00", "Моделирование процесса", 36],
      ["", "B002.01.01", "Актуализация реестра", 50],
      ["", "B002.01.01", "Актуализация реестра", 64], // диаграмма BPMN операции: тот же код и название
      ["", "B002.01.02", "Проведение интервью", 50],
      ["", "B002.01.02", "Проведение интервью", 64],
      ["", "B002.02.00", "Анализ эффективности", 36],
      ["", "B002.02.01", "Анализ соответствия", 50],
      ["", "B002.02.01", "Анализ соответствия", 64],
    ]);
    // ни строки A0, ни общей схемы, ни A-номеров
    expect(document.querySelector("[data-nav-a0]")).toBeNull();
    expect(document.querySelector("[data-nav-scheme]")).toBeNull();
    expect(document.querySelector(".nav-num")).toBeNull();
  });

  it("порядок строк следует коду: сначала подпроцесс, затем его операции", () => {
    nav(structuredModel());
    const fnCodes = [...document.querySelectorAll("[data-nav-fn] .nav-code")].map((c) => c.textContent);
    expect(fnCodes).toEqual([...fnCodes].sort());
    expect(rows().map((r) => r.code).slice(0, 3)).toEqual(["B002.00.00", "B002.01.00", "B002.01.01"]);
  });

  it("без группы процесс стоит на верхнем уровне; значки по уровням", () => {
    nav(structuredModel());
    expect(document.querySelector("[data-nav-group]")).toBeNull();
    expect(rows()[0]).toMatchObject({ code: "B002.00.00", name: "Управление процессами", pad: 8 });
    const kinds = [...document.querySelector(".nav-section")!.querySelectorAll(".nav-icon")].map((i) => i.getAttribute("class")!.replace("nav-icon nav-icon-", ""));
    expect(kinds).toEqual(["process", "subprocess", "operation", "bpmn", "operation", "bpmn", "subprocess", "operation", "bpmn"]);
    const withGroup = structuredModel();
    withGroup.process.group = "Группа";
    document.body.innerHTML = "";
    nav(withGroup);
    expect(document.querySelector(".nav-icon-folder")).toBeTruthy();
  });

  it("клики: процесс — IDEF0 процесса, строка диаграммы — BPMN операции, блок — выбор, двойной щелчок — декомпозиция", () => {
    const { onOpenDoc, onSelectFn } = nav(structuredModel());
    fireEvent.click(document.querySelector("[data-nav-process]")!);
    expect(onOpenDoc).toHaveBeenLastCalledWith(expect.objectContaining({ key: "idef0:root" }));
    fireEvent.click(document.querySelector('[data-nav-bpmn="o1"]')!);
    expect(onOpenDoc).toHaveBeenLastCalledWith(expect.objectContaining({ key: "bpmn:o1" }));
    fireEvent.click(document.querySelector('[data-nav-fn="o2"]')!);
    expect(onSelectFn).toHaveBeenCalledWith("o2");
    fireEvent.doubleClick(document.querySelector('[data-nav-fn="s1"]')!);
    expect(onOpenDoc).toHaveBeenLastCalledWith(expect.objectContaining({ key: "idef0:s1" }));
  });

  it("активная вкладка подсвечивается; диаграмма без шагов выглядит приглушённо", () => {
    nav(structuredModel(), "bpmn:o1");
    expect(document.querySelector('[data-nav-bpmn="o1"]')!.className).toMatch(/active-doc/);
    expect(document.querySelector('[data-nav-bpmn="o1"]')!.className).toMatch(/\bon\b/);
    expect(document.querySelector('[data-nav-bpmn="o2"]')!.className).not.toMatch(/\bon\b/); // у B002.01.02 шагов нет
    expect(document.querySelector('[data-nav-bpmn="o2"]')!.className).not.toMatch(/active-doc/);
    document.body.innerHTML = "";
    nav(structuredModel(), "idef0:root");
    expect(document.querySelector("[data-nav-process]")!.className).toMatch(/active-doc/);
  });

  it("сворачивание: операция скрывает диаграмму, подпроцесс — операции, процесс — всё ниже, группа — процесс", () => {
    const m = structuredModel();
    m.process.group = "Группа";
    nav(m);
    expect(count()).toBe(10);
    fireEvent.click(document.querySelector('[data-nav-fn="o1"] .nav-twisty')!); // операция
    expect(document.querySelector('[data-nav-bpmn="o1"]')).toBeNull();
    expect(count()).toBe(9);
    fireEvent.click(document.querySelector('[data-nav-fn="s1"] .nav-twisty')!); // подпроцесс
    expect(document.querySelector('[data-nav-fn="o1"]')).toBeNull();
    expect(count()).toBe(6);
    fireEvent.click(document.querySelector("[data-nav-process] .nav-twisty")!); // процесс
    expect(document.querySelector('[data-nav-fn="s2"]')).toBeNull();
    expect(count()).toBe(2); // группа и процесс
    fireEvent.click(document.querySelector("[data-nav-group]")!);
    expect(document.querySelector("[data-nav-process]")).toBeNull();
    fireEvent.click(document.querySelector("[data-nav-group]")!);
    expect(document.querySelector("[data-nav-process]")).toBeTruthy();
  });

  it("пустая модель с кодом: подсказка «Функций пока нет», у процесса нет значка раскрытия", () => {
    const m = structuredModel();
    m.nodes = [];
    m.flows = [];
    nav(m);
    expect(document.body.textContent).toContain("Функций пока нет");
    expect(document.querySelector("[data-nav-process] .nav-twisty")!.textContent).toBe("");
  });
});

describe("навигатор: модель без кода процесса — номера блоков", () => {
  it("процесс → диаграмма A0 → A1 → A2.1 → диаграмма BPMN операции (A2.1.1) и общая схема", () => {
    nav(purchaseModel());
    expect(rows().map((r) => [r.num, r.code, r.name])).toEqual([
      ["", "", "Закупка"],
      ["A0", "", "Закупка"],
      ["", "A1", "оформить заявку"],
      ["", "A2", "согласовать заявку"],
      ["", "A2.1", "проверить бюджет"],
      ["", "A2.1.1", "проверить бюджет"],
      ["", "A2.2", "принять решение"],
      ["", "A2.2.1", "принять решение"],
      ["", "A3", "оплатить счёт"],
      ["", "", "Схема процесса (BPMN)"],
    ]);
  });

  it("клики: процесс — паспорт, A0 — IDEF0, схема — общий BPMN", () => {
    const { onOpenDoc } = nav(purchaseModel());
    fireEvent.click(document.querySelector("[data-nav-process]")!);
    expect(onOpenDoc).toHaveBeenLastCalledWith(expect.objectContaining({ key: "report:passport" }));
    fireEvent.click(document.querySelector("[data-nav-a0]")!);
    expect(onOpenDoc).toHaveBeenLastCalledWith(expect.objectContaining({ key: "idef0:root" }));
    fireEvent.click(document.querySelector("[data-nav-scheme]")!);
    expect(onOpenDoc).toHaveBeenLastCalledWith(expect.objectContaining({ key: "bpmn" }));
  });

  it("A0 сворачивает подпроцессы, процесс — всё ниже", () => {
    nav(purchaseModel());
    expect(count()).toBe(10);
    fireEvent.click(document.querySelector("[data-nav-a0] .nav-twisty")!);
    expect(count()).toBe(3); // процесс, A0 и общая схема — функции скрыты
    fireEvent.click(document.querySelector("[data-nav-process] .nav-twisty")!);
    expect(document.querySelector("[data-nav-a0]")).toBeNull();
    expect(document.querySelector("[data-nav-scheme]")).toBeNull();
  });
});
