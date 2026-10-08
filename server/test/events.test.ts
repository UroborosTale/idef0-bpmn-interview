import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { buildVsdx } from "../src/export/vsdx.js";
import { buildModelFromParsedBpmn, parseBpmnXml } from "../src/pipeline/diagramImport.js";
import { buildCamundaBpmn } from "../src/pipeline/bpmsExport.js";
import { generateBpmn } from "../src/pipeline/bpmn.js";
import { outline, type ModelView } from "../src/mcp/outline.js";
import { TRIGGER_TYPES, allowedTriggers, eventSpec, triggerGaps, triggerGlyph, triggerProblem, triggerSummary, withTrigger, type EventTrigger } from "../src/shared/events.js";
import { applyPatch } from "../src/shared/patch.js";
import { validateModel } from "../src/shared/validate.js";
import { ProcessNode } from "../src/types/model.js";
import type { ProcessLogicModel } from "../src/types/model.js";
import { structuredModel } from "./fixtures.js";

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
const ev = (id: string, subtype: string, trigger?: EventTrigger, extra: Record<string, unknown> = {}) => node(id, { type: "event", subtype, ...(trigger ? { trigger } : {}), name: `Событие ${id}`, role_id: "r2", bpmn_scope: "o1", ...extra }) as never;
const issues = (m: ProcessLogicModel, rule: string) => validateModel(m).filter((i) => i.rule === rule);

