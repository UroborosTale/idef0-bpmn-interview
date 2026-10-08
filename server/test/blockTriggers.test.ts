import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { buildVsdx } from "../src/export/vsdx.js";
import { generateBpmn } from "../src/pipeline/bpmn.js";
import { demoModel } from "../src/reference/demo.js";
import { collapseTriggers, markerCenters } from "../src/shared/bpmnTriggers.js";
import { fixedRoute, routeFlowsDetailed, type RouteFlow, type RouteNode } from "../src/shared/bpmnRouting.js";
import { SIZE, type Pt } from "../src/shared/bpmnGeometry.js";
import { ProcessLogicModel } from "../src/types/model.js";
import { structuredModel } from "./fixtures.js";

const n = (id: string, type: string, extra: Record<string, unknown> = {}) => ({ id, type, name: id, subtype: undefined as string | undefined, ...extra });
const ev = (id: string, subtype: string, trigger: Record<string, unknown> | null, extra: Record<string, unknown> = {}) => n(id, "event", { subtype, trigger, ...extra });
const f = (id: string, from: string, to: string, condition?: string) => ({ id, from, to, condition });

describe("триггеры блока: ожидающее событие, ведущее в блок, — значок на блоке", () => {
  it("начальное событие с триггером сворачивается в блок; стрелки «событие → блок» на диаграмме нет", () => {
    const nodes = [ev("s", "start", { type: "message", name: "Заявка" }), n("t", "task")];
    const v = collapseTriggers(nodes, [f("f1", "s", "t")]);
    expect([...v.hidden]).toEqual(["s"]);
    expect(v.flows).toEqual([]);
    expect(v.markers.get("t")).toMatchObject([{ eventId: "s", blockId: "t", start: true, spec: { trigger: "message" } }]);
  });

  it("промежуточное ожидающее: «X → событие → блок» становится «X → блок» (та же стрелка модели, с её условием)", () => {
    const nodes = [n("x", "task"), ev("e", "intermediate", { type: "timer", direction: "catch", timer: { kind: "duration", value: "P1D" } }), n("t", "task")];
    const v = collapseTriggers(nodes, [f("in", "x", "e", "Да"), f("out", "e", "t")]);
    expect(v.flows).toEqual([{ id: "in", from: "x", to: "t", condition: "Да", viaEvent: "e" }]);
    expect(v.markers.get("t")![0].start).toBe(false);
    expect(v.links.get("e")!.outgoing.id).toBe("out");
  });

  it("не сворачиваются: без триггера, выбрасывающие, конечные, граничные, ведущие в шлюз или событие, с несколькими входами и выходами", () => {
    const base = [n("t", "task"), n("g", "gateway"), n("x", "task")];
    const cases: [string, ReturnType<typeof ev>, ReturnType<typeof f>[]][] = [
      ["без триггера", ev("e", "start", null), [f("a", "e", "t")]],
      ["выбрасывает", ev("e", "intermediate", { type: "message", direction: "throw" }), [f("a", "x", "e"), f("b", "e", "t")]],
      ["конец", ev("e", "end", { type: "message" }), [f("a", "x", "e")]],
      ["в шлюз", ev("e", "start", { type: "timer" }), [f("a", "e", "g")]],
      ["два выхода", ev("e", "start", { type: "timer" }), [f("a", "e", "t"), f("b", "e", "x")]],
      ["два входа", ev("e", "intermediate", { type: "message", direction: "catch" }), [f("a", "x", "e"), f("b", "g", "e"), f("c", "e", "t")]],
      ["ссылка", ev("e", "start", { type: "link", name: "Л" }), [f("a", "e", "t")]],
      ["ошибка", ev("e", "start", { type: "error" }), [f("a", "e", "t")]],
    ];
    for (const [name, event, flows] of cases) expect(collapseTriggers([...base, event], flows).hidden.size, name).toBe(0);
    // граничное остаётся на границе
    const boundary = collapseTriggers([n("t", "task"), ev("b", "intermediate", { type: "timer" }, { attached_to: "t" }), n("h", "task")], [f("a", "b", "h")]);
    expect(boundary.hidden.size).toBe(0);
  });

  it("цепочка двух событий подряд: второе остаётся событием (иначе стрелка потеряла бы источник); несколько значков на блоке — в порядке модели", () => {
    const chain = collapseTriggers([ev("a", "start", { type: "message" }), ev("b", "intermediate", { type: "timer", direction: "catch" }), n("t", "task")], [f("1", "a", "b"), f("2", "b", "t")]);
    expect([...chain.hidden]).toEqual(["b"].filter((id) => chain.hidden.has(id)));
    expect(chain.hidden.has("a")).toBe(false);
    const two = collapseTriggers([ev("a", "start", { type: "message" }), ev("b", "start", { type: "signal" }), n("t", "task")], [f("1", "a", "t"), f("2", "b", "t")]);
    expect(two.markers.get("t")!.map((m) => m.eventId)).toEqual(["a", "b"]);
  });

  it("положение значков на блоке: у левого края, затем вдоль верхней границы, без наложения друг на друга", () => {
    const c = markerCenters({ x: 100, y: 100, w: 100, h: 80 }, 3);
    expect(c[0]).toEqual([100, 116]);
    expect(c[1]).toEqual([118, 100]);
    for (let i = 0; i < c.length; i++) for (let j = i + 1; j < c.length; j++) expect(Math.hypot(c[i][0] - c[j][0], c[i][1] - c[j][1])).toBeGreaterThanOrEqual(22);
  });
});

