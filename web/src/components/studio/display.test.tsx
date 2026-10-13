import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { session, structuredModel } from "../../test/fixtures";
import { DEFAULT_DISPLAY, loadDisplay, saveDisplay } from "../editor-core/display";
import { NodeShape } from "../bpmn-editor/shapes";
import { FlowShape } from "../bpmn-editor/shapes";
import { ArrowShape, BlockShape } from "../idef0-editor/shapes";
import Studio from "./Studio";

describe("вид диаграмм: настройка", () => {
  it("значения по умолчанию, запоминание и повреждённое хранилище", () => {
    expect(loadDisplay("k")).toEqual(DEFAULT_DISPLAY);
    saveDisplay("k", { labels: false, bpmnNumbers: true, idef0Numbers: false });
    expect(loadDisplay("k")).toEqual({ labels: false, bpmnNumbers: true, idef0Numbers: false });
    localStorage.setItem("k", "{не json");
    expect(loadDisplay("k")).toEqual(DEFAULT_DISPLAY);
    localStorage.setItem("k", JSON.stringify({ labels: "нет", bpmnNumbers: true }));
    expect(loadDisplay("k")).toEqual({ ...DEFAULT_DISPLAY, bpmnNumbers: true }); // неверное поле заменяется значением по умолчанию
  });
});

describe("вид диаграмм: фигуры", () => {
  const box = { x: 0, y: 0, w: 36, h: 36 };

  it("BPMN: подпись события под фигурой скрывается слоем подписей, название внутри задачи — нет", () => {
    const m = structuredModel();
    const event = m.nodes.find((n) => n.id === "b0")!;
    const task = m.nodes.find((n) => n.id === "b1")!;
    const texts = (showLabel: boolean, n: typeof event, b = box) => [...render(<svg><NodeShape node={n} box={b} selected={false} hot={false} showLabel={showLabel} /></svg>).container.querySelectorAll("text")].map((t) => t.textContent);
    expect(texts(true, event)).toContain("Информация получена");
    expect(texts(false, event)).not.toContain("Информация получена");
    expect(texts(false, task, { x: 0, y: 0, w: 100, h: 80 }).join(" ")).toContain("Открыть");
  });

  it("BPMN: номер рисуется на задаче только когда задан", () => {
    const task = structuredModel().nodes.find((n) => n.id === "b1")!;
    const code = (c?: string) => render(<svg><NodeShape node={task} box={{ x: 0, y: 0, w: 100, h: 80 }} selected={false} hot={false} code={c} /></svg>).container.querySelector("[data-step-code]")?.textContent;
    expect(code()).toBeUndefined();
    expect(code("B002.01.01/001")).toBe("B002.01.01/001");
  });

  it("BPMN: условие стрелки скрывается слоем подписей", () => {
    const flow = { id: "f", from: "a", to: "b", condition: "сумма больше", source: [], confirmed_by: [] };
    const has = (showLabel: boolean) => render(<svg><FlowShape flow={flow} points={[[0, 0], [100, 0]]} selected={false} showLabel={showLabel} /></svg>).container.textContent!.includes("сумма больше");
    expect(has(true)).toBe(true);
    expect(has(false)).toBe(false);
  });

  it("IDEF0: код блока и подпись стрелки скрываются", () => {
    const fn = { node: structuredModel().nodes.find((n) => n.id === "o1")!, box: { x: 0, y: 0, w: 200, h: 80 }, code: "B002.01.01", hasChildren: false } as never;
    const text = (show: boolean) => render(<svg><BlockShape fn={fn} selected={false} hot={false} showCode={show} /></svg>).container.textContent!;
    expect(text(true)).toContain("B002.01.01");
    expect(text(false)).not.toContain("B002.01.01");
    const arrow = { key: "a", points: [[0, 0], [100, 0]], label: "Реестр процессов", kind: "output", side: "right" } as never;
    const arrowText = (show: boolean) => render(<svg><ArrowShape arrow={arrow} selected={false} showLabel={show} /></svg>).container.textContent!;
    expect(arrowText(true).length).toBeGreaterThanOrEqual(arrowText(false).length);
    expect(arrowText(false)).toBe("");
  });
});

describe("окно студии: «Подписи» и «Номера»", () => {
  const open = () => render(<Studio session={session(structuredModel())} busy={false} onSave={vi.fn(async () => true)} />);
  const btn = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;
  const eventNames = () => [...document.querySelectorAll('[data-event-position] text')].map((t) => t.textContent);

  it("BPMN: «Подписи» убирает названия событий; «Номера» показывает коды задач; настройка запоминается", () => {
    const first = open();
    fireEvent.click(document.querySelector('[data-nav-bpmn="o1"]')!);
    expect(eventNames()).toContain("Информация получена");
    expect(document.querySelectorAll("[data-step-code]")).toHaveLength(0);
    fireEvent.click(btn("Подписи"));
    expect(eventNames()).not.toContain("Информация получена");
    fireEvent.click(btn("Номера"));
    expect([...document.querySelectorAll("[data-step-code]")].map((t) => t.textContent)).toEqual(["B002.01.01/001", "B002.01.01/002"]);
    expect(btn("Номера").className).toMatch(/toggled/);
    first.unmount();
    open(); // новое окно той же сессии: настройка сохранена
    fireEvent.click(document.querySelector('[data-nav-bpmn="o1"]')!);
    expect(eventNames()).not.toContain("Информация получена");
    expect(document.querySelectorAll("[data-step-code]")).toHaveLength(2);
  });

  it("IDEF0: коды блоков есть по умолчанию, «Номера» их убирает; «Подписи» работает и там", () => {
    open();
    fireEvent.click(document.querySelector('[data-nav-fn="o1"]')!); // диаграмма подпроцесса с блоками операций
    const blockText = () => document.querySelector('[data-fn-id="o1"]')!.textContent!;
    expect(blockText()).toContain("B002.01.01");
    fireEvent.click(btn("Номера"));
    expect(blockText()).not.toContain("B002.01.01");
    expect(blockText()).toContain("Актуализация реестра");
    const arrowLabels = () => [...document.querySelectorAll("[data-arrow-key] text")].filter((t) => t.textContent).length;
    const before = arrowLabels();
    expect(before).toBeGreaterThan(0);
    fireEvent.click(btn("Подписи"));
    expect(arrowLabels()).toBe(0);
  });

  it("на диаграммах других видов кнопок нет", () => {
    open();
    fireEvent.click(screen.getAllByText("Паспорт процесса")[0]);
    expect(screen.queryByRole("button", { name: "Подписи" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Номера" })).toBeNull();
  });
});
