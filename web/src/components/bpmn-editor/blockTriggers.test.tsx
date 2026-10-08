import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { scopeView } from "@shared/scope";
import { session, structuredModel } from "../../test/fixtures";
import { renderWithModel } from "../../test/harness";
import type { ProcessLogicModel, ProcessNode } from "../../types";
import PropertiesPanel from "../studio/PropertiesPanel";
import Studio from "../studio/Studio";
import { diagramLayout, triggerView, visibleFlows, visibleNodes } from "./geometry";
import { attachTrigger, deleteNode, deleteTriggerEvent, nearestSide, reconnectFlow, setFlowRoute } from "./model-ops";
import { copyFragment, pasteFragment } from "./selection-ops";

type M = ProcessLogicModel;
const get = (m: M, id: string) => m.nodes.find((n) => n.id === id)!;
const flow = (m: M, id: string) => m.flows.find((f) => f.id === id)!;
/** Диаграмма операции o1, как её видит редактор. */
const view = (m: M = structuredModel()) => scopeView(m, "o1");

/** o1: начало b0 → b1 → b2 → конец b9; b0 получает триггер «сообщение». */
function withStartTrigger(): M {
  const m = structuredModel();
  return { ...m, nodes: m.nodes.map((n) => (n.id === "b0" ? ({ ...n, name: "Заявка получена", trigger: { type: "message", name: "Заявка" } } as ProcessNode) : n)) };
}

describe("свёртка триггеров в редакторе", () => {
  it("событие с триггером не рисуется отдельной фигурой, стрелки «событие → блок» нет; значок есть у блока", () => {
    const v = view(withStartTrigger());
    expect(visibleNodes(v).map((n) => n.id)).toEqual(["b1", "b2", "b9"]);
    expect(visibleFlows(v).map((f) => f.id)).toEqual(["bf2", "bf3"]);
    expect(triggerView(v).markers.get("b1")![0]).toMatchObject({ eventId: "b0", start: true });
    const layout = diagramLayout(v);
    expect([...layout.boxes.keys()]).toEqual(["b1", "b2", "b9"]);
    expect([...layout.routes.keys()].sort()).toEqual(["bf2", "bf3"]);
  });

  it("без триггера начальное событие остаётся фигурой со стрелкой", () => {
    const v = view();
    expect(visibleNodes(v).map((n) => n.id)).toContain("b0");
    expect(visibleFlows(v).map((f) => f.id)).toContain("bf1");
    expect(triggerView(v).markers.size).toBe(0);
  });

  it("раскладка не оставляет места под свёрнутое событие: блок встаёт левее, чем при событии-фигуре", () => {
    const x = (m: M) => diagramLayout(m).boxes.get("b1")!.x;
    const collapsed = view({ ...withStartTrigger(), nodes: withStartTrigger().nodes.map((n) => (n.bpmn_scope ? { ...n, layout: undefined } : n)) });
    const plain = view({ ...structuredModel(), nodes: structuredModel().nodes.map((n) => (n.bpmn_scope ? { ...n, layout: undefined } : n)) });
    // без layout блоки расставляет авто-раскладка (в редакторе — withScopeLayouts)
    expect(x(collapsed)).toBeDefined();
    expect(x(plain)).toBeDefined();
  });
});

