import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { session, structuredModel } from "../../test/fixtures";
import { functionCodes } from "@shared/codes";
import Studio from "./Studio";
import { copyFunctionTree, copyImpact, pasteDestination } from "./structure-ops";

const names = (m: ReturnType<typeof structuredModel>, parent: string | null) => m.nodes.filter((n) => (n.type === "task" || n.type === "subprocess") && !n.bpmn_scope && (n.idef0_parent ?? null) === parent).map((n) => n.name);

describe("копирование функции вместе с вложенным", () => {
  it("операция: копия с шагами диаграммы BPMN, стрелками и ролями, новые id, название с припиской при совпадении", () => {
    const m = structuredModel();
    const r = copyFunctionTree(m, "o1", "s2");
    if ("error" in r) throw new Error(r.error);
    const copy = r.model.nodes.find((n) => n.id === r.id)!;
    expect(copy).toMatchObject({ name: "Актуализация реестра", idef0_parent: "s2", idef0_layout: null, status: "confirmed" });
    const steps = r.model.nodes.filter((n) => n.bpmn_scope === r.id);
    expect(steps.map((s) => s.name)).toEqual(["Информация получена", "Открыть реестр", "Внести код процесса", "Реестр актуализирован"]);
    const stepIds = new Set(steps.map((s) => s.id));
    const flows = r.model.flows.filter((f) => stepIds.has(f.from));
    expect(flows).toHaveLength(3);
    expect(flows.every((f) => stepIds.has(f.to))).toBe(true);
    expect(new Set(r.model.nodes.map((n) => n.id)).size).toBe(r.model.nodes.length); // id не повторяются
    expect(r.model.assignments.filter((a) => a.node_id === r.id).map((a) => a.kind).sort()).toEqual(["controller", "executor"]);
    // оригинал не тронут
    expect(r.model.nodes.filter((n) => n.bpmn_scope === "o1")).toHaveLength(4);
    expect(functionCodes(r.model).get(r.id)).toBe("B002.02.02");
  });

  it("копия в тот же подпроцесс получает «(копия)», повторная — «(копия 2)»", () => {
    const m = structuredModel();
    const a = copyFunctionTree(m, "o1", "s1");
    if ("error" in a) throw new Error(a.error);
    const b = copyFunctionTree(a.model, "o1", "s1");
    if ("error" in b) throw new Error(b.error);
    expect(names(b.model, "s1")).toEqual(["Актуализация реестра", "Проведение интервью", "Актуализация реестра (копия)", "Актуализация реестра (копия 2)"]);
  });

  it("подпроцесс копируется с операциями; в модели с кодом процесса глубже операции нельзя", () => {
    const m = structuredModel();
    const r = copyFunctionTree(m, "s1", null);
    if ("error" in r) throw new Error(r.error);
    const copy = r.model.nodes.find((n) => n.id === r.id)!;
    expect(copy.name).toBe("Моделирование процесса (копия)");
    expect(r.model.nodes.filter((n) => n.idef0_parent === r.id).map((n) => n.name)).toEqual(["Актуализация реестра", "Проведение интервью"]);
    expect(copyImpact(m, "s1")).toEqual({ functions: 3, steps: 4 });
    expect(copyFunctionTree(m, "s1", "s2")).toEqual({ error: expect.stringMatching(/глубже операции/) });
    expect(copyFunctionTree(m, "b1", null)).toEqual({ error: expect.stringMatching(/только функции/) });
    expect(copyFunctionTree(m, "o1", "b1")).toEqual({ error: expect.stringMatching(/только в функцию/) });
  });

  it("место вставки: внутрь выбранной, а если глубина не позволяет — после неё; на верхний уровень — после последней", () => {
    const m = structuredModel();
    expect(pasteDestination(m, "o1", "s2")).toEqual({ parent: "s2", move: { kind: "into", id: "s2" } });
    expect(pasteDestination(m, "o1", "o3")).toEqual({ parent: "s2", move: { kind: "after", id: "o3" } });
    expect(pasteDestination(m, "s1", "s2")).toEqual({ parent: null, move: { kind: "after", id: "s2" } }); // подпроцесс рядом с подпроцессом
    expect(pasteDestination(m, "s1", "o3")).toEqual({ error: expect.stringMatching(/глубже операции/) });
    expect(pasteDestination(m, "o1", null)).toEqual({ parent: null, move: { kind: "after", id: "s2" } });
    expect(pasteDestination(m, "o1", "b1")).toEqual({ error: expect.stringMatching(/только в функцию/) });
  });
});