describe("вид события и триггер", () => {
  it("прежняя запись: timer и message ждут, signal выбрасывается, error вне границы — конец с ошибкой", () => {
    expect(eventSpec({ type: "event", subtype: "timer" })).toMatchObject({ position: "intermediate", trigger: "timer", throwing: false });
    expect(eventSpec({ type: "event", subtype: "message" })).toMatchObject({ position: "intermediate", trigger: "message", throwing: false });
    expect(eventSpec({ type: "event", subtype: "signal" })).toMatchObject({ trigger: "signal", throwing: true });
    expect(eventSpec({ type: "event", subtype: "error" })).toMatchObject({ position: "end", trigger: "error", throwing: true });
    expect(eventSpec({ type: "event", subtype: "error" }, true)).toMatchObject({ position: "boundary", trigger: "error", throwing: false });
    expect(eventSpec({ type: "event", subtype: "start" })).toMatchObject({ position: "start", trigger: "none", throwing: false });
    expect(eventSpec({ type: "event", subtype: "end" })).toMatchObject({ position: "end", throwing: true });
    expect(eventSpec({ type: "event", subtype: "intermediate" })).toMatchObject({ trigger: "none", throwing: true });
  });

  it("новая запись: направление берётся из trigger, по умолчанию ждут сообщение, таймер, условие, ссылка; выбрасывают сигнал и эскалация", () => {
    const s = (t: EventTrigger) => eventSpec({ type: "event", subtype: "intermediate", trigger: t });
    expect(s({ type: "message", direction: "throw" }).throwing).toBe(true);
    expect(s({ type: "message" }).throwing).toBe(false);
    expect(s({ type: "timer" }).throwing).toBe(false);
    expect(s({ type: "signal" }).throwing).toBe(true);
    expect(s({ type: "escalation" }).throwing).toBe(true);
    expect(eventSpec({ type: "event", subtype: "start", trigger: { type: "message", direction: "throw" } }).throwing).toBe(false); // начало всегда ждёт
  });

  it("допустимые триггеры по виду события (BPMN 2.0)", () => {
    expect(allowedTriggers("start")).toEqual(expect.arrayContaining(["message", "timer", "conditional", "signal"]));
    expect(allowedTriggers("start")).not.toContain("error");
    expect(allowedTriggers("end")).toEqual(expect.arrayContaining(["terminate", "error", "escalation", "cancel"]));
    expect(allowedTriggers("end")).not.toContain("timer");
    expect(allowedTriggers("boundary")).not.toContain("none");
    expect(allowedTriggers("boundary")).toContain("error");
    expect(allowedTriggers("intermediate", false)).toContain("timer");
    expect(allowedTriggers("intermediate", true)).not.toContain("timer");
    expect(allowedTriggers("intermediate", true)).toContain("escalation");
    for (const t of TRIGGER_TYPES) expect(["none", "message", "timer", "conditional", "signal", "error", "escalation", "compensation", "cancel", "link", "terminate", "multiple", "parallel_multiple"]).toContain(t);
  });

  it("объяснение, почему триггер не подходит", () => {
    expect(triggerProblem(eventSpec({ type: "event", subtype: "start", trigger: { type: "error" } }))).toMatch(/не может иметь триггер «ошибка»/);
    expect(triggerProblem(eventSpec({ type: "event", subtype: "intermediate", trigger: { type: "timer", direction: "throw" } }))).toMatch(/не может выбрасывать/);
    expect(triggerProblem(eventSpec({ type: "event", subtype: "intermediate", trigger: { type: "terminate", direction: "catch" } }))).toMatch(/не может ждать/);
    expect(triggerProblem(eventSpec({ type: "event", subtype: "intermediate" }, true))).toMatch(/нужен триггер/);
    expect(triggerProblem(eventSpec({ type: "event", subtype: "end", trigger: { type: "terminate" } }))).toBeNull();
  });

  it("незаполненные параметры и краткая подпись", () => {
    const gaps = (t: EventTrigger, sub = "intermediate") => triggerGaps(eventSpec({ type: "event", subtype: sub, trigger: t }));
    expect(gaps({ type: "timer" })[0]).toMatch(/таймер/);
    expect(gaps({ type: "timer", timer: { kind: "duration", value: "P3D" } })).toEqual([]);
    expect(gaps({ type: "conditional" })[0]).toMatch(/условие/);
    expect(gaps({ type: "message" }, "start")[0]).toMatch(/название сообщения/);
    expect(gaps({ type: "multiple", members: ["message"] })[0]).toMatch(/не меньше двух/);
    expect(triggerSummary(eventSpec({ type: "event", subtype: "intermediate", trigger: { type: "timer", timer: { kind: "duration", value: "P3D" } } }))).toBe("Таймер: P3D");
    expect(triggerSummary(eventSpec({ type: "event", subtype: "start" }))).toBe("Без триггера");
  });

  it("смена триггера переводит прежнюю запись в новую и убирает «без триггера»", () => {
    const n = withTrigger({ type: "event", subtype: "timer" }, { type: "message", direction: "catch" });
    expect(n).toMatchObject({ subtype: "intermediate", trigger: { type: "message" } });
    expect(withTrigger(n, { type: "none" }).trigger).toBeNull();
    expect(withTrigger({ type: "event", subtype: "start" }, null)).toMatchObject({ subtype: "start", trigger: null });
  });

  it("значки: ждущие — контур, выбрасывающие — залиты; терминатор всегда залит; нет значка у «без триггера»", () => {
    expect(triggerGlyph("none", false)).toEqual([]);
    expect(triggerGlyph("message", false).some((g) => g.kind === "poly" && g.filled)).toBe(false);
    expect(triggerGlyph("message", true).some((g) => g.kind === "poly" && g.filled)).toBe(true);
    expect(triggerGlyph("terminate", false)).toEqual([{ kind: "circle", r: 9, filled: true }]);
    expect(triggerGlyph("timer", true).some((g) => (g as { filled?: boolean }).filled)).toBe(false); // таймер не выбрасывают
    for (const t of TRIGGER_TYPES) for (const g of triggerGlyph(t, true)) if (g.kind === "poly") expect(g.pts.every(([x, y]) => Math.abs(x) <= 10 && Math.abs(y) <= 10)).toBe(true); // значок помещается в круг
  });

  it("схема модели принимает trigger и отвергает неизвестный тип", () => {
    const base = node("e", { type: "event", subtype: "intermediate" });
    expect(ProcessNode.safeParse({ ...base, trigger: { type: "timer", direction: "catch", timer: { kind: "cycle", value: "R/P1W" } } }).success).toBe(true);
    expect(ProcessNode.safeParse({ ...base, trigger: { type: "unicorn" } }).success).toBe(false);
    expect(ProcessNode.safeParse({ ...base, trigger: null }).success).toBe(true);
  });
});

