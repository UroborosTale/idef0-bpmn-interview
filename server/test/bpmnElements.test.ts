import { describe, expect, it } from "vitest";
import { generateBpmn } from "../src/pipeline/bpmn.js";
import { carryOverManualEdits } from "../src/pipeline/carryOver.js";
import { ARTIFACT_W, artifactLabelWidth, artifactsOf, boundaryBoxes, isBoundaryNode, messageEdges, poolBoxes } from "../src/shared/bpmnArtifacts.js";
import { hasVerbalNoun, looksLikeFact } from "../src/shared/rules.js";
import { mergeScope, scopeView } from "../src/shared/scope.js";
import { validateModel } from "../src/shared/validate.js";
import type { ProcessLogicModel } from "../src/types/model.js";
import { branchingModel, purchaseModel, structuredModel } from "./fixtures.js";

const node = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: "task",
  name: id,
  system_ids: [],
  inputs: [],
  outputs: [],
  controls: [],
  status: "confirmed",
  confidence: 1,
  source: [],
  requirement_ids: [],
  tags: [],
  confirmed_by: [],
  ...extra,
});

/** Диаграмма операции o1: задача b1 получила граничный таймер, ведущий к новой задаче b3. */
function withBoundary(): ProcessLogicModel {
  const m = structuredModel();
  m.nodes.push(
    node("be", { type: "event", subtype: "timer", name: "Срок истёк", role_id: "r2", bpmn_scope: "o1", attached_to: "b1", interrupting: false }) as never,
    node("b3", { name: "Напомнить исполнителю", role_id: "r2", bpmn_scope: "o1" }) as never
  );
  m.flows.push({ id: "bf4", from: "be", to: "b3", source: [], confirmed_by: [] } as never, { id: "bf5", from: "b3", to: "b9", source: [], confirmed_by: [] } as never);
  return m;
}

const rules = (m: ProcessLogicModel, rule: string) => validateModel(m).filter((i) => i.rule === rule);

