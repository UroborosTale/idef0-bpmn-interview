import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { layoutIdef0 } from "@shared/idef0Layout";
import { validateModel } from "@shared/validate";
import { structuredModel } from "../../test/fixtures";
import { renderWithModel } from "../../test/harness";
import { ArrowShape } from "../idef0-editor/shapes";
import { canTunnel, markOf, setArrowMark, tunnelOf } from "../idef0-editor/tunnels";
import PropertiesPanel from "./PropertiesPanel";

const arrowOf = (m: ReturnType<typeof structuredModel>, key: string) => layoutIdef0(m, "s1").arrows.find((a) => a.key === key)!;

describe("туннели стрелок IDEF0: операции", () => {
  it("включение и снятие по концам, пустое чистится, повторное включение не плодит записей", () => {
    const m = structuredModel();
    const a = arrowOf(m, "input:o1:d1");
    const up = setArrowMark(m, a, "up", "tunnel");
    expect(up.nodes.find((n) => n.id === "o1")!.tunnels).toEqual({ "input:d1": { up: true } });
    const both = setArrowMark(setArrowMark(up, a, "down", "tunnel"), a, "down", "tunnel");
    expect(both.nodes.find((n) => n.id === "o1")!.tunnels).toEqual({ "input:d1": { up: true, down: true } });
    expect(tunnelOf(both, a)).toEqual({ up: true, down: true });
    // «Граница» на том же конце заменяет туннель (скобки и штрих вместе не рисуются)
    const boundary = setArrowMark(both, a, "up", "boundary");
    expect(boundary.nodes.find((n) => n.id === "o1")!.tunnels).toEqual({ "input:d1": { upKind: "boundary", down: true } });
    expect(markOf(boundary, a, "up")).toBe("boundary");
    expect(tunnelOf(boundary, a)).toEqual({ up: false, down: true });
    // В11: «ссылка на диаграмму» — третий вид конца, тоже вместо туннеля
    const offpage = setArrowMark(boundary, a, "up", "offpage");
    expect(offpage.nodes.find((n) => n.id === "o1")!.tunnels).toEqual({ "input:d1": { upKind: "offpage", down: true } });
    expect(markOf(offpage, a, "up")).toBe("offpage");
    expect(tunnelOf(offpage, a)).toEqual({ up: false, down: true });
    const off = setArrowMark(setArrowMark(boundary, a, "up", "none"), a, "down", "none");
    expect(off.nodes.find((n) => n.id === "o1")).not.toHaveProperty("tunnels");
    expect(tunnelOf(off, a)).toEqual({ up: false, down: false });
  });

  it("туннелируются только внешние виды стрелок", () => {
    const m = structuredModel();
    expect(["input", "output", "control", "controlData"].every((k) => canTunnel(k as never))).toBe(true);
    expect(["link", "controlLink", "role", "system"].some((k) => canTunnel(k as never))).toBe(false);
    const link = arrowOf(m, "link:o2:d2");
    expect(setArrowMark(m, link, "up", "tunnel")).toBe(m);
    expect(setArrowMark(m, link, "up", "boundary")).toBe(m);
  });
});

describe("туннели стрелок IDEF0: отрисовка", () => {
  const draw = (flags: { tunnelUp?: boolean; tunnelDown?: boolean; boundaryUp?: boolean; boundaryDown?: boolean }) => {
    const a = { ...arrowOf(structuredModel(), "input:o1:d1"), ...flags };
    return render(<svg><ArrowShape arrow={a} selected={false} /></svg>).container.querySelectorAll("[data-tunnel]").length;
  };
  it("скобки рисуются у каждого помеченного конца, штрих границы — одна линия", () => {
    expect(draw({})).toBe(0);
    expect(draw({ tunnelUp: true })).toBe(2); // скобки «(» и «)»
    expect(draw({ tunnelUp: true, tunnelDown: true })).toBe(4);
    expect(draw({ boundaryUp: true })).toBe(1); // штрих: одна прямая линия поперёк стрелки
    expect(draw({ boundaryUp: true, boundaryDown: true })).toBe(2);
  });

  it("В11: ссылка на диаграмму — значок страницы у помеченного конца", () => {
    const marks = (flags: { offpageUp?: boolean; offpageDown?: boolean }) => {
      const a = { ...arrowOf(structuredModel(), "input:o1:d1"), ...flags };
      return render(<svg><ArrowShape arrow={a} selected={false} /></svg>).container.querySelectorAll("[data-offpage]").length;
    };
    expect(marks({})).toBe(0);
    expect(marks({ offpageUp: true })).toBe(1);
    expect(marks({ offpageUp: true, offpageDown: true })).toBe(2);
  });
});

describe("туннели стрелок IDEF0: панель свойств", () => {
  const h = () => ({ onSelect: vi.fn(), onGoto: vi.fn(), onReveal: vi.fn(), onOpenDecomposition: vi.fn(), onOpenDoc: vi.fn(), onClose: vi.fn() });
  const panel = (m: ReturnType<typeof structuredModel>, key: string) =>
    renderWithModel(m, (model, onChange) => (
      <PropertiesPanel model={model} selection={{ kind: "arrow", arrow: arrowOf(model, key) } as never} session={{ id: "s", fragments: [], updatedAt: "t" }} issues={[]} activeKind="idef0" onChange={onChange} {...h()} />
    ));

  it("выбор в панели меняет модель; туннель у свободного конца снимает предупреждение о балансе", () => {
    const m = structuredModel();
    m.nodes.find((n) => n.id === "o1")!.inputs.push("d4"); // лишний вход, которого нет у родителя
    const unbalanced = (x: typeof m) => validateModel(x).filter((i) => i.rule === "idef0_unbalanced" && i.element_id === "s1");
    expect(unbalanced(m)).toHaveLength(1);
    const r = panel(m, "input:o1:d4");
    fireEvent.change(screen.getByLabelText(/У свободного конца/), { target: { value: "tunnel" } });
    expect(r.model().nodes.find((n) => n.id === "o1")!.tunnels).toEqual({ "input:d4": { up: true } });
    expect(unbalanced(r.model())).toEqual([]);
    expect((screen.getByLabelText(/У свободного конца/) as HTMLSelectElement).value).toBe("tunnel");
    // «Граница» тоже снимает предупреждение: стрелка кончается на рамке диаграммы
    fireEvent.change(screen.getByLabelText(/У свободного конца/), { target: { value: "boundary" } });
    expect(r.model().nodes.find((n) => n.id === "o1")!.tunnels).toEqual({ "input:d4": { upKind: "boundary" } });
    expect(unbalanced(r.model())).toEqual([]);
    // В11: «ссылка на диаграмму» — тоже помеченный конец
    fireEvent.change(screen.getByLabelText(/У свободного конца/), { target: { value: "offpage" } });
    expect(r.model().nodes.find((n) => n.id === "o1")!.tunnels).toEqual({ "input:d4": { upKind: "offpage" } });
    expect(unbalanced(r.model())).toEqual([]);
    expect((screen.getByLabelText(/У свободного конца/) as HTMLSelectElement).value).toBe("offpage");
    fireEvent.change(screen.getByLabelText(/У свободного конца/), { target: { value: "none" } });
    expect(r.model().nodes.find((n) => n.id === "o1")).not.toHaveProperty("tunnels");
    expect(unbalanced(r.model())).toHaveLength(1);
  });

  it("раздела нет у связи между функциями и у механизма", () => {
    panel(structuredModel(), "link:o2:d2");
    expect(screen.queryByText("Туннель и граница")).toBeNull();
  });
});