describe("BPMN XML: определения триггеров", () => {
  async function xmlOf(...nodes: unknown[]) {
    const m = structuredModel();
    m.nodes.push(...(nodes as never[]));
    return (await generateBpmn(m, "o1")).xml;
  }

  it("таймер: дата, срок и период; без значения — пустое определение", async () => {
    const xml = await xmlOf(
      ev("t1", "intermediate", { type: "timer", direction: "catch", timer: { kind: "duration", value: "P3D" } }),
      ev("t2", "start", { type: "timer", timer: { kind: "date", value: "2026-12-31T09:00:00" } }),
      ev("t3", "intermediate", { type: "timer", direction: "catch", timer: { kind: "cycle", value: "R/P1W" } }),
      ev("t4", "intermediate", { type: "timer", direction: "catch" }),
    );
    expect(xml).toMatch(/<bpmn:intermediateCatchEvent id="Node_t1"[^>]*><bpmn:timerEventDefinition><bpmn:timeDuration xsi:type="bpmn:tFormalExpression">P3D<\/bpmn:timeDuration>/);
    expect(xml).toMatch(/<bpmn:startEvent id="Node_t2"[^>]*><bpmn:timerEventDefinition><bpmn:timeDate xsi:type="bpmn:tFormalExpression">2026-12-31T09:00:00</);
    expect(xml).toMatch(/<bpmn:timeCycle xsi:type="bpmn:tFormalExpression">R\/P1W</);
    expect(xml).toMatch(/<bpmn:intermediateCatchEvent id="Node_t4"[^>]*><bpmn:timerEventDefinition \/>/);
  });

  it("сообщение: получение и отправка выбирают разные элементы, название объявляется один раз и подставляется по ссылке", async () => {
    const xml = await xmlOf(
      ev("m1", "intermediate", { type: "message", direction: "catch", name: "Заявка" }),
      ev("m2", "intermediate", { type: "message", direction: "throw", name: "Заявка" }),
      ev("m3", "end", { type: "message", name: "Уведомление" }),
      ev("m4", "start", { type: "message", name: "Заявка" }),
    );
    expect(xml).toMatch(/<bpmn:intermediateCatchEvent id="Node_m1"/);
    expect(xml).toMatch(/<bpmn:intermediateThrowEvent id="Node_m2"/);
    expect(xml).toMatch(/<bpmn:endEvent id="Node_m3"[^>]*><bpmn:messageEventDefinition messageRef="Message_2" \/>/);
    expect(xml.match(/<bpmn:message id="Message_\d+" name="Заявка" \/>/g)).toHaveLength(1);
    expect(xml).toMatch(/<bpmn:message id="Message_1" name="Заявка" \/>/);
    expect(xml.indexOf("<bpmn:message ")).toBeLessThan(xml.indexOf("<bpmn:collaboration"));
    expect(xml.match(/messageRef="Message_1"/g)).toHaveLength(3);
  });

  it("условие, сигнал, ошибка, эскалация, компенсация, отмена, терминатор, ссылка", async () => {
    const xml = await xmlOf(
      ev("c1", "start", { type: "conditional", condition: "остаток < 10 & срочно" }),
      ev("s1", "end", { type: "signal", name: "Стоп" }),
      ev("e1", "end", { type: "error", name: "E42" }),
      ev("x1", "intermediate", { type: "escalation", direction: "throw", name: "Директору" }),
      ev("k1", "intermediate", { type: "compensation", direction: "throw" }),
      ev("t1", "end", { type: "terminate" }),
      ev("l1", "intermediate", { type: "link", direction: "throw", name: "Дальше" }),
      ev("l2", "intermediate", { type: "link", direction: "catch", name: "Дальше" }),
    );
    expect(xml).toMatch(/<bpmn:conditionalEventDefinition><bpmn:condition xsi:type="bpmn:tFormalExpression">остаток &lt; 10 &amp; срочно<\/bpmn:condition>/);
    expect(xml).toMatch(/<bpmn:signal id="Signal_1" name="Стоп" \/>/);
    expect(xml).toMatch(/<bpmn:signalEventDefinition signalRef="Signal_1" \/>/);
    expect(xml).toMatch(/<bpmn:error id="Error_1" name="E42" errorCode="E42" \/>/);
    expect(xml).toMatch(/<bpmn:escalationEventDefinition escalationRef="Escalation_1" \/>/);
    expect(xml).toMatch(/<bpmn:escalation id="Escalation_1" name="Директору" escalationCode="Директору" \/>/);
    expect(xml).toMatch(/<bpmn:intermediateThrowEvent id="Node_k1"[^>]*><bpmn:compensateEventDefinition \/>/);
    expect(xml).toMatch(/<bpmn:endEvent id="Node_t1"[^>]*><bpmn:terminateEventDefinition \/>/);
    expect(xml).toMatch(/<bpmn:intermediateThrowEvent id="Node_l1"[^>]*><bpmn:linkEventDefinition name="Дальше" \/>/);
    expect(xml).toMatch(/<bpmn:intermediateCatchEvent id="Node_l2"[^>]*><bpmn:linkEventDefinition name="Дальше" \/>/);
  });

  it("несколько триггеров: список определений; «все сразу» — parallelMultiple", async () => {
    const xml = await xmlOf(
      ev("u1", "start", { type: "multiple", members: ["message", "timer"] }),
      ev("u2", "start", { type: "parallel_multiple", members: ["message", "signal"] }),
    );
    expect(xml).toMatch(/<bpmn:startEvent id="Node_u1"[^>]*><bpmn:messageEventDefinition \/><bpmn:timerEventDefinition \/><\/bpmn:startEvent>/);
    expect(xml).toMatch(/<bpmn:startEvent id="Node_u2" name="[^"]*" parallelMultiple="true"><bpmn:messageEventDefinition \/><bpmn:signalEventDefinition \/>/);
  });

  it("граничное событие с триггером: ошибка, условие; прежняя запись даёт тот же XML", async () => {
    const m = structuredModel();
    m.nodes.push(ev("bn", "intermediate", { type: "error", name: "Сбой" }, { attached_to: "b1", interrupting: true }), ev("bo", "timer", undefined, { attached_to: "b2", interrupting: false }));
    const { xml, diagram } = await generateBpmn(m, "o1");
    expect(xml).toMatch(/<bpmn:boundaryEvent id="Node_bn"[^>]*attachedToRef="Node_b1" cancelActivity="true"><bpmn:errorEventDefinition errorRef="Error_1" \/>/);
    expect(xml).toMatch(/<bpmn:boundaryEvent id="Node_bo"[^>]*attachedToRef="Node_b2" cancelActivity="false"><bpmn:timerEventDefinition \/>/);
    expect(diagram.shapes.find((s) => s.nodeId === "bn")!.event).toEqual({ position: "boundary", trigger: "error", throwing: false });
  });

  it("данные для VSDX и редактора: вид, триггер, направление", async () => {
    const m = structuredModel();
    m.nodes.push(ev("m2", "intermediate", { type: "message", direction: "throw", name: "Заявка" }));
    const shape = (await generateBpmn(m, "o1")).diagram.shapes.find((s) => s.nodeId === "m2")!;
    expect(shape.event).toEqual({ position: "intermediate", trigger: "message", throwing: true });
    expect((await generateBpmn(m, "o1")).diagram.shapes.find((s) => s.nodeId === "b0")!.event).toEqual({ position: "start", trigger: "none", throwing: false });
  });
});