describe("элементы BPMN по Соглашению: генерация", () => {
  it("задача «Бизнес-правила» — businessRuleTask", async () => {
    const m = structuredModel();
    m.nodes.find((n) => n.id === "b2")!.subtype = "business_rule";
    const { xml } = await generateBpmn(m, "o1");
    expect(xml).toMatch(/<bpmn:businessRuleTask id="Node_b2"/);
  });

  it("граничное событие: attachedToRef, cancelActivity, определение таймера; на нижней границе задачи", async () => {
    const { xml, diagram } = await generateBpmn(withBoundary(), "o1");
    expect(xml).toMatch(/<bpmn:boundaryEvent id="Node_be" name="Срок истёк" attachedToRef="Node_b1" cancelActivity="false"><bpmn:timerEventDefinition \/><\/bpmn:boundaryEvent>/);
    const host = diagram.shapes.find((s) => s.nodeId === "b1")!;
    const be = diagram.shapes.find((s) => s.nodeId === "be")!;
    expect(be.attachedTo).toBe("Node_b1");
    expect(be.interrupting).toBe(false);
    expect(be.y + be.h / 2).toBeCloseTo(host.y + host.h, 5);
    expect(be.x).toBeGreaterThanOrEqual(host.x - 18);
    expect(be.x + be.w).toBeLessThanOrEqual(host.x + host.w + 18);
    // у граничного события нет входящих стрелок, но синтетического начала к нему не добавляется
    expect(xml).not.toMatch(/SynthFlow_s_be/);
    expect(xml).toMatch(/sourceRef="Node_be" targetRef="Node_b3"/);
    expect(diagram.edges.some((e) => e.flowId === "bf4")).toBe(true);
  });

  it("граничное событие без существующей задачи рисуется обычным событием", async () => {
    const m = withBoundary();
    m.nodes.find((n) => n.id === "be")!.attached_to = "нет-такой";
    const { xml } = await generateBpmn(m, "o1");
    expect(xml).not.toMatch(/boundaryEvent id="Node_be"/);
    expect(xml).toMatch(/intermediateCatchEvent id="Node_be"/);
  });

  it("ошибка вне границы задачи — конечное событие с ошибкой, а не «висящая» граница", async () => {
    const m = structuredModel();
    m.nodes.find((n) => n.id === "b9")!.subtype = "error";
    const { xml } = await generateBpmn(m, "o1");
    expect(xml).toMatch(/<bpmn:endEvent id="Node_b9"[^>]*><bpmn:errorEventDefinition/);
    expect(xml).not.toMatch(/boundaryEvent/);
  });

  it("документы и хранилища данных: документы над задачей, хранилища под ней, с ассоциациями и фигурами в DI", async () => {
    const m = structuredModel();
    const b1 = m.nodes.find((n) => n.id === "b1")!;
    b1.inputs = ["d1"];
    b1.outputs = ["d2"];
    const { xml, diagram } = await generateBpmn(m, "o1");
    expect(xml).toMatch(/<bpmn:dataObjectReference id="DataRef_b1_d1" name="Информация о выявленном процессе" dataObjectRef="DataObj_d1"/);
    expect(xml).toMatch(/<bpmn:dataInputAssociation id="DIA_b1_d1"><bpmn:sourceRef>DataRef_b1_d1<\/bpmn:sourceRef>/);
    expect(xml).toMatch(/<bpmn:dataOutputAssociation id="DOA_b1_d2"><bpmn:targetRef>DataRef_b1_d2<\/bpmn:targetRef>/);
    // система ELMA365 у задачи b1 — хранилище данных, связанное ассоциацией без направления
    expect(xml).toMatch(/<bpmn:dataStoreReference id="StoreRef_b1_s1" name="ELMA365"/);
    expect(xml).toMatch(/<bpmn:association id="Assoc_StoreRef_b1_s1" sourceRef="Node_b1" targetRef="StoreRef_b1_s1" associationDirection="None"/);
    for (const id of ["DataRef_b1_d1_di", "DataRef_b1_d2_di", "StoreRef_b1_s1_di", "DIA_b1_d1_di", "DOA_b1_d2_di", "Assoc_StoreRef_b1_s1_di"]) expect(xml).toContain(`id="${id}"`);
    const host = diagram.shapes.find((s) => s.nodeId === "b1")!;
    const arts = diagram.extras.filter((e) => e.kind === "data" || e.kind === "store");
    expect(arts.map((e) => e.kind)).toEqual(["data", "data", "store"]);
    for (const a of arts) {
      if (a.kind === "store") {
        expect(a.y).toBeGreaterThan(host.y + host.h); // хранилище данных — под задачей
        expect(a.y + a.h + 11).toBeLessThanOrEqual(host.y + host.h + 35); // вместе с подписью — в пределах дорожки
      } else {
        expect(a.y + a.h).toBeLessThan(host.y); // документ — над задачей
        expect(a.y - 11).toBeGreaterThanOrEqual(host.y - 35);
      }
      expect(a.link).toHaveLength(2);
    }
    expect(arts[0].linkDirection).toBe("to-task");
    expect(arts[1].linkDirection).toBe("from-task");
  });

  it("один документ у двух задач — две ссылки на один объект данных", async () => {
    const m = structuredModel();
    m.nodes.find((n) => n.id === "b1")!.outputs = ["d2"];
    m.nodes.find((n) => n.id === "b2")!.inputs = ["d2"];
    const { xml } = await generateBpmn(m, "o1");
    expect(xml.match(/<bpmn:dataObject id="DataObj_d2"/g)).toHaveLength(1);
    expect(xml).toContain('id="DataRef_b1_d2"');
    expect(xml).toContain('id="DataRef_b2_d2"');
  });

  it("внешние пулы и потоки сообщений: свёрнутые участники под диаграммой", async () => {
    const m = structuredModel();
    m.pools.push({ id: "x1", name: "Анализ эффективности процессной модели", code: "B002.02.01" });
    m.messages.push({ id: "m1", from: "b2", to: "x1", name: "Запрос на анализ" }, { id: "m2", from: "x1", to: "b1", name: "Результаты" });
    const { xml, diagram } = await generateBpmn(m, "o1");
    expect(xml).toContain('<bpmn:participant id="Pool_x1" name="B002.02.01 Анализ эффективности процессной модели" />');
    expect(xml).toContain('<bpmn:messageFlow id="Msg_m1" name="Запрос на анализ" sourceRef="Node_b2" targetRef="Pool_x1" />');
    expect(xml).toContain('<bpmn:messageFlow id="Msg_m2" name="Результаты" sourceRef="Pool_x1" targetRef="Node_b1" />');
    expect(xml).toContain('id="Pool_x1_di"');
    expect(xml).toContain('id="Msg_m1_di"');
    const [pool] = diagram.pools;
    expect(pool.y).toBeGreaterThan(diagram.pool.y + diagram.pool.h);
    expect(diagram.height).toBeGreaterThan(pool.y + pool.h);
    expect(diagram.messages.map((e) => [e.from, e.to])).toEqual([["Node_b2", "Pool_x1"], ["Pool_x1", "Node_b1"]]);
    // поток от шага заканчивается на верхней границе пула, поток от пула начинается на ней
    expect(diagram.messages[0].points.at(-1)![1]).toBe(pool.y);
    expect(diagram.messages[1].points[0][1]).toBe(pool.y);
  });

  it("ручной маршрут потока сообщений: линия идёт через заданную точку излома, остальные потоки не меняются", async () => {
    const m = structuredModel();
    m.pools.push({ id: "x1", name: "Поставщики" });
    m.messages.push({ id: "m1", from: "b2", to: "x1", name: "Запрос" }, { id: "m2", from: "x1", to: "b1", name: "Ответ" });
    const auto = (await generateBpmn(m, "o1")).diagram;
    const pool = auto.pools[0];
    const mid: [number, number] = [pool.x + pool.w / 2 + (137), pool.y - 61];
    m.messages[0].route = { points: [mid] };
    const manual = (await generateBpmn(m, "o1")).diagram;
    expect(manual.messages[0].points.some((p) => Math.abs(p[0] - mid[0]) < 1 && Math.abs(p[1] - mid[1]) < 1)).toBe(true);
    expect(auto.messages[0].points.some((p) => Math.abs(p[0] - mid[0]) < 1 && Math.abs(p[1] - mid[1]) < 1)).toBe(false);
    // остальной поток остаётся приклеенным к тем же сторонам: от верхней границы пула к нижней границе шага (точки на общей
    // стороне задач могут перераспределиться, когда ручной маршрут занимает соседний порт)
    const [m1, a1] = [manual.messages[1].points, auto.messages[1].points];
    expect(m1[0][1]).toBe(a1[0][1]);
    expect(m1.at(-1)![1]).toBe(a1.at(-1)![1]);
    expect(m1.some((p) => Math.abs(p[0] - mid[0]) < 1 && Math.abs(p[1] - mid[1]) < 1)).toBe(false); // чужая точка излома не попала в этот поток
    expect(manual.messages[0].points.at(-1)![1]).toBe(pool.y); // по-прежнему приходит на верхнюю границу пула
  });

  it("пул без потоков сообщений и поток к шагу другой диаграммы не попадают на диаграмму", async () => {
    const m = structuredModel();
    m.pools.push({ id: "x1", name: "Внешний участник" }, { id: "x2", name: "Ещё один" });
    m.messages.push({ id: "m1", from: "b2", to: "x1" });
    const o1 = await generateBpmn(m, "o1");
    expect(o1.diagram.pools.map((q) => q.id)).toEqual(["Pool_x1"]);
    const o2 = await generateBpmn(m, "o2");
    expect(o2.xml).not.toContain("Pool_x1");
  });
});

