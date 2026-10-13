import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { session, structuredModel } from "../../test/fixtures";
import { renderWithModel } from "../../test/harness";
import PropertiesPanel from "./PropertiesPanel";
import Studio from "./Studio";
import { deleteDiagramImpact, functionUsage } from "./usage-ops";

describe("использование функции на диаграммах", () => {
  it("операция: блок на диаграмме подпроцесса и своя диаграмма BPMN; подпроцесс: блок, шаг общей схемы и декомпозиция", () => {
    const m = structuredModel();
    expect(functionUsage(m, "o1").map((u) => [u.kind, u.title])).toEqual([
      ["block", "IDEF0 B002.01.00"],
      ["operation", "BPMN B002.01.01"],
    ]);
    expect(functionUsage(m, "s1").map((u) => [u.kind, u.title])).toEqual([
      ["block", "IDEF0 B002.00.00"],
      ["scheme", "BPMN"],
      ["decomposition", "IDEF0 B002.01.00"],
    ]);
    // операция без шагов диаграммы BPMN не числится на ней
    expect(functionUsage(m, "o3").map((u) => u.kind)).toEqual(["block"]);
  });

  it("шаг диаграммы операции изображён только на ней; несуществующий id и не функция — пусто", () => {
    const m = structuredModel();
    expect(functionUsage(m, "b1").map((u) => [u.kind, u.title])).toEqual([["step", "BPMN B002.01.01"]]);
    expect(functionUsage(m, "нет")).toEqual([]);
  });

  it("удаление: блок уходит с диаграммы родителя, диаграммы функции и вложенных исчезают", () => {
    const m = structuredModel();
    expect(deleteDiagramImpact(m, "o1")).toEqual({ changed: ["IDEF0 B002.01.00"], removed: ["BPMN B002.01.01"] });
    const s1 = deleteDiagramImpact(m, "s1");
    expect(s1.changed).toEqual(["IDEF0 B002.00.00", "BPMN"]);
    expect(s1.removed).toEqual(["IDEF0 B002.01.00", "BPMN B002.01.01"]);
  });

  it("панель свойств перечисляет диаграммы со ссылками", () => {
    const h = { onSelect: vi.fn(), onGoto: vi.fn(), onReveal: vi.fn(), onOpenDecomposition: vi.fn(), onOpenDoc: vi.fn(), onClose: vi.fn() };
    renderWithModel(structuredModel(), (m, onChange) => (
      <PropertiesPanel model={m} selection={{ kind: "node", id: "s1" }} session={{ id: "s", fragments: [], updatedAt: "t" }} issues={[]} activeKind="idef0" onChange={onChange} {...h} />
    ));
    expect(screen.getByText("Изображена на диаграммах:")).toBeTruthy();
    fireEvent.click(screen.getAllByText("IDEF0 B002.01.00")[0]);
    expect(h.onOpenDecomposition).toHaveBeenCalledWith("s1");
    fireEvent.click(screen.getByText("BPMN"));
    expect(h.onReveal).toHaveBeenCalledWith("s1", "bpmn");
  });

  it("подтверждение удаления в студии называет диаграммы", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const sess = session(structuredModel());
    render(<Studio session={sess} busy={false} onSave={vi.fn(async () => true)} />);
    fireEvent.contextMenu(document.querySelector('[data-nav-fn="o1"]')!);
    fireEvent.click(screen.getByText("Удалить…"));
    const text = String(confirm.mock.calls[0][0]);
    expect(text).toMatch(/блок уйдёт с диаграмм: IDEF0 B002\.01\.00/);
    expect(text).toMatch(/исчезнут диаграммы: BPMN B002\.01\.01/);
    confirm.mockRestore();
  });
});