describe("генератор: триггеры блока на диаграмме и в файле", () => {
  const withTrigger = () => {
    const m = structuredModel();
    const step = (id: string, extra: Record<string, unknown>) => ({ id, type: "task", name: id, system_ids: [], inputs: [], outputs: [], controls: [], status: "confirmed", confidence: 1, source: [], requirement_ids: [], tags: [], confirmed_by: [], bpmn_scope: "o1", role_id: "r2", ...extra }) as never;
    // «Информация получена» (b0, начало) → b1: заменяем обычное начало сообщением
    m.nodes = m.nodes.map((x) => (x.id === "b0" ? ({ ...x, trigger: { type: "message", name: "Заявка" }, name: "Заявка получена" } as never) : x));
    m.nodes.push(step("b3", { name: "Проверить заявку" }), { ...step("w", { type: "event", subtype: "intermediate", name: "Срок наступил", trigger: { type: "timer", direction: "catch", timer: { kind: "duration", value: "P2D" } } }) });
    m.flows = [...m.flows.filter((fl) => fl.id !== "bf3"), { id: "x1", from: "b2", to: "w", source: [], confirmed_by: [] } as never, { id: "x2", from: "w", to: "b3", source: [], confirmed_by: [] } as never, { id: "x3", from: "b3", to: "b9", source: [], confirmed_by: [] } as never];
    return m;
  };

  it("в данных диаграммы нет фигур и стрелок свёрнутых событий; у блоков — значки; стрелка «X → блок» ведёт к блоку", async () => {
    const { diagram } = await generateBpmn(withTrigger(), "o1");
    const ids = diagram.shapes.map((s) => s.nodeId);
    expect(ids).not.toContain("b0");
    expect(ids).not.toContain("w");
    expect(diagram.shapes.find((s) => s.nodeId === "b1")!.markers).toEqual([{ name: "Заявка получена", trigger: "message", start: true }]);
    expect(diagram.shapes.find((s) => s.nodeId === "b3")!.markers).toEqual([{ name: "Срок наступил", trigger: "timer", start: false }]);
    const edge = diagram.edges.find((e) => e.flowId === "x1")!;
    expect(edge.to).toBe("Node_b3");
    expect(diagram.edges.some((e) => e.flowId === "bf1")).toBe(false); // «событие → блок»
    expect(diagram.edges.some((e) => e.flowId === "x2")).toBe(false);
  });

  it("в BPMN-файле остаются настоящие события и стрелки (файл валиден и открывается в других редакторах)", async () => {
    const { xml } = await generateBpmn(withTrigger(), "o1");
    expect(xml).toMatch(/<bpmn:startEvent id="Node_b0" name="Заявка получена"[^>]*><bpmn:messageEventDefinition messageRef="Message_1" \/>/);
    expect(xml).toMatch(/<bpmn:intermediateCatchEvent id="Node_w"[^>]*><bpmn:timerEventDefinition><bpmn:timeDuration[^>]*>P2D</);
    expect(xml).toContain('<bpmn:sequenceFlow id="Flow_bf1" sourceRef="Node_b0" targetRef="Node_b1"');
    expect(xml).toContain('<bpmn:sequenceFlow id="Flow_x2" sourceRef="Node_w" targetRef="Node_b3"');
    expect(xml).toContain('<bpmndi:BPMNShape id="Node_w_di"'); // у события в файле есть фигура
    expect(xml).toContain('<bpmndi:BPMNEdge id="Flow_x1_di"');
  });

  it("раскладка не оставляет «пустых столбцов» от свёрнутых событий: блок встаёт на место события", async () => {
    const full = withTrigger();
    const collapsed = (await generateBpmn(full, "o1")).diagram.shapes.find((s) => s.nodeId === "b1")!;
    const uncollapsed = { ...full, nodes: full.nodes.map((x) => (x.id === "b0" ? { ...x, trigger: null } : x)) } as typeof full; // начало без триггера не сворачивается
    const plain = (await generateBpmn(uncollapsed, "o1")).diagram.shapes.find((s) => s.nodeId === "b1")!;
    expect(collapsed.x).toBeLessThan(plain.x);
  });

  it("Visio: значок триггера нарисован у блока отдельной фигурой, фигур событий и стрелок к блокам нет", async () => {
    const zip = await JSZip.loadAsync(await buildVsdx(withTrigger()));
    const pages = Object.keys(zip.files).filter((p) => /visio\/pages\/page\d+\.xml$/.test(p));
    const xml = (await Promise.all(pages.map((p) => zip.file(p)!.async("string")))).join("\n");
    const row = (name: string, value: string) => `<Row N="${name}"><Cell N="Value" V="${value}" U="STR"/></Row>`;
    expect(xml).toContain(row("pm_k", "trigger"));
    expect(xml).toContain(row("pm_n", "Заявка получена")); // значок несёт имя события
    expect(xml).toContain(row("pm_n", "Срок наступил"));
    expect(xml).not.toContain(row("pm_id", "b0")); // самого события на диаграмме Visio нет
    expect(xml).not.toContain(row("pm_id", "w"));
    expect(xml).toContain(row("pm_id", "b1")); // а блок на месте
  }, 60_000);

  it("демо: триггеры C090 стали значками; число фигур меньше числа узлов", async () => {
    const m = demoModel();
    const { diagram } = await generateBpmn(m, "o12");
    expect(diagram.shapes.some((s) => s.markers?.some((mk) => mk.trigger === "message" && mk.start))).toBe(true); // «Заявка на закупку получена»
    expect(diagram.shapes.length).toBeLessThan(m.nodes.filter((x) => x.bpmn_scope === "o12").length);
  });
});