describe("добавочные элементы: общая геометрия", () => {
  const boxes = new Map([["t", { x: 200, y: 100, w: 100, h: 80 }]]);

  it("граничные события раскладываются по нижней границе слева направо", () => {
    const nodes = [node("t"), node("e1", { type: "event", attached_to: "t" }), node("e2", { type: "event", attached_to: "t" }), node("e3", { type: "event", attached_to: "нет" })] as never[];
    expect(isBoundaryNode(nodes[1], nodes)).toBe(true);
    expect(isBoundaryNode(nodes[3], nodes)).toBe(false);
    const b = boundaryBoxes(nodes, boxes);
    expect([...b.keys()]).toEqual(["e1", "e2"]);
    expect(b.get("e1")!.x).toBeLessThan(b.get("e2")!.x);
    expect(b.get("e1")!.y + 18).toBe(180);
  });

  it("значки не выходят за пределы области над и под задачей, даже когда их много: документы сверху, хранилища снизу", () => {
    const names = { data: new Map(Array.from({ length: 8 }, (_, i) => [`d${i}`, `Документ ${i}`])), systems: new Map([["s", "1С"]]) };
    const n = node("t", { inputs: ["d0", "d1", "d2", "d3", "d4", "d5", "d6", "d7", "нет"], system_ids: ["s", "нет"] });
    const arts = artifactsOf([n] as never[], boxes, names);
    expect(arts).toHaveLength(9); // неизвестные записи пропускаются
    for (const a of arts) {
      if (a.kind === "store") {
        expect(a.box.y).toBeGreaterThanOrEqual(180); // низ задачи
        expect(a.box.y + a.box.h).toBeLessThanOrEqual(180 + 30); // значок целиком внутри дорожки
      } else {
        expect(a.box.y + a.box.h).toBeLessThanOrEqual(100); // верх задачи
        expect(a.box.y).toBeGreaterThanOrEqual(100 - 30);
      }
      expect(a.box.x).toBeGreaterThanOrEqual(200 - 20 - 22);
      expect(a.box.x + a.box.w).toBeLessThanOrEqual(300 + 20 + 22);
    }
  });

  it("подписи соседних значков не налезают друг на друга: подпись идёт справа от значка, промежуток — по её ширине", () => {
    const names = { data: new Map([["a", "Потребность"], ["b", "Заявка на закупку"]]), systems: new Map() };
    const arts = artifactsOf([node("t", { inputs: ["a", "b"] })] as never[], boxes, names);
    expect(arts[1].box.x - arts[0].box.x).toBeGreaterThanOrEqual(ARTIFACT_W + artifactLabelWidth("Потребность") + 4);
  });

  it("хранилища данных идут правее граничных событий и обходят вертикаль потока сообщений, а документы от них не зависят", () => {
    const names = { data: new Map([["d0", "Заявка"]]), systems: new Map([["s0", "1С"], ["s1", "ELMA365"]]) };
    const host = node("t", { inputs: ["d0"], system_ids: ["s0", "s1"] });
    const event = { id: "be", type: "event", attached_to: "t", inputs: [], outputs: [], system_ids: [] };
    // граничное событие стоит на нижней границе слева: его центр — x задачи + 22
    const withEvent = artifactsOf([host, event] as never[], boxes, names);
    const stores = withEvent.filter((a) => a.kind === "store");
    expect(stores[0].box.x).toBeGreaterThan(200 + 22 + 18);
    // документ над задачей остаётся по центру, граничное событие ему не мешает
    const doc = withEvent.find((a) => a.kind === "input")!;
    expect(doc.box.y + doc.box.h).toBeLessThan(100);
    expect(doc.box.x + doc.box.w / 2).toBeCloseTo(250);
    // поток сообщений уходит вниз из середины задачи (x = 250): значки в этой полосе не стоят
    const withMessage = artifactsOf([host] as never[], boxes, names, new Set(["t"]));
    for (const a of withMessage.filter((x) => x.kind === "store")) expect(a.box.x + a.box.w <= 250 - 12 || a.box.x >= 250 + 12).toBe(true);
    // ассоциация хранилища идёт от нижней стороны задачи к значку, документа — от верхней
    const store = withMessage.find((a) => a.kind === "store")!;
    expect(store.edge.map((p) => p[1]).sort((p, q) => p - q)).toEqual([180, store.box.y]);
    const doc2 = withMessage.find((a) => a.kind === "input")!;
    expect(doc2.edge.map((p) => p[1]).sort((p, q) => p - q)).toEqual([doc2.box.y + doc2.box.h, 100]);
  });

  it("ручное смещение пула сдвигает только его, ряд остальных не меняется; поток сообщений идёт к новому месту", () => {
    const b = new Map([["a", { x: 300, y: 100, w: 100, h: 80 }]]);
    const msgs = [{ id: "m1", from: "a", to: "p1" }];
    const base = poolBoxes([{ id: "p1", name: "Первый" }, { id: "p2", name: "Второй" }], msgs, b, 400);
    const moved = poolBoxes([{ id: "p1", name: "Первый", dx: 120, dy: 30 }, { id: "p2", name: "Второй" }], msgs, b, 400);
    expect(moved.get("p1")).toEqual({ ...base.get("p1")!, x: base.get("p1")!.x + 120, y: 430 });
    expect(moved.get("p2")).toEqual(base.get("p2")); // соседний пул не сдвинулся
    const edge = messageEdges(msgs, b, moved)[0].points;
    expect(edge.at(-1)![0]).toBe(moved.get("p1")!.x + moved.get("p1")!.w / 2);
  });

  it("пулы не налезают друг на друга, а их порядок следует за шагами", () => {
    const b = new Map([["a", { x: 300, y: 100, w: 100, h: 80 }], ["c", { x: 320, y: 100, w: 100, h: 80 }]]);
    const pools = [{ id: "p1", name: "Первый" }, { id: "p2", name: "Второй" }, { id: "p3", name: "Без связей" }];
    const out = poolBoxes(pools, [{ id: "m1", from: "c", to: "p2" }, { id: "m2", from: "p1", to: "a" }], b, 400);
    expect([...out.keys()]).toEqual(["p1", "p2", "p3"]); // самостоятельный пул — в ряду после связанных
    expect(out.get("p2")!.x).toBeGreaterThanOrEqual(out.get("p1")!.x + out.get("p1")!.w + 24);
    expect(out.get("p3")!.x).toBeGreaterThanOrEqual(out.get("p2")!.x + out.get("p2")!.w + 24);
    const edges = messageEdges([{ id: "m2", from: "p1", to: "a" }], b, out);
    expect(edges[0].points[0][1]).toBe(400); // от пула к шагу
    expect(edges[0].points.at(-1)![1]).toBe(180);
  });
});

