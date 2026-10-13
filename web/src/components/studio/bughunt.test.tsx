import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { styleOf } from "@shared/shapeStyles";
import { structuredModel } from "../../test/fixtures";
import { field, renderWithModel } from "../../test/harness";
import type { ProcessLogicModel } from "../../types";
import { BlockShape } from "../idef0-editor/shapes";
import PropertiesPanel from "./PropertiesPanel";
import StyleEditor from "./StyleEditor";
import { setKindStyle } from "./style-ops";

afterEach(() => vi.useRealTimers());

const handlers = () => ({ onSelect: vi.fn(), onGoto: vi.fn(), onReveal: vi.fn(), onOpenDecomposition: vi.fn(), onOpenDoc: vi.fn(), onClose: vi.fn() });

describe("багхант: стрелка по умолчанию при развороте", () => {
  it("«Развернуть стрелку» снимает признак ветки по умолчанию: у нового источника своё правило «одна на узел»", () => {
    const m = structuredModel();
    m.flows = m.flows.map((f) => (f.id === "bf2" ? { ...f, is_default: true } : f));
    const r = renderWithModel(m, (model, onChange) => (
      <PropertiesPanel model={model} selection={{ kind: "flow", id: "bf2" }} session={{ id: "s", fragments: [], updatedAt: "t" }} issues={[]} activeKind="bpmn" onChange={onChange} {...handlers()} />
    ));
    fireEvent.click(screen.getByText("Развернуть стрелку"));
    const flow = r.model().flows.find((f) => f.id === "bf2")!;
    expect(flow).toMatchObject({ from: "b2", to: "b1" });
    expect(flow.is_default).toBeUndefined();
  });
});

describe("багхант: название блока IDEF0 при своём размере шрифта", () => {
  it("многострочное название центрируется по блоку при любом размере", () => {
    const node = { ...structuredModel().nodes.find((n) => n.id === "o1")!, name: "Очень длинное название функции, которое займёт три строки в блоке" };
    const box = { x: 0, y: 0, w: 200, h: 100 };
    const middle = (size: number) => {
      const m = setKindStyle(structuredModel(), "idef0_block", { font_size: size });
      const c = render(<svg><BlockShape fn={{ node, box, code: "A1", hasChildren: false } as never} selected={false} hot={false} style={styleOf(m, "idef0_block")} /></svg>).container;
      const ys = [...c.querySelectorAll("tspan")].map((t) => Number(t.getAttribute("y")));
      expect(ys.length).toBe(3);
      return (ys[0] + ys[ys.length - 1]) / 2;
    };
    // середина строк одна и та же при размере 12 и 24: текст не сползает вниз
    expect(middle(24)).toBeCloseTo(middle(12), 0);
  });
});

describe("багхант: оформление не теряется при смене фигуры до паузы", () => {
  it("смена вида до записи: цвет записывается прежнему виду", () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const m: ProcessLogicModel = structuredModel();
    const { rerender } = render(<StyleEditor model={m} kind="task" onChange={onChange} />);
    fireEvent.change(field("Заливка"), { target: { value: "#ffeecc" } });
    expect(onChange).not.toHaveBeenCalled();
    rerender(<StyleEditor model={m} kind="gateway" onChange={onChange} />);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0].shape_styles).toEqual({ task: { fill: "#ffeecc" } });
    act(() => void vi.advanceTimersByTime(1000));
    expect(onChange).toHaveBeenCalledTimes(1); // таймер прежнего вида больше ничего не пишет
  });

  it("закрытие панели до записи: цвет записывается", () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const { unmount } = render(<StyleEditor model={structuredModel()} kind="task" onChange={onChange} />);
    fireEvent.change(field("Заливка"), { target: { value: "#ffeecc" } });
    unmount();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0].shape_styles).toEqual({ task: { fill: "#ffeecc" } });
  });
});
