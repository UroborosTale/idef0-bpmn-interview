import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { validateModel } from "@shared/validate";
import { session, structuredModel } from "../../test/fixtures";
import { commit, field, renderWithModel } from "../../test/harness";
import type { ProcessLogicModel, ProcessNode } from "../../types";
import { EVENT_PALETTE, addBoundaryEvent, addNodeAt, setEventDirection, setEventPosition, setEventTrigger, setNodeType } from "../bpmn-editor/model-ops";
import { NodeShape } from "../bpmn-editor/shapes";
import { quickFixFor } from "./quick-fixes";
import PropertiesPanel from "./PropertiesPanel";
import Studio from "./Studio";

type M = ProcessLogicModel;
const get = (m: M, id: string) => m.nodes.find((n) => n.id === id)!;
const event = (id: string, extra: Partial<ProcessNode>): ProcessNode => ({ ...get(structuredModel(), "b0"), id, name: `Событие ${id}`, ...extra });
const withEvent = (e: ProcessNode): M => ({ ...structuredModel(), nodes: [...structuredModel().nodes, e] });

describe("операции над видом и триггером события", () => {
  it("смена триггера у начального события; «без триггера» убирает поле", () => {
    const m = structuredModel();
    const a = setEventTrigger(m, "b0", { type: "timer", timer: { kind: "date", value: "2026-12-31" } });
    expect(get(a, "b0")).toMatchObject({ subtype: "start", trigger: { type: "timer", timer: { kind: "date", value: "2026-12-31" } } });
    expect(get(setEventTrigger(a, "b0", null), "b0").trigger).toBeNull();
    expect(setEventTrigger(m, "b1", { type: "timer" })).toBe(m); // у задачи триггера нет
  });

  it("промежуточное событие: выбирая сообщение, получаем «ждёт»; сигнал — «выбрасывает»; направление правится, если триггер так не бывает", () => {
    let m = withEvent(event("e", { subtype: "intermediate" }));
    m = setEventTrigger(m, "e", { type: "message" });
    expect(get(m, "e").trigger).toMatchObject({ type: "message", direction: "catch" });
    m = setEventDirection(m, "e", "throw");
    expect(get(m, "e").trigger).toMatchObject({ type: "message", direction: "throw" });
    m = setEventTrigger(m, "e", { type: "timer", direction: "throw" }); // таймер выбросить нельзя
    expect(get(m, "e").trigger).toMatchObject({ type: "timer", direction: "catch" });
    m = setEventDirection(m, "e", "throw"); // у таймера нет «выбрасывает» — триггер сбрасывается
    expect(get(m, "e").trigger).toBeNull();
  });

  it("смена вида: триггер, не подходящий новому виду, сбрасывается; подходящий остаётся", () => {
    let m = withEvent(event("e", { subtype: "start", trigger: { type: "timer" } }));
    m = setEventPosition(m, "e", "end");
    expect(get(m, "e")).toMatchObject({ subtype: "end", trigger: null });
    m = setEventTrigger(m, "e", { type: "message", name: "Готово" });
    m = setEventPosition(m, "e", "start");
    expect(get(m, "e")).toMatchObject({ subtype: "start", trigger: { type: "message", name: "Готово" } });
    expect(get(setEventPosition(withEvent(event("x", { subtype: "timer" })), "x", "intermediate"), "x")).toMatchObject({ subtype: "intermediate", trigger: { type: "timer" } });
  });

  it("прежняя запись при правке переходит в новую: subtype → intermediate", () => {
    const m = setEventTrigger(withEvent(event("old", { subtype: "message" })), "old", { type: "message", name: "Заявка", direction: "catch" });
    expect(get(m, "old")).toMatchObject({ subtype: "intermediate", trigger: { type: "message", name: "Заявка" } });
  });

  it("граничное событие создаётся с триггером и названием по смыслу; смена типа фигуры убирает триггер", () => {
    const r = addBoundaryEvent(structuredModel(), "b1", "conditional");
    expect(get(r.model, r.id!)).toMatchObject({ subtype: "intermediate", trigger: { type: "conditional" }, name: "Условие выполнено", attached_to: "b1" });
    const e = withEvent(event("e", { subtype: "end", trigger: { type: "terminate" } }));
    expect(get(setNodeType(e, "e", "task"), "e").trigger).toBeNull();
  });

  it("палитра событий: заготовки допустимы по BPMN и называются фактами", () => {
    expect(EVENT_PALETTE.length).toBeGreaterThanOrEqual(15);
    for (const p of EVENT_PALETTE) {
      const m = addNodeAt(structuredModel(), p.spec, 400, 150).model;
      const created = m.nodes[m.nodes.length - 1];
      expect(created.trigger).toEqual(p.spec.trigger);
      const issues = validateModel({ ...m, nodes: m.nodes.map((n) => (n.id === created.id ? { ...n, bpmn_scope: "o1" } : n)) }).filter((i) => i.element_id === created.id && (i.rule === "bpmn_event_trigger_invalid" || i.rule === "bpmn_event_not_fact"));
      expect(issues, p.label).toEqual([]);
    }
  });
});