describe("области диаграмм и сообщения", () => {
  const withMessages = () => {
    const m = structuredModel();
    m.pools.push({ id: "x1", name: "Другой процесс", code: "B002.02.01" }, { id: "x2", name: "Не используется" });
    m.messages.push({ id: "m1", from: "b2", to: "x1" });
    return m;
  };

  it("вид области содержит потоки её шагов и связанные пулы", () => {
    const m = withMessages();
    const v = scopeView(m, "o1");
    expect(v.messages.map((x) => x.id)).toEqual(["m1"]);
    expect(v.pools.map((p) => p.id)).toEqual(["x1"]);
    expect(scopeView(m, "o2").messages).toEqual([]);
    expect(scopeView(m, null).messages).toEqual([]); // общая схема процесса — без шагов операций
  });

  it("правка вида вливается обратно: сообщения сохраняются, у удалённого шага — снимаются, пулы остаются", () => {
    const m = withMessages();
    const v = scopeView(m, "o1");
    const renamed = { ...v, nodes: v.nodes.map((n) => (n.id === "b1" ? { ...n, name: "Открыть реестр процессов" } : n)) };
    const merged = mergeScope(m, renamed, "o1", v);
    expect(merged.messages).toEqual(m.messages);
    expect(merged.nodes.find((n) => n.id === "b1")!.name).toBe("Открыть реестр процессов");
    const removed = mergeScope(m, { ...v, nodes: v.nodes.filter((n) => n.id !== "b2"), flows: v.flows.filter((f) => f.from !== "b2" && f.to !== "b2") }, "o1", v);
    expect(removed.messages).toEqual([]);
    expect(removed.pools.map((p) => p.id)).toEqual(["x1", "x2"]);
  });

  it("сообщения других диаграмм при правке не затрагиваются", () => {
    const m = withMessages();
    m.messages.push({ id: "m9", from: "x2", to: "s1" });
    const v = scopeView(m, "o1");
    const merged = mergeScope(m, { ...v, nodes: v.nodes.map((n) => ({ ...n })) }, "o1", v);
    expect(merged.messages.map((x) => x.id).sort()).toEqual(["m1", "m9"]);
  });
});