describe("проверки событий", () => {
  const withEvents = (...nodes: unknown[]) => {
    const m = structuredModel();
    m.nodes.push(...(nodes as never[]));
    return m;
  };

  it("триггер, не подходящий виду события — ошибка с объяснением", () => {
    const m = withEvents(ev("x", "start", { type: "error" }), ev("y", "end", { type: "timer" }), ev("z", "intermediate", { type: "terminate", direction: "catch" }));
    const found = issues(m, "bpmn_event_trigger_invalid");
    expect(found.map((i) => i.element_id).sort()).toEqual(["x", "y", "z"]);
    expect(found.every((i) => i.severity === "error")).toBe(true);
    expect(found.find((i) => i.element_id === "x")!.message).toMatch(/начальное событие не может иметь триггер «ошибка»/);
  });

  it("корректные сочетания замечаний не дают; прежние записи timer/message/error/signal — тоже", () => {
    const m = withEvents(
      ev("a", "start", { type: "message", name: "Заявка" }),
      ev("b", "end", { type: "terminate" }),
      ev("c", "timer"),
      ev("d", "message"),
      ev("e", "signal"),
      ev("f", "error"),
    );
    expect(issues(m, "bpmn_event_trigger_invalid")).toEqual([]);
    expect(issues(m, "bpmn_event_trigger_incomplete")).toEqual([]);
  });

  it("граничное событие без триггера — предупреждение", () => {
    const m = withEvents(ev("g", "intermediate", undefined, { attached_to: "b1" }));
    expect(issues(m, "bpmn_boundary_no_trigger").map((i) => i.element_id)).toEqual(["g"]);
  });

  it("явно заданный триггер без параметров — предупреждение о том, что заполнить", () => {
    const m = withEvents(ev("t", "intermediate", { type: "timer", direction: "catch" }), ev("c", "start", { type: "conditional" }), ev("n", "start", { type: "message" }), ev("ok", "intermediate", { type: "timer", direction: "catch", timer: { kind: "duration", value: "P1D" } }));
    const found = issues(m, "bpmn_event_trigger_incomplete");
    expect(found.map((i) => i.element_id).sort()).toEqual(["c", "n", "t"]);
    expect(found.find((i) => i.element_id === "t")!.message).toMatch(/не задано, когда срабатывает таймер/);
  });

  it("ссылки: выбросивший без принимающего и наоборот; пара с одним именем — в порядке", () => {
    const paired = withEvents(ev("l1", "intermediate", { type: "link", direction: "throw", name: "Дальше" }), ev("l2", "intermediate", { type: "link", direction: "catch", name: "ДАЛЬШЕ" }));
    expect(issues(paired, "bpmn_link_unpaired")).toEqual([]);
    const alone = withEvents(ev("l1", "intermediate", { type: "link", direction: "throw", name: "Туда" }), ev("l3", "intermediate", { type: "link", direction: "catch", name: "Сюда" }));
    expect(issues(alone, "bpmn_link_unpaired").map((i) => i.element_id).sort()).toEqual(["l1", "l3"]);
  });

  it("таймер с триггером освобождён от правила «событие — факт»", () => {
    const m = withEvents(ev("tm", "intermediate", { type: "timer", direction: "catch", timer: { kind: "duration", value: "P1D" } }, { name: "Через три дня" }), ev("msg", "intermediate", { type: "message", direction: "catch", name: "x" }, { name: "Через три дня" }));
    const ids = issues(m, "bpmn_event_not_fact").map((i) => i.element_id);
    expect(ids).not.toContain("tm");
  });

  it("поток сообщений: от события-сообщения можно, от таймера и условия нельзя", () => {
    const m = withEvents(ev("send", "end", { type: "message", name: "Уведомление" }), ev("wait", "intermediate", { type: "timer", direction: "catch" }), ev("cond", "start", { type: "conditional" }));
    m.pools = [{ id: "pool1", name: "Партнёр" }] as never;
    m.messages = [
      { id: "mm1", from: "send", to: "pool1" },
      { id: "mm2", from: "wait", to: "pool1" },
      { id: "mm3", from: "cond", to: "pool1" },
    ] as never;
    const bad = issues(m, "bpmn_message_endpoint").map((i) => i.element_id).sort();
    expect(bad).toEqual(["cond", "wait"]);
  });
});