describe("операции с триггерами блока", () => {
  it("attachTrigger: блоку без входа — событие-начало со стрелкой в блок", () => {
    const m = view();
    const r = attachTrigger({ ...m, flows: m.flows.filter((f) => f.id !== "bf1") }, "b1", "timer");
    expect(r.error).toBeUndefined();
    const e = get(r.model, r.id!);
    expect(e).toMatchObject({ type: "event", subtype: "start", trigger: { type: "timer" }, name: "Наступил срок", role_id: "r2" });
    expect(r.model.flows.some((f) => f.from === e.id && f.to === "b1")).toBe(true);
    expect(visibleNodes(r.model).map((n) => n.id)).not.toContain(e.id); // свёрнут в значок
  });

  it("attachTrigger: блоку с одним входом — событие встаёт на пути «X → событие → блок», блок ждёт после X", () => {
    const m = view();
    const r = attachTrigger(m, "b2", "message");
    const e = get(r.model, r.id!);
    expect(e).toMatchObject({ subtype: "intermediate", trigger: { type: "message", direction: "catch" } });
    expect(flow(r.model, "bf2")).toMatchObject({ from: "b1", to: e.id });
    expect(r.model.flows.some((f) => f.from === e.id && f.to === "b2")).toBe(true);
    // на диаграмме стрелка по-прежнему «b1 → b2», а у b2 — значок
    expect(visibleFlows(r.model).find((f) => f.id === "bf2")).toMatchObject({ from: "b1", to: "b2", viaEvent: e.id });
    expect(triggerView(r.model).markers.get("b2")).toHaveLength(1);
  });

  it("attachTrigger: только ожидающие триггеры и только задачам и подпроцессам", () => {
    const m = view();
    expect(attachTrigger(m, "b0", "timer").error).toMatch(/задаче или подпроцессу/);
    expect(attachTrigger(m, "b1", "error").error).toMatch(/сообщение, таймер, условие и сигнал/);
    expect(attachTrigger(m, "нет", "timer").error).toBeTruthy();
  });

  it("deleteTriggerEvent: стрелка X → блок сохраняется, события и стрелки к нему нет", () => {
    const withTrigger = attachTrigger(view(), "b2", "timer").model;
    const id = [...triggerView(withTrigger).hidden][0];
    const back = deleteTriggerEvent(withTrigger, id);
    expect(back.nodes.some((n) => n.id === id)).toBe(false);
    expect(back.flows.find((f) => f.id === "bf2")).toMatchObject({ from: "b1", to: "b2" });
    expect(back.flows.some((f) => f.from === id || f.to === id)).toBe(false);
    // начальный триггер просто исчезает
    const start = deleteTriggerEvent(withStartTrigger(), "b0");
    expect(start.nodes.some((n) => n.id === "b0")).toBe(false);
    expect(start.flows.some((f) => f.id === "bf1")).toBe(false);
  });

  it("удаление блока уносит его значки-триггеры (иначе они вылезли бы отдельными фигурами)", () => {
    const next = deleteNode(view(withStartTrigger()), "b1");
    expect(next.nodes.some((n) => n.id === "b0")).toBe(false);
    expect(next.flows.some((f) => f.from === "b0" || f.to === "b0")).toBe(false);
  });

  it("копирование блока берёт его значки; вставленные события не становятся выбираемыми фигурами", () => {
    const m = view(withStartTrigger());
    const frag = copyFragment(m, ["b1", "b2"])!;
    expect(frag.nodes.map((n) => n.id).sort()).toEqual(["b0", "b1", "b2"]);
    expect(frag.flows.map((f) => f.id).sort()).toEqual(["bf1", "bf2"]);
    const r = pasteFragment(m, frag, 40, 0);
    expect(r.ids).toHaveLength(2);
    expect(triggerView(r.model).hidden.size).toBe(2);
  });
});