describe("повторная обработка текста", () => {
  it("граничные события, внешние пулы и потоки сообщений ручной работы сохраняются", () => {
    const prev = withBoundary();
    prev.pools.push({ id: "x1", name: "Другой процесс", code: "B002.02.01" });
    prev.messages.push({ id: "m1", from: "b2", to: "x1", name: "Запрос" }, { id: "m2", from: "x1", to: "gone" });
    prev.nodes.forEach((n) => (n.source = n.id.startsWith("b") ? [] : [{ fragment_id: "f1", quote: "q" }]));
    const next = structuredModel();
    next.nodes = next.nodes.filter((n) => !n.bpmn_scope);
    next.flows = [];
    const { model } = carryOverManualEdits(prev, next);
    expect(model.nodes.find((n) => n.id === "be")).toMatchObject({ attached_to: "b1", interrupting: false, bpmn_scope: "o1" });
    expect(model.pools).toEqual(prev.pools);
    expect(model.messages.map((m) => m.id)).toEqual(["m1"]); // у второго потока нет узла
  });
});

describe("проверки BPMN по Соглашению", () => {
  it("событие — факт: существительное и действие предупреждают, свершившийся факт — нет", () => {
    const m = structuredModel();
    m.nodes.find((n) => n.id === "b0")!.name = "Пункт протокола совещания";
    m.nodes.find((n) => n.id === "b9")!.name = "Реестр актуализирован";
    const issues = rules(m, "bpmn_event_not_fact");
    expect(issues.map((i) => i.element_id)).toEqual(["b0"]);
    expect(issues[0].message).toContain("[B002.01.01]");
  });

  it("таймер и числовые названия не проверяются; названия по умолчанию («Начало») — проверяются", () => {
    const m = structuredModel();
    m.nodes.push(node("tm", { type: "event", subtype: "timer", name: "Через 3 дня", bpmn_scope: "o1" }) as never, node("z", { type: "event", subtype: "start", name: "Начало", bpmn_scope: "o1" }) as never);
    expect(rules(m, "bpmn_event_not_fact").map((i) => i.element_id)).toEqual(["z"]);
  });

  it("правило событий не действует без структурного кода процесса", () => {
    const m = branchingModel();
    m.nodes.find((n) => n.id === "s")!.name = "Договор";
    expect(rules(m, "bpmn_event_not_fact")).toEqual([]);
  });

  it("перед развилкой XOR должна стоять задача", () => {
    const m = structuredModel();
    m.nodes.push(node("g", { type: "gateway", subtype: "exclusive", name: "Данные верны?", role_id: "r2", bpmn_scope: "o1" }) as never);
    // b0 (событие) → g → b1 и b2: развилка стоит сразу за событием
    m.flows = [
      { id: "x1", from: "b0", to: "g", source: [], confirmed_by: [] },
      { id: "x2", from: "g", to: "b1", condition: "да", source: [], confirmed_by: [] },
      { id: "x3", from: "g", to: "b2", condition: "нет", source: [], confirmed_by: [] },
      { id: "x4", from: "b1", to: "b9", source: [], confirmed_by: [] },
      { id: "x5", from: "b2", to: "b9", source: [], confirmed_by: [] },
    ] as never;
    const issues = rules(m, "bpmn_xor_after_task");
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toMatch(/стоит событие «Информация получена»/);
    // после задачи — нормально; параллельный шлюз правилу не подчиняется
    m.flows = m.flows.map((f) => (f.id === "x1" ? { ...f, from: "b1" } : f)) as never;
    expect(rules(m, "bpmn_xor_after_task")).toEqual([]);
    m.nodes.find((n) => n.id === "g")!.subtype = "parallel";
    m.flows = m.flows.map((f) => (f.id === "x1" ? { ...f, from: "b0" } : f)) as never;
    expect(rules(m, "bpmn_xor_after_task")).toEqual([]);
  });

  it("поток не разветвляется и не сливается без шлюза (кроме слияния в конечном событии)", () => {
    const m = structuredModel();
    m.nodes.push(node("b3", { name: "Сообщить руководителю", role_id: "r2", bpmn_scope: "o1" }) as never);
    m.flows.push({ id: "x1", from: "b1", to: "b3", source: [], confirmed_by: [] } as never, { id: "x2", from: "b3", to: "b9", source: [], confirmed_by: [] } as never);
    // b1 → b2 и b1 → b3 (разветвление); b2 → b9 и b3 → b9 (слияние в конец — допустимо)
    expect(rules(m, "bpmn_split_without_gateway").map((i) => i.element_id)).toEqual(["b1"]);
    expect(rules(m, "bpmn_merge_without_gateway")).toEqual([]);
    m.flows.push({ id: "x3", from: "b3", to: "b2", source: [], confirmed_by: [] } as never);
    expect(rules(m, "bpmn_merge_without_gateway").map((i) => i.element_id)).toEqual(["b2"]);
  });

  it("граничное событие достижимо через задачу и не считается стартом; без продолжения и с входом — замечания", () => {
    const m = withBoundary();
    const all = validateModel(m);
    expect(all.filter((i) => i.rule === "bpmn_unreachable_node")).toEqual([]);
    expect(all.filter((i) => i.rule === "bpmn_boundary_no_outgoing" || i.rule === "bpmn_boundary_incoming" || i.rule === "bpmn_boundary_no_host")).toEqual([]);
    expect(all.filter((i) => i.severity === "error")).toEqual([]);

    const noOut = withBoundary();
    noOut.flows = noOut.flows.filter((f) => f.id !== "bf4");
    expect(rules(noOut, "bpmn_boundary_no_outgoing").map((i) => i.element_id)).toEqual(["be"]);
    expect(rules(noOut, "bpmn_dead_end").map((i) => i.element_id)).not.toContain("be");

    const incoming = withBoundary();
    incoming.flows.push({ id: "bad", from: "b2", to: "be", source: [], confirmed_by: [] } as never);
    expect(rules(incoming, "bpmn_boundary_incoming")[0]).toMatchObject({ severity: "error", element_id: "be" });

    const lost = withBoundary();
    lost.nodes.find((n) => n.id === "be")!.attached_to = "нет-такой";
    expect(rules(lost, "bpmn_boundary_no_host").map((i) => i.element_id)).toEqual(["be"]);
  });
});

