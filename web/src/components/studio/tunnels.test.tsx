import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { layoutIdef0 } from "@shared/idef0Layout";
import { validateModel } from "@shared/validate";
import { structuredModel } from "../../test/fixtures";
import { renderWithModel } from "../../test/harness";
import { ArrowShape } from "../idef0-editor/shapes";
import { canTunnel, setArrowTunnel, tunnelOf } from "../idef0-editor/tunnels";
import PropertiesPanel from "./PropertiesPanel";

const arrowOf = (m: ReturnType<typeof structuredModel>, key: string) => layoutIdef0(m, "s1").arrows.find((a) => a.key === key)!;

describe("туннели стрелок IDEF0: операции", () => {
  it("включение и снятие по концам, пустое чистится, повторное включение не плодит записей", () => {
    const m = structuredModel();
    const a = arrowOf(m, "input:o1:d1");
    const up = setArrowTunnel(m, a, "up", true);
    expect(up.nodes.find((n) => n.id === "o1")!.tunnels).toEqual({ "input:d1": { up: true } });
    const both = setArrowTunnel(setArrowTunnel(up, a, "down", true), a, "down", true);
    expect(both.nodes.find((n) => n.id === "o1")!.tunnels).toEqual({ "input:d1": { up: true, down: true } });
    expect(tunnelOf(both, a)).toEqual({ up: true, down: true });
    const off = setArrowTunnel(setArrowTunnel(both, a, "up", false), a, "down", false);
    expect(off.nodes.find((n) => n.id === "o1")).not.toHaveProperty("tunnels");
    expect(tunnelOf(off, a)).toEqual({ up: false, down: false });
  });

  it("туннелируются только внешние виды стрелок", () => {
    const m = structuredModel();
    expect(["input", "output", "control", "controlData"].every((k) => canTunnel(k as never))).toBe(true);
    expect(["link", "controlLink", "role", "system"].some((k) => canTunnel(k as never))).toBe(false);
    const link = arrowOf(m, "link:o2:d2");
    expect(setArrowTunnel(m, link, "up", true)).toBe(m);
  });
});

describe("туннели стрелок IDEF0: отрисовка", () => {
  const draw = (flags: { tunnelUp?: boolean; tunnelDown?: boolean }) => {
    const a = { ...arrowOf(structuredModel(), "input:o1:d1"), ...flags };
    return render(<svg><ArrowShape arrow={a} selected={false} /></svg>).container.querySelectorAll("[data-tunnel]").length;
  };
  it("скобки рисуются у каждого помеченного конца", () => {
    expect(draw({})).toBe(0);
    expect(draw({ tunnelUp: true })).toBe(2); // скобки «(» и «)»
    expect(draw({ tunnelUp: true, tunnelDown: true })).toBe(4);
  });
});

describe("туннели стрелок IDEF0: панель свойств", () => {
  const h = () => ({ onSelect: vi.fn(), onGoto: vi.fn(), onReveal: vi.fn(), onOpenDecomposition: vi.fn(), onOpenDoc: vi.fn(), onClose: vi.fn() });
  const panel = (m: ReturnType<typeof structuredModel>, key: string) =>
    renderWithModel(m, (model, onChange) => (
      <PropertiesPanel model={model} selection={{ kind: "arrow", arrow: arrowOf(model, key) } as never} session={{ id: "s", fragments: [], updatedAt: "t" }} issues={[]} activeKind="idef0" onChange={onChange} {...h()} />
    ));

  it("флажки меняют модель; туннель у свободного конца снимает предупреждение о балансе", () => {
    const m = structuredModel();
    m.nodes.find((n) => n.id === "o1")!.inputs.push("d4"); // лишний вход, которого нет у родителя
    const unbalanced = (x: typeof m) => validateModel(x).filter((i) => i.rule === "idef0_unbalanced" && i.element_id === "s1");
    expect(unbalanced(m)).toHaveLength(1);
    const r = panel(m, "input:o1:d4");
    fireEvent.click(screen.getByLabelText(/У свободного конца/));
    expect(r.model().nodes.find((n) => n.id === "o1")!.tunnels).toEqual({ "input:d4": { up: true } });
    expect(unbalanced(r.model())).toEqual([]);
    expect((screen.getByLabelText(/У свободного конца/) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByLabelText(/У свободного конца/));
    expect(r.model().nodes.find((n) => n.id === "o1")).not.toHaveProperty("tunnels");
    expect(unbalanced(r.model())).toHaveLength(1);
  });

  it("раздела нет у связи между функциями и у механизма", () => {
    panel(structuredModel(), "link:o2:d2");
    expect(screen.queryByText("Туннель")).toBeNull();
  });
});