describe("окно студии: копировать, вырезать и вставить в навигаторе", () => {
  const open = () => render(<Studio session={session(structuredModel())} busy={false} onSave={vi.fn(async () => true)} />);
  const row = (id: string) => document.querySelector(`[data-nav-fn="${id}"]`) as HTMLElement;
  /** Названия строк, вложенных в функцию: строки глубже на уровень до следующей строки того же уровня. */
  const childrenOf = (id: string) => {
    const r = row(id);
    const pad = parseInt(r.style.paddingLeft, 10);
    const all = [...document.querySelectorAll("[data-nav-fn]")] as HTMLElement[];
    const out: string[] = [];
    for (let i = all.indexOf(r) + 1; i < all.length && parseInt(all[i].style.paddingLeft, 10) > pad; i++) out.push(all[i].querySelector(".nav-name")!.textContent!);
    return out;
  };

  it("Ctrl+C и Ctrl+V: операция копируется в выбранный подпроцесс вместе с шагами (с подтверждением)", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    open();
    fireEvent.click(row("o1"));
    fireEvent.keyDown(row("o1"), { key: "c", ctrlKey: true });
    fireEvent.click(row("s2"));
    fireEvent.keyDown(row("s2"), { key: "v", ctrlKey: true });
    expect(confirm.mock.calls[0][0]).toMatch(/вместе с вложенным: функций 0, шагов диаграмм 4/);
    expect(childrenOf("s2")).toEqual(["Анализ соответствия", "Актуализация реестра"]);
    expect(childrenOf("s1")).toEqual(["Актуализация реестра", "Проведение интервью"]); // оригинал на месте
    // буфер сохраняется: можно вставить ещё раз
    fireEvent.keyDown(row("s2"), { key: "v", ctrlKey: true });
    expect(childrenOf("s2")).toHaveLength(3);
  });

  it("Ctrl+X и Ctrl+V переносят: оригинал исчезает из прежнего места, буфер очищается", () => {
    open();
    fireEvent.click(row("o2"));
    fireEvent.keyDown(row("o2"), { key: "x", ctrlKey: true });
    expect(row("o2").className).toMatch(/nav-cut/);
    fireEvent.click(row("s2"));
    fireEvent.keyDown(row("s2"), { key: "v", ctrlKey: true });
    expect(childrenOf("s1")).toEqual(["Актуализация реестра"]);
    expect(childrenOf("s2")).toEqual(["Анализ соответствия", "Проведение интервью"]);
    // повторная вставка нечем: буфер пуст
    fireEvent.keyDown(row("s2"), { key: "v", ctrlKey: true });
    expect(childrenOf("s2")).toHaveLength(2);
  });

  it("недопустимая вставка показывает причину и ничего не меняет", () => {
    open();
    fireEvent.click(row("s1"));
    fireEvent.keyDown(row("s1"), { key: "c", ctrlKey: true });
    fireEvent.click(row("o3"));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.keyDown(row("o3"), { key: "v", ctrlKey: true }); // подпроцесс на операцию: ни внутрь, ни рядом — глубже операции
    expect(screen.getByRole("alert").textContent).toMatch(/глубже операции/);
    expect(childrenOf("s2")).toEqual(["Анализ соответствия"]);
  });

  it("контекстное меню: Вырезать, «Вставить на верхний уровень» у процесса", () => {
    open();
    fireEvent.contextMenu(row("o2"));
    fireEvent.click(screen.getByText("Вырезать"));
    fireEvent.contextMenu(document.querySelector("[data-nav-process]")!);
    fireEvent.click(screen.getByText("Вставить на верхний уровень"));
    expect(childrenOf("s1")).toEqual(["Актуализация реестра"]);
    expect([...document.querySelectorAll("[data-nav-fn]")].map((r) => r.querySelector(".nav-name")!.textContent)).toContain("Проведение интервью");
  });

  it("на утверждённой версии копировать и вставлять нельзя", () => {
    const s = session(structuredModel());
    render(<Studio session={{ ...s, model: { ...s.model!, process: { ...s.model!.process, status: "approved" as const } } }} busy={false} onSave={vi.fn(async () => true)} />);
    fireEvent.contextMenu(row("o1"));
    expect(screen.queryByText("Копировать")).toBeNull();
    expect(screen.queryByText("Вставить")).toBeNull();
  });
});