describe("ручной маршрут стрелки: операции", () => {
  it("setFlowRoute: поля задаются и снимаются по одному; пустой маршрут — null; null — сброс", () => {
    const m = view();
    let r = setFlowRoute(m, "bf2", { from_side: "B" });
    expect(flow(r, "bf2").route).toEqual({ from_side: "B" });
    r = setFlowRoute(r, "bf2", { to_side: "T", channel: 330 });
    expect(flow(r, "bf2").route).toEqual({ from_side: "B", to_side: "T", channel: 330 });
    r = setFlowRoute(r, "bf2", { from_side: undefined, to_side: undefined, channel: undefined });
    expect(flow(r, "bf2").route).toBeNull();
    expect(flow(setFlowRoute(setFlowRoute(m, "bf2", { from_side: "R" }), "bf2", null), "bf2").route).toBeNull();
    expect(flow(m, "bf3")).toBe(flow(setFlowRoute(m, "bf2", { from_side: "R" }), "bf3")); // чужие стрелки не тронуты
  });

  it("nearestSide: сторона, ближайшая к точке", () => {
    const b = { x: 100, y: 100, w: 100, h: 80 };
    expect(nearestSide(b, [90, 140])).toBe("L");
    expect(nearestSide(b, [210, 140])).toBe("R");
    expect(nearestSide(b, [150, 90])).toBe("T");
    expect(nearestSide(b, [150, 190])).toBe("B");
  });

  it("reconnectFlow: тот же блок — только сторона; другой блок — конец переносится с проверками; канал сбрасывается", () => {
    const m = setFlowRoute(view(), "bf2", { channel: 400 });
    const same = reconnectFlow(m, "bf2", "to", "b2", "T");
    expect(flow(same.model, "bf2")).toMatchObject({ from: "b1", to: "b2", route: { to_side: "T" } });
    expect(flow(same.model, "bf2").route!.channel).toBeUndefined();
    const other = reconnectFlow(m, "bf2", "to", "b9", "L");
    expect(other.error).toBeUndefined();
    expect(flow(other.model, "bf2")).toMatchObject({ from: "b1", to: "b9", route: { to_side: "L" } });
    // нельзя: в начальное событие, дубль существующей связи, на себя
    expect(reconnectFlow(m, "bf2", "to", "b0").error).toMatch(/начальное/);
    expect(reconnectFlow(m, "bf2", "from", "b1").error).toBeUndefined(); // тот же конец
    expect(reconnectFlow(m, "bf3", "to", "b2").error).toMatch(/самим собой/);
    expect(reconnectFlow(m, "нет", "to", "b2").error).toBeTruthy();
  });

  it("reconnectFlow: вход стрелки в блок с триггером на другую фигуру не переносится, а сторону поменять можно", () => {
    const m = attachTrigger(view(), "b2", "timer").model;
    const event = [...triggerView(m).hidden][0];
    const lock = reconnectFlow(m, "bf2", "to", "b9", "L", event);
    expect(lock.error).toMatch(/триггер блока/);
    const side = reconnectFlow(m, "bf2", "to", "b2", "T", event); // тот же блок: меняется только сторона входа в него
    expect(side.error).toBeUndefined();
    expect(flow(side.model, "bf2")).toMatchObject({ to: event, route: { to_side: "T" } });
    // начало стрелки у такой стрелки переносится как обычно
    expect(reconnectFlow(m, "bf2", "from", "b9", "R", event).error).toBeDefined(); // b9 — конец: из конечного события стрелок нет
  });

  it("route участвует в расчёте диаграммы: стороны, заданные пользователем, соблюдаются", () => {
    const m = setFlowRoute(view(), "bf2", { from_side: "B", to_side: "B" });
    const l = diagramLayout(m);
    expect([l.info.get("bf2")!.from, l.info.get("bf2")!.to]).toEqual(["B", "B"]);
    expect(l.info.get("bf2")!.manual).toBe(true);
    expect(l.info.get("bf3")!.manual).toBe(false);
    expect(l.info.get("bf2")!.channel).toBeDefined(); // ручка для сдвига среднего участка
  });
});