describe("экспорт и импорт триггеров", () => {
  it("BPMN → модель: триггеры, направление, граничное событие и его прерывание восстанавливаются", async () => {
    const m = structuredModel();
    m.nodes.push(
      ev("t", "intermediate", { type: "timer", direction: "catch", timer: { kind: "duration", value: "P3D" } }),
      ev("mg", "intermediate", { type: "message", direction: "throw", name: "Заявка & отчёт" }),
      ev("cd", "start", { type: "conditional", condition: "сумма > 100" }),
      ev("lk", "intermediate", { type: "link", direction: "catch", name: "Дальше" }),
      ev("mu", "start", { type: "multiple", members: ["message", "timer"] }),
      ev("bn", "intermediate", { type: "error", name: "E42" }, { attached_to: "b1", interrupting: false }),
    );
    const { xml } = await generateBpmn(m, "o1");
    const parsed = parseBpmnXml(xml);
    const { model } = buildModelFromParsedBpmn(parsed, { processName: "x" } as never);
    const byName = (n: string) => model.nodes.find((x) => x.name === `Событие ${n}`)!;
    expect(byName("t")).toMatchObject({ subtype: "intermediate", trigger: { type: "timer", direction: "catch", timer: { kind: "duration", value: "P3D" } } });
    expect(byName("mg")).toMatchObject({ trigger: { type: "message", direction: "throw", name: "Заявка & отчёт" } });
    expect(byName("cd")).toMatchObject({ subtype: "start", trigger: { type: "conditional", condition: "сумма > 100" } });
    expect(byName("lk")).toMatchObject({ trigger: { type: "link", direction: "catch", name: "Дальше" } });
    expect(byName("mu")).toMatchObject({ trigger: { type: "multiple", members: ["message", "timer"] } });
    const be = byName("bn");
    expect(be).toMatchObject({ trigger: { type: "error", name: "E42" }, interrupting: false });
    expect(model.nodes.find((n) => n.id === be.attached_to)?.name).toBe("Открыть реестр"); // название задачи b1
  });

  it("экспорт в Camunda: триггеры и граничное событие; таймер без срока берёт длительность шага", () => {
    const m = structuredModel();
    m.nodes.push(
      ev("t", "intermediate", { type: "timer", direction: "catch" }, { duration: "2 часа" }),
      ev("mg", "end", { type: "message", name: "Готово" }),
      ev("bn", "intermediate", { type: "error", name: "E1" }, { attached_to: "b1" }),
    );
    const { xml } = buildCamundaBpmn(m);
    expect(xml).toMatch(/<bpmn:intermediateCatchEvent id="Node_t"[^>]*><bpmn:timerEventDefinition><bpmn:timeDuration xsi:type="bpmn:tFormalExpression">PT2H<\/bpmn:timeDuration>/);
    expect(xml).toMatch(/<bpmn:endEvent id="Node_mg"[^>]*><bpmn:messageEventDefinition messageRef="Message_1" \/>/);
    expect(xml).toMatch(/<bpmn:boundaryEvent id="Node_bn"[^>]*attachedToRef="Node_b1" cancelActivity="true"><bpmn:errorEventDefinition errorRef="Error_1" \/>/);
    expect(xml).toMatch(/<bpmn:message id="Message_1" name="Готово" \/>/);
  });

  it("VSDX: значки триггеров рисуются; у выбрасывающего события — чёрная заливка отдельной фигурой", async () => {
    const plain = structuredModel();
    plain.nodes.push(ev("ca", "intermediate", { type: "message", direction: "catch", name: "x" }));
    const thrown = structuredModel();
    thrown.nodes.push(ev("th", "intermediate", { type: "message", direction: "throw", name: "x" }));
    const count = async (m: ProcessLogicModel) => {
      const zip = await JSZip.loadAsync(await buildVsdx(m));
      const pages = Object.keys(zip.files).filter((f) => /visio\/pages\/page\d+\.xml$/.test(f));
      const xml = (await Promise.all(pages.map((p) => zip.file(p)!.async("string")))).join("\n");
      return xml.split('<Cell N="FillForegnd" V="#1f2937"/>').length - 1;
    };
    expect(await count(thrown)).toBeGreaterThan(await count(plain));
  });
});