describe("ручной маршрут стрелки", () => {
  const node = (id: string, type: keyof typeof SIZE, cx: number, cy: number): RouteNode => ({ id, type, box: { x: cx - SIZE[type].w / 2, y: cy - SIZE[type].h / 2, w: SIZE[type].w, h: SIZE[type].h } });
  const onSide = (p: Pt, b: RouteNode["box"]) => (Math.abs(p[0] - b.x) < 1 ? "L" : Math.abs(p[0] - b.x - b.w) < 1 ? "R" : Math.abs(p[1] - b.y) < 1 ? "T" : Math.abs(p[1] - b.y - b.h) < 1 ? "B" : "?");

  it("заданные стороны соблюдаются: стрелка выходит и входит там, где просил пользователь", () => {
    const nodes = [node("a", "task", 100, 150), node("b", "task", 500, 450)];
    const auto = routeFlowsDetailed(nodes, [{ id: "f", from: "a", to: "b" }]).get("f")!;
    expect(auto.manual).toBe(false);
    const flows: RouteFlow[] = [{ id: "f", from: "a", to: "b", fixed: fixedRoute({ from_side: "B", to_side: "T" }) }];
    const r = routeFlowsDetailed(nodes, flows).get("f")!;
    expect(r.manual).toBe(true);
    expect([r.from, r.to]).toEqual(["B", "T"]);
    expect(onSide(r.pts[0], nodes[0].box)).toBe("B");
    expect(onSide(r.pts.at(-1)!, nodes[1].box)).toBe("T");
  });

  it("заданное положение среднего участка соблюдается; пределы отдаются редактору", () => {
    const nodes = [node("a", "task", 100, 150), node("b", "task", 500, 450)];
    const base = routeFlowsDetailed(nodes, [{ id: "f", from: "a", to: "b" }]).get("f")!;
    expect(base.channel).toMatchObject({ axis: "x" });
    expect(base.channel!.lo).toBeLessThan(base.channel!.hi);
    const moved = routeFlowsDetailed(nodes, [{ id: "f", from: "a", to: "b", fixed: fixedRoute({ channel: 380 }) }]).get("f")!;
    expect(moved.channel!.at).toBe(380);
    expect(moved.pts.some((p) => p[0] === 380)).toBe(true);
    expect(moved.manual).toBe(true);
    // слишком далеко за пределами — игнорируется, остаётся автоматическое положение
    const ignored = routeFlowsDetailed(nodes, [{ id: "f", from: "a", to: "b", fixed: fixedRoute({ channel: 5000 }) }]).get("f")!;
    expect(ignored.channel!.at).toBe(base.channel!.at);
  });

  it("если заданные стороны не подходят (цель левее, а вход слева), стрелка прокладывается автоматически, а не ломается", () => {
    const nodes = [node("a", "task", 500, 150), node("b", "task", 100, 450)];
    const r = routeFlowsDetailed(nodes, [{ id: "f", from: "a", to: "b", fixed: fixedRoute({ from_side: "R", to_side: "L" }) }]).get("f")!;
    expect(r.pts.length).toBeGreaterThanOrEqual(2);
    for (let i = 0; i + 1 < r.pts.length; i++) expect(r.pts[i][0] === r.pts[i + 1][0] || r.pts[i][1] === r.pts[i + 1][1]).toBe(true);
  });

  it("остальные стрелки обходят ручную: им не достаётся занятый порт", () => {
    const nodes = [node("g", "gateway", 200, 300), node("up", "task", 450, 120), node("mid", "task", 450, 300)];
    const flows: RouteFlow[] = [
      { id: "a", from: "g", to: "mid" },
      { id: "b", from: "g", to: "up", fixed: fixedRoute({ from_side: "R" }) }, // пользователь велел выходить вправо
    ];
    const r = routeFlowsDetailed(nodes, flows);
    expect(r.get("b")!.from).toBe("R");
    expect(r.get("a")!.from).not.toBe("R");
  });

  it("модель принимает route у стрелки и отвергает неизвестную сторону", () => {
    const m = structuredModel() as never as { flows: Record<string, unknown>[] };
    const model = { ...(structuredModel() as object), flows: [{ ...structuredModel().flows[0], route: { from_side: "B", to_side: "T", channel: 330 } }] };
    expect(ProcessLogicModel.safeParse(model).success).toBe(true);
    expect(ProcessLogicModel.safeParse({ ...model, flows: [{ ...model.flows[0], route: { from_side: "X" } }] }).success).toBe(false);
    expect(m.flows.length).toBeGreaterThan(0);
  });

  it("генератор соблюдает route в данных диаграммы (стороны выхода и входа)", async () => {
    const m = structuredModel();
    m.flows = m.flows.map((x) => (x.id === "bf2" ? ({ ...x, route: { from_side: "B", to_side: "B" } } as never) : x)); // соседние шаги в одном ряду: петля под ними
    const { diagram } = await generateBpmn(m, "o1");
    const e = diagram.edges.find((x) => x.flowId === "bf2")!;
    const from = diagram.shapes.find((s) => s.id === e.from)!;
    const to = diagram.shapes.find((s) => s.id === e.to)!;
    expect(Math.abs(e.points[0][1] - (from.y + from.h))).toBeLessThan(1);
    expect(Math.abs(e.points.at(-1)![1] - (to.y + to.h))).toBeLessThan(1);
  });
});
