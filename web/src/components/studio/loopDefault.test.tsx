import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { structuredModel } from "../../test/fixtures";
import { field, renderWithModel } from "../../test/harness";
import type { ProcessFlow } from "../../types";
import { setDefaultFlow } from "../bpmn-editor/model-ops";
import { FlowShape } from "../bpmn-editor/shapes";
import PropertiesPanel from "./PropertiesPanel";

const handlers = () => ({ onSelect: vi.fn(), onGoto: vi.fn(), onReveal: vi.fn(), onOpenDecomposition: vi.fn(), onOpenDoc: vi.fn(), onClose: vi.fn() });

describe("цикличность задачи и ветка по умолчанию", () => {
  it("панель шага: цикличность выбирается из списка и снимается", () => {
    const r = renderWithModel(structuredModel(), (m, onChange) => (
      <PropertiesPanel model={m} selection={{ kind: "node", id: "b1" }} session={{ id: "s", fragments: [], updatedAt: "t" }} issues={[]} activeKind="bpmn" onChange={onChange} {...handlers()} />
    ));
    fireEvent.change(field("Цикличность (BPMN)"), { target: { value: "parallel" } });
    expect(r.model().nodes.find((n) => n.id === "b1")!.loop).toBe("parallel");
    fireEvent.change(field("Цикличность (BPMN)"), { target: { value: "" } });
    expect(r.model().nodes.find((n) => n.id === "b1")!.loop).toBeUndefined();
  });

  it("ветка по умолчанию одна на узел: включение снимает признак с остальных исходящих стрелок", () => {
    const base = structuredModel();
    const first = base.flows.find((f) => f.from === "b1")!;
    const extra: ProcessFlow = { ...first, id: "fx", to: first.to, condition: "иначе" };
    const m = { ...base, flows: [...base.flows, extra] };
    const a = setDefaultFlow(m, first.id, true);
    expect(a.flows.find((f) => f.id === first.id)!.is_default).toBe(true);
    const b = setDefaultFlow(a, "fx", true);
    expect(b.flows.filter((f) => f.from === "b1" && f.is_default).map((f) => f.id)).toEqual(["fx"]);
    const c = setDefaultFlow(b, "fx", false);
    expect(c.flows.some((f) => f.is_default)).toBe(false);
  });

  it("панель стрелки: флажок «Ветка по умолчанию»", () => {
    const base = structuredModel();
    const flow = base.flows.find((f) => f.from === "b1")!;
    const r = renderWithModel(base, (m, onChange) => (
      <PropertiesPanel model={m} selection={{ kind: "flow", id: flow.id }} session={{ id: "s", fragments: [], updatedAt: "t" }} issues={[]} activeKind="bpmn" onChange={onChange} {...handlers()} />
    ));
    fireEvent.click(field("Ветка по умолчанию"));
    expect(r.model().flows.find((f) => f.id === flow.id)!.is_default).toBe(true);
  });

  it("стрелка по умолчанию рисуется с косой чертой у начала", () => {
    const flow: ProcessFlow = { id: "f", from: "a", to: "b", condition: null, source: [], confirmed_by: [] };
    const count = (f: ProcessFlow) => render(<svg><FlowShape flow={f} points={[[0, 0], [100, 0]]} selected={false} /></svg>).container.querySelectorAll("path").length;
    expect(count({ ...flow, is_default: true })).toBe(count(flow) + 1);
  });
});