describe("карточка события", () => {
  const panel = (model: M, id: string) =>
    renderWithModel(model, (m, onChange) => (
      <PropertiesPanel model={m} selection={{ kind: "node", id }} session={{ id: "s", fragments: [], updatedAt: "t" }} issues={[]} activeKind="bpmn" onChange={onChange} onSelect={vi.fn()} onGoto={vi.fn()} onReveal={vi.fn()} onOpenDecomposition={vi.fn()} onOpenDoc={vi.fn()} onClose={vi.fn()} />
    ));

  it("у начального события: допустимые триггеры только для начала; параметры таймера записываются", () => {
    const p = panel(structuredModel(), "b0");
    const trigger = field("Триггер") as unknown as HTMLSelectElement;
    const values = [...trigger.options].map((o) => o.value);
    expect(values).toEqual(["none", "message", "timer", "conditional", "signal", "multiple", "parallel_multiple"]);
    expect(screen.queryByLabelText("Направление")).toBeNull(); // начало всегда ждёт
    fireEvent.change(trigger, { target: { value: "timer" } });
    expect(p.model().nodes.find((n) => n.id === "b0")!.trigger).toMatchObject({ type: "timer" });
    fireEvent.change(field("Когда срабатывает"), { target: { value: "cycle" } });
    commit(field("Значение таймера"), "R/P1W");
    expect(p.model().nodes.find((n) => n.id === "b0")!.trigger).toMatchObject({ type: "timer", timer: { kind: "cycle", value: "R/P1W" } });
    expect(screen.queryByText(/Заполните:/)).toBeNull();
  });

  it("промежуточное событие: направление и название сообщения; предупреждение, пока название не указано", () => {
    const p = panel(withEvent(event("e", { subtype: "intermediate", trigger: { type: "message", direction: "catch" } })), "e");
    expect(screen.getByText(/Заполните: не указано: название сообщения/)).toBeTruthy();
    fireEvent.change(field("Направление"), { target: { value: "throw" } });
    expect(p.model().nodes.find((n) => n.id === "e")!.trigger).toMatchObject({ type: "message", direction: "throw" });
    commit(field("Название сообщения"), "Заявка отправлена");
    expect(p.model().nodes.find((n) => n.id === "e")!.trigger).toMatchObject({ name: "Заявка отправлена" });
    expect(screen.queryByText(/Заполните:/)).toBeNull();
  });

  it("событие «несколько»: набор триггеров отмечается флажками", () => {
    const p = panel(withEvent(event("e", { subtype: "start", trigger: { type: "multiple" } })), "e");
    fireEvent.click(screen.getByLabelText("Сообщение"));
    fireEvent.click(screen.getByLabelText("Таймер"));
    expect(p.model().nodes.find((n) => n.id === "e")!.trigger).toMatchObject({ type: "multiple", members: ["message", "timer"] });
  });

  it("граничное событие: вид нельзя выбрать, триггеры — только граничные", () => {
    const m = addBoundaryEvent(structuredModel(), "b1", "timer");
    panel(m.model, m.id!);
    expect((field("Вид события") as HTMLInputElement).readOnly).toBe(true);
    const values = [...(field("Триггер") as unknown as HTMLSelectElement).options].map((o) => o.value);
    expect(values).toContain("error");
    expect(values).not.toContain("none");
    expect(values).not.toContain("terminate");
  });

  it("событие с недопустимым триггером: предупреждение и пометка в списке", () => {
    panel(withEvent(event("e", { subtype: "start", trigger: { type: "error" } })), "e");
    expect(screen.getByText(/начальное событие не может иметь триггер «ошибка»/)).toBeTruthy();
    expect(screen.getByText(/Ошибка \(не подходит этому виду\)/)).toBeTruthy();
  });

  it("у задачи кнопка «Другой триггер» добавляет граничное событие нужного типа", () => {
    const p = panel(structuredModel(), "b1");
    fireEvent.change(screen.getByLabelText("Другой триггер"), { target: { value: "escalation" } });
    expect(p.model().nodes.find((n) => n.attached_to === "b1")!.trigger).toMatchObject({ type: "escalation" });
  });
});