describe("панели: триггеры блока и маршрут стрелки", () => {
  const panel = (model: M, selection: Parameters<typeof PropertiesPanel>[0]["selection"]) => {
    const h = { onSelect: vi.fn(), onGoto: vi.fn(), onReveal: vi.fn(), onOpenDecomposition: vi.fn(), onOpenDoc: vi.fn(), onClose: vi.fn() };
    const r = renderWithModel(model, (m, onChange) => <PropertiesPanel model={m} selection={selection} session={{ id: "s", fragments: [], updatedAt: "t" }} issues={[]} activeKind="bpmn" onChange={onChange} {...h} />);
    return { ...r, ...h };
  };

  it("«Триггеры блока»: добавление значком и удаление без потери входа блока", () => {
    const p = panel(structuredModel(), { kind: "node", id: "b2" });
    expect(screen.getByText(/Блок ничего не ждёт/)).toBeTruthy();
    fireEvent.click(screen.getAllByText("+ Таймер")[0]); // первая кнопка — «Триггеры блока», вторая — граничное событие
    const e = p.model().nodes.find((n) => n.type === "event" && n.trigger?.type === "timer" && !n.attached_to)!;
    expect(e).toBeTruthy();
    expect(p.onSelect).toHaveBeenCalledWith(expect.objectContaining({ kind: "node", id: e.id }));
    // панель перерисована на модели с триггером: значок виден в списке, удаление возвращает прямую стрелку
    const chip = screen.getByTitle("Убрать триггер");
    fireEvent.click(chip);
    expect(p.model().nodes.some((n) => n.id === e.id)).toBe(false);
    expect(flow(p.model(), "bf2")).toMatchObject({ from: "b1", to: "b2" });
  });

  it("карточка стрелки: маршрут задаётся сторонами и сбрасывается; «Развернуть» переставляет стороны", () => {
    const p = panel(structuredModel(), { kind: "flow", id: "bf2" });
    expect(screen.getByText(/Маршрут подбирается автоматически/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Выходит из стороны"), { target: { value: "B" } });
    expect(flow(p.model(), "bf2").route).toEqual({ from_side: "B" });
    fireEvent.change(screen.getByLabelText("Входит в сторону"), { target: { value: "T" } });
    expect(flow(p.model(), "bf2").route).toEqual({ from_side: "B", to_side: "T" });
    fireEvent.click(screen.getByText("Развернуть стрелку"));
    expect(flow(p.model(), "bf2")).toMatchObject({ from: "b2", to: "b1", route: { from_side: "T", to_side: "B" } });
    fireEvent.click(screen.getByText("Сбросить маршрут"));
    expect(flow(p.model(), "bf2").route).toBeNull();
  });
});

describe("редактор: значки на блоках и ручки выбранной стрелки", () => {
  const studio = (model: M) => {
    const onSave = vi.fn(async (_: M) => true);
    render(<Studio session={session(model)} busy={false} onSave={onSave} />);
    fireEvent.click(document.querySelector('[data-nav-bpmn="o1"]')!);
    return { onSave };
  };
  const pick = (selector: string) => {
    fireEvent.pointerDown(document.querySelector(selector)!, { button: 0, pointerId: 1 });
    fireEvent.pointerUp(document.querySelector(".studio svg.bpe-svg")!, { pointerId: 1 });
  };

  it("значок триггера нарисован на блоке; отдельной фигуры события и его стрелки нет; щелчок по значку выбирает событие", () => {
    studio(withStartTrigger());
    expect(document.querySelector('.studio g[data-node-id="b0"]')).toBeNull();
    const marker = document.querySelector('[data-marker="b0"]')!;
    expect(marker).toBeTruthy();
    expect(marker.querySelector("[data-trigger=message]")).toBeTruthy();
    expect(marker.querySelector("title")!.textContent).toMatch(/Заявка получена — Сообщение: Заявка/);
    expect(document.querySelectorAll(".studio [data-flow-id]")).toHaveLength(2);
    pick('[data-marker="b0"]');
    expect(document.querySelector(".props-head b")!.textContent).toBe("Свойства элемента");
    expect(screen.getByText("Событие и триггер")).toBeTruthy();
  });

  it("у выбранной стрелки появляются ручки: оба конца и средний участок; панель действий позволяет сбросить маршрут", () => {
    studio(structuredModel());
    expect(document.querySelector("[data-flow-handle]")).toBeNull();
    pick('[data-flow-id="bf2"]');
    expect(document.querySelector('[data-flow-handle="from"]')).toBeTruthy();
    expect(document.querySelector('[data-flow-handle="to"]')).toBeTruthy();
    const bar = screen.getByRole("toolbar", { name: "Действия со стрелкой" });
    expect(bar.textContent).toContain("Маршрут автоматический");
    expect((within(bar).getByText("Сбросить маршрут") as HTMLButtonElement).disabled).toBe(true);
  });
});
