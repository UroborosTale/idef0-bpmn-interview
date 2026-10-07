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

/** Строки дерева процессов: значок не нужен — читаем номер, код и название, отступ и класс. */
const rows = () =>
  [...document.querySelector(".nav-section")!.querySelectorAll(".nav-row")].map((r) => ({
    num: r.querySelector(".nav-num")?.textContent ?? "",
    code: r.querySelector(".nav-code")?.textContent ?? "",
    name: r.querySelector(".nav-name")?.textContent ?? "",
    pad: parseInt((r as HTMLElement).style.paddingLeft, 10),
    cls: r.className,
  }));

describe("навигатор: дерево процессов как в Business Studio 6", () => {
  it("группа → процесс → A0 → подпроцессы → операции → диаграмма BPMN операции, с номерами и кодами", () => {
    const m = structuredModel();
    m.process.group = "Управление корпоративными процессами";
    nav(m);
    expect(rows().map((r) => [r.num, r.code, r.name, r.pad])).toEqual([
      ["", "B002.00.00", "Управление корпоративными процессами", 8], // папка
      ["", "B002.00.00", "Управление процессами", 22], // процесс
      ["A0", "", "Управление процессами", 36], // диаграмма A0
      ["A1", "B002.01.00", "Моделирование процесса", 50],
      ["A1.1", "B002.01.01", "Актуализация реестра", 64],
      ["A1.1.1", "B002.01.01", "Актуализация реестра", 78], // диаграмма BPMN операции: тот же код и название
      ["A1.2", "B002.01.02", "Проведение интервью", 64],
      ["A1.2.1", "B002.01.02", "Проведение интервью", 78],
      ["A2", "B002.02.00", "Анализ эффективности", 50],
      ["A2.1", "B002.02.01", "Анализ соответствия", 64],
      ["A2.1.1", "B002.02.01", "Анализ соответствия", 78],
      ["", "", "Схема процесса (BPMN)", 36],
    ].map((x) => x));
  });

  it("без группы процесс стоит на верхнем уровне; значки: папка, процесс, диаграмма, блоки, BPMN", () => {
    nav(structuredModel());
    expect(document.querySelector("[data-nav-group]")).toBeNull();
    expect(rows()[0]).toMatchObject({ name: "Управление процессами", pad: 8 });
    const kinds = [...document.querySelector(".nav-section")!.querySelectorAll(".nav-icon")].map((i) => i.getAttribute("class")!.replace("nav-icon nav-icon-", ""));
    expect(kinds).toEqual(["process", "diagram", "subprocess", "operation", "bpmn", "operation", "bpmn", "subprocess", "operation", "bpmn", "bpmn"]);
    const withGroup = structuredModel();
    withGroup.process.group = "Группа";
    document.body.innerHTML = "";
    nav(withGroup);
    expect(document.querySelector(".nav-icon-folder")).toBeTruthy();
  });

  it("модель без кода процесса: номер блока служит обозначением, у операций есть строка диаграммы BPMN", () => {
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

  it("клики: процесс — паспорт, A0 — IDEF0, схема — общий BPMN, строка диаграммы — BPMN операции, блок — выбор", () => {
    const m = structuredModel();
    const { onOpenDoc, onSelectFn } = nav(m);
    fireEvent.click(document.querySelector("[data-nav-process]")!);
    expect(onOpenDoc).toHaveBeenLastCalledWith(expect.objectContaining({ key: "report:passport" }));
    fireEvent.click(document.querySelector("[data-nav-a0]")!);
    expect(onOpenDoc).toHaveBeenLastCalledWith(expect.objectContaining({ key: "idef0:root" }));
    fireEvent.click(document.querySelector("[data-nav-scheme]")!);
    expect(onOpenDoc).toHaveBeenLastCalledWith(expect.objectContaining({ key: "bpmn" }));
    fireEvent.click(document.querySelector('[data-nav-bpmn="o1"]')!);
    expect(onOpenDoc).toHaveBeenLastCalledWith(expect.objectContaining({ key: "bpmn:o1" }));
    fireEvent.click(document.querySelector('[data-nav-fn="o2"]')!);
    expect(onSelectFn).toHaveBeenCalledWith("o2");
    fireEvent.doubleClick(document.querySelector('[data-nav-fn="s1"]')!);
    expect(onOpenDoc).toHaveBeenLastCalledWith(expect.objectContaining({ key: "idef0:s1" }));
  });

  it("активная вкладка подсвечивается в дереве; диаграмма без шагов выглядит приглушённо", () => {
    nav(structuredModel(), "bpmn:o1");
    expect(document.querySelector('[data-nav-bpmn="o1"]')!.className).toMatch(/active-doc/);
    expect(document.querySelector('[data-nav-bpmn="o1"]')!.className).toMatch(/\bon\b/);
    expect(document.querySelector('[data-nav-bpmn="o2"]')!.className).not.toMatch(/\bon\b/); // у B002.01.02 шагов нет
    expect(document.querySelector('[data-nav-bpmn="o2"]')!.className).not.toMatch(/active-doc/);
    document.body.innerHTML = "";
    nav(structuredModel(), "idef0:root");
    expect(document.querySelector("[data-nav-a0]")!.className).toMatch(/active-doc/);
    document.body.innerHTML = "";
    nav(structuredModel(), "report:passport");
    expect(document.querySelector("[data-nav-process]")!.className).toMatch(/active-doc/);
  });

  it("сворачивание: операция скрывает диаграмму, подпроцесс — операции, A0 — подпроцессы, процесс и группа — всё ниже", () => {
    const m = structuredModel();
    m.process.group = "Группа";
    nav(m);
    const count = () => document.querySelector(".nav-section")!.querySelectorAll(".nav-row").length;
    expect(count()).toBe(12);
    fireEvent.click(document.querySelector('[data-nav-fn="o1"] .nav-twisty')!); // операция
    expect(document.querySelector('[data-nav-bpmn="o1"]')).toBeNull();
    expect(count()).toBe(11);
    fireEvent.click(document.querySelector('[data-nav-fn="s1"] .nav-twisty')!); // подпроцесс
    expect(document.querySelector('[data-nav-fn="o1"]')).toBeNull();
    expect(count()).toBe(8);
    fireEvent.click(document.querySelector("[data-nav-a0] .nav-twisty")!); // A0
    expect(document.querySelector('[data-nav-fn="s2"]')).toBeNull();
    expect(count()).toBe(4); // группа, процесс, A0, схема процесса
  });

  it("сворачивание процесса и группы", () => {
    const m = structuredModel();
    m.process.group = "Группа";
    nav(m);
    fireEvent.click(document.querySelector("[data-nav-process] .nav-twisty")!);
    expect(document.querySelector("[data-nav-a0]")).toBeNull();
    expect(document.querySelector("[data-nav-scheme]")).toBeNull();
    expect(document.querySelector("[data-nav-process]")).toBeTruthy();
    fireEvent.click(document.querySelector("[data-nav-group]")!);
    expect(document.querySelector("[data-nav-process]")).toBeNull();
    fireEvent.click(document.querySelector("[data-nav-group]")!);
    expect(document.querySelector("[data-nav-process]")).toBeTruthy();
  });

  it("пустая модель: подсказка «Функций пока нет», схема процесса остаётся", () => {
    const m = structuredModel();
    m.nodes = [];
    m.flows = [];
    nav(m);
    expect(document.body.textContent).toContain("Функций пока нет");
    expect(document.querySelector("[data-nav-scheme]")).toBeTruthy();
  });
});