describe("потоки сообщений: проверка концов", () => {
  it("сообщения идут от задач, подпроцессов и событий-сообщений; шлюз и таймер сообщений не отправляют и не получают", () => {
    const m = structuredModel();
    m.pools.push({ id: "x1", name: "Другой процесс" });
    // обычные пользовательские задачи — допустимые концы (так нарисованы документы организации)
    m.messages.push({ id: "m1", from: "b2", to: "x1" }, { id: "m2", from: "x1", to: "b1" });
    expect(rules(m, "bpmn_message_endpoint")).toEqual([]);
    m.nodes.find((n) => n.id === "b2")!.subtype = "send";
    m.nodes.find((n) => n.id === "b1")!.subtype = "receive";
    expect(rules(m, "bpmn_message_endpoint")).toEqual([]);
    // событие-сообщение и подпроцесс тоже подходят
    m.nodes.find((n) => n.id === "b1")!.type = "event";
    m.nodes.find((n) => n.id === "b1")!.subtype = "message";
    m.nodes.find((n) => n.id === "b2")!.type = "subprocess";
    expect(rules(m, "bpmn_message_endpoint")).toEqual([]);
    // шлюз и таймер — нет
    m.nodes.find((n) => n.id === "b2")!.type = "gateway";
    m.nodes.find((n) => n.id === "b2")!.subtype = "exclusive";
    m.nodes.find((n) => n.id === "b1")!.subtype = "timer";
    const issues = rules(m, "bpmn_message_endpoint");
    expect(issues.map((i) => i.element_id).sort()).toEqual(["b1", "b2"]);
    expect(issues.find((i) => i.element_id === "b2")!.message).toMatch(/шлюз сообщений не отправляют/);
    expect(issues.find((i) => i.element_id === "b1")!.message).toMatch(/таймер и событие-ошибка сообщений не получают/);
  });
});
describe("проверки блоков и продуктов по Соглашению", () => {
  it("одинаковые названия блоков и петли", () => {
    const m = structuredModel();
    m.nodes.find((n) => n.id === "o2")!.name = "  актуализация  РЕЕСТРА процессов ";
    const dup = rules(m, "idef0_duplicate_name");
    expect(dup).toHaveLength(1);
    expect(dup[0].message).toContain("B002.01.01, B002.01.02");

    const loop = structuredModel();
    loop.nodes.find((n) => n.id === "o1")!.inputs.push("d2"); // выход o1 возвращается на его вход
    expect(rules(loop, "idef0_self_loop").map((i) => i.element_id)).toEqual(["o1"]);
  });

  it("у продуктов без источника и назначения — одно сводное замечание", () => {
    const m = structuredModel();
    // d1: вход без выпускающей функции и без внешнего поставщика; d4: выход без потребителя и без внешнего потребителя
    expect(rules(m, "data_no_supplier").map((i) => i.element_id)).toEqual(["d1"]);
    expect(rules(m, "data_no_consumer").map((i) => i.element_id)).toEqual(["d4"]);
    m.data.find((d) => d.id === "d1")!.supplier = "Протокол совещания";
    m.data.find((d) => d.id === "d4")!.consumer = "Конечный продукт";
    expect(rules(m, "data_no_supplier")).toEqual([]);
    expect(rules(m, "data_no_consumer")).toEqual([]);
  });

  it("код источника: несуществующая функция этого процесса, не та функция, чужой процесс", () => {
    const m = structuredModel();
    const d3 = m.data.find((d) => d.id === "d3")!; // выпускает s1 (B002.01.00) и o2 (B002.01.02)
    d3.supplier = "B002.01.02";
    expect(rules(m, "data_ref_mismatch")).toEqual([]);
    d3.supplier = "B002.02.01"; // эта операция продукт не выпускает
    const wrong = rules(m, "data_ref_mismatch");
    expect(wrong).toHaveLength(1);
    expect(wrong[0].message).toMatch(/указан B002\.02\.01, а по связям функций это B002\.01\.00, B002\.01\.02/);
    d3.supplier = "Операция B002.09.09";
    expect(rules(m, "data_ref_unknown_code")).toHaveLength(1);
    d3.supplier = "B003.01.01"; // код другого процесса — внешняя ссылка
    expect(rules(m, "data_ref_unknown_code")).toEqual([]);
    expect(rules(m, "data_ref_mismatch")).toEqual([]);
    d3.supplier = "В002.01.02"; // кириллическая «В» из документов
    expect(rules(m, "data_ref_mismatch")).toEqual([]);
  });

  it("названия блоков: отглагольное существительное допустимо в модели по Соглашению", () => {
    const m = structuredModel();
    expect(validateModel(m).filter((i) => i.rule === "naming_action_style")).toEqual([]);
    const plain = purchaseModel();
    plain.nodes[0].name = "Оформление заявки";
    expect(validateModel(plain).some((i) => i.rule === "naming_action_style" && i.element_id === "a")).toBe(true);
  });

  it("правила Соглашения молчат без структурного кода процесса", () => {
    const m = purchaseModel();
    const quiet = ["idef0_duplicate_name", "idef0_self_loop", "data_no_supplier", "data_no_consumer", "bpmn_xor_after_task", "bpmn_split_without_gateway", "bpmn_event_not_fact"];
    expect(validateModel(m).filter((i) => quiet.includes(i.rule))).toEqual([]);
  });
});

describe("эвристики названий", () => {
  it("события-факты", () => {
    for (const ok of ["Заявка получена", "Получена заявка", "Реестр актуализирован", "Карта закрыта", "Сотрудник принял решение", "Протоколы согласованы"]) expect(looksLikeFact(ok), ok).toBe(true);
    for (const bad of ["Заявка", "Пункт протокола совещания", "Начало", "Получить заявку", "Конец", "Событие"]) expect(looksLikeFact(bad), bad).toBe(false);
  });

  it("отглагольные существительные", () => {
    for (const ok of ["Актуализация реестра", "Проверка заявки", "Проведение первичного интервью", "Анализ эффективности", "Контроль качества"]) expect(hasVerbalNoun(ok), ok).toBe(true);
    for (const bad of ["Реестр процессов", "Начальник отдела"]) expect(hasVerbalNoun(bad), bad).toBe(false);
  });
});