describe("агент и предложения", () => {
  it("конспект модели называет вид, направление и параметры триггера", () => {
    const m = structuredModel();
    m.nodes.push(ev("t", "intermediate", { type: "timer", direction: "catch", timer: { kind: "duration", value: "P3D" } }), ev("bn", "intermediate", { type: "error", name: "E1" }, { attached_to: "b1" }));
    const view = { processCode: "B002.00.00", updatedAt: "now", codes: {}, issues: [], model: { ...m, process: m.process } } as unknown as ModelView;
    const text = outline(view);
    expect(text).toContain("промежуточное, ждёт — Таймер: P3D");
    expect(text).toContain("граничное — Ошибка: E1");
  });

  it("предложение с триггером, не подходящим виду события, отклоняется с объяснением", () => {
    const m = structuredModel() as never;
    const bad = applyPatch(m, { summary: "x", ops: [{ op: "add", collection: "nodes", value: { id: "n99", type: "event", subtype: "start", name: "Заявка получена", bpmn_scope: "o1", trigger: { type: "error" } } }] } as never);
    expect(JSON.stringify(bad.errors)).toMatch(/не может иметь триггер/);
    const unknown = applyPatch(m, { summary: "x", ops: [{ op: "add", collection: "nodes", value: { id: "n98", type: "event", subtype: "start", name: "Заявка получена", bpmn_scope: "o1", trigger: { type: "magic" } } }] } as never);
    expect(JSON.stringify(unknown.errors)).toMatch(/неизвестный триггер/);
  });
});