describe("значки на диаграмме", () => {
  const draw = (n: ProcessNode, boundary = false) =>
    render(
      <svg>
        <NodeShape node={n} box={{ x: 100, y: 100, w: 36, h: 36 }} selected={false} hot={false} boundary={boundary} />
      </svg>,
    ).container;

  it("ждущее событие рисуется контуром, выбрасывающее — залитым; без триггера значка нет", () => {
    const wait = draw(event("a", { subtype: "intermediate", trigger: { type: "message", direction: "catch" } }));
    expect(wait.querySelector("[data-trigger=message]")).toBeTruthy();
    expect(wait.querySelector("[data-trigger=message]")!.getAttribute("data-throwing")).toBeNull();
    expect([...wait.querySelectorAll("[data-trigger] path")].some((p) => p.getAttribute("fill") !== "none")).toBe(false);
    const sent = draw(event("b", { subtype: "intermediate", trigger: { type: "message", direction: "throw" } }));
    expect(sent.querySelector("[data-trigger=message]")!.getAttribute("data-throwing")).toBe("true");
    expect([...sent.querySelectorAll("[data-trigger] path")].some((p) => p.getAttribute("fill") === "#1e293b")).toBe(true);
    expect(draw(event("c", { subtype: "start" })).querySelector("[data-trigger]")).toBeNull();
  });

  it("кольца по виду: начало — одно, промежуточное и граничное — двойное, конец — толстое; подсказка называет триггер", () => {
    const rings = (c: Element) => c.querySelectorAll("circle").length;
    expect(rings(draw(event("s", { subtype: "start" })))).toBe(1);
    expect(rings(draw(event("i", { subtype: "intermediate" })))).toBe(2);
    expect(rings(draw(event("g", { subtype: "intermediate", trigger: { type: "error" } }), true))).toBe(2); // два кольца; значок ошибки — контур без круга
    const end = draw(event("e", { subtype: "end", trigger: { type: "terminate" } }));
    expect(end.querySelector("[data-event-position=end]")).toBeTruthy();
    expect(end.querySelector("title")!.textContent).toBe("Завершение процесса");
    const timer = draw(event("t", { subtype: "intermediate", trigger: { type: "timer", direction: "catch", timer: { kind: "duration", value: "P3D" } } }));
    expect(timer.querySelector("title")!.textContent).toBe("Таймер: P3D (ждёт)");
  });

  it("граничное событие, не прерывающее задачу, — пунктирное кольцо", () => {
    const c = draw(event("g", { subtype: "intermediate", trigger: { type: "timer" }, interrupting: false }), true);
    expect([...c.querySelectorAll("circle")].some((x) => x.getAttribute("stroke-dasharray") === "4 3")).toBe(true);
  });
});

describe("проверки и быстрые исправления в студии", () => {
  it("быстрое исправление предлагает только допустимые триггеры и применяется", () => {
    const m = withEvent(event("e", { subtype: "start", trigger: { type: "error" }, bpmn_scope: "o1" }));
    const issue = validateModel(m).find((i) => i.rule === "bpmn_event_trigger_invalid" && i.element_id === "e")!;
    const fix = quickFixFor(m, issue)!;
    expect(fix.options!.map((o) => o.id)).toEqual(["none", "message", "timer", "conditional", "signal", "multiple", "parallel_multiple"]);
    const fixed = fix.apply(m, "message");
    expect(get(fixed, "e").trigger).toMatchObject({ type: "message" });
    expect(validateModel(fixed).some((i) => i.rule === "bpmn_event_trigger_invalid")).toBe(false);
    expect(get(fix.apply(m, "none"), "e").trigger).toBeNull();
  });

  it("граничное событие без триггера: исправление предлагает граничные триггеры", () => {
    const m = withEvent(event("g", { subtype: "intermediate", attached_to: "b1", bpmn_scope: "o1" }));
    const issue = validateModel(m).find((i) => i.rule === "bpmn_boundary_no_trigger")!;
    const fix = quickFixFor(m, issue)!;
    expect(fix.options!.map((o) => o.id)).toContain("timer");
    expect(fix.options!.map((o) => o.id)).not.toContain("none");
    expect(get(fix.apply(m, "timer"), "g").trigger).toMatchObject({ type: "timer" });
  });
});

describe("палитра в окне студии", () => {
  it("«События с триггером»: щелчок добавляет событие с триггером и открывает его название", () => {
    const onSave = vi.fn(async (_: M) => true);
    render(<Studio session={session(structuredModel())} busy={false} onSave={onSave} />);
    fireEvent.click(document.querySelector('[data-nav-bpmn="o1"]')!);
    const before = document.querySelectorAll(".studio g[data-node-id]").length;
    fireEvent.click(screen.getByText("События с триггером"));
    fireEvent.click(screen.getByText("Отправить сообщение"));
    expect(document.querySelectorAll(".studio g[data-node-id]").length).toBe(before + 1);
    expect(document.querySelector('[data-trigger="message"][data-throwing="true"]')).toBeTruthy();
  });
});
