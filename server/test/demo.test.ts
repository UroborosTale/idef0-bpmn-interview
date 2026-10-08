import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApp } from "./api.js";
import { buildVsdx } from "../src/export/vsdx.js";
import { generateBpmn } from "../src/pipeline/bpmn.js";
import { demoModel } from "../src/reference/demo.js";
import { REFERENCE_PROCESSES } from "../src/reference/index.js";
import { bpmnHosts, functionCodes } from "../src/shared/codes.js";
import { eventSpec, triggerProblem } from "../src/shared/events.js";
import { splitAccepted, validateModel } from "../src/shared/validate.js";
import { ProcessLogicModel } from "../src/types/model.js";

delete process.env.AUTH_USERS;

describe("демонстрационный процесс C090 «Закупка и ввод в эксплуатацию оборудования»", () => {
  const m = demoModel();
  const events = m.nodes.filter((n) => n.type === "event").map((n) => ({ n, spec: eventSpec(n, !!n.attached_to) }));

  it("структура по Соглашению: код, группа, три подпроцесса, шесть операций и у каждой своя диаграмма BPMN", () => {
    expect(m.process).toMatchObject({ code: "C090.00.00", group: "Демонстрационные процессы", name: "Закупка и ввод в эксплуатацию оборудования" });
    const codes = functionCodes(m);
    expect([...codes].map(([id, c]) => `${c} ${m.nodes.find((n) => n.id === id)!.name}`)).toEqual([
      "C090.01.00 Подготовка закупки",
      "C090.01.01 Оформление заявки на закупку",
      "C090.01.02 Согласование заявки на закупку",
      "C090.02.00 Выбор поставщика",
      "C090.02.01 Проведение запроса предложений",
      "C090.02.02 Заключение договора поставки",
      "C090.03.00 Поставка и приёмка",
      "C090.03.01 Контроль поставки",
      "C090.03.02 Приёмка и ввод в эксплуатацию",
    ]);
    expect(bpmnHosts(m).map((h) => codes.get(h.id))).toEqual(["C090.01.01", "C090.01.02", "C090.02.01", "C090.02.02", "C090.03.01", "C090.03.02"]);
  });

  it("проверки молчат: нет ни ошибок, ни предупреждений; единственное замечание принято с причиной", () => {
    const issues = validateModel(m);
    expect(issues.map((i) => i.rule)).toEqual(["bpmn_xor_after_task"]);
    const { active, accepted } = splitAccepted(m.accepted_issues, issues);
    expect(active).toEqual([]);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({ element_id: "o31_onTime", reason: expect.stringContaining("Статус поставки приходит от поставщика") });
    expect(m.accepted_issues).toEqual([expect.objectContaining({ rule: "bpmn_xor_after_task", element_id: "o31_onTime" })]);
  });

  it("ролевая модель: все пять видов назначений, владелец процесса и каждого подпроцесса, исполнитель у каждой операции, квалификации", () => {
    const kinds = new Set(m.assignments.map((a) => a.kind));
    expect([...kinds].sort()).toEqual(["coexecutor", "controller", "executor", "observer", "owner"]);
    expect(m.assignments.filter((a) => a.node_id === null && a.kind === "owner")).toHaveLength(1);
    for (const s of ["s1", "s2", "s3"]) expect(m.assignments.filter((a) => a.node_id === s && a.kind === "owner"), s).toHaveLength(1);
    for (const o of ["o11", "o12", "o21", "o22", "o31", "o32"]) expect(m.assignments.filter((a) => a.node_id === o && a.kind === "executor"), o).toHaveLength(1);
    expect(m.roles.every((r) => r.name)).toBe(true);
    expect(m.roles.filter((r) => r.qualification).length).toBeGreaterThanOrEqual(9);
  });

  it("продукты: внешние поставщики и потребители, ценность и стандарт качества", () => {
    const d = (id: string) => m.data.find((x) => x.id === id)!;
    expect(d("d_need")).toMatchObject({ kind: "data", supplier: "Подразделение-заказчик" });
    expect(d("d_rejectedReq").consumer).toBe("Подразделение-заказчик");
    expect(d("d_act")).toMatchObject({ consumer: "Бухгалтерия", quality_standard: expect.stringContaining("Подписан") });
    expect(m.data.every((x) => x.value)).toBe(true);
    expect(m.pools).toEqual([
      { id: "p_suppl", name: "Поставщики", code: null },
      { id: "p_acc", name: "Учёт основных средств", code: "C025.02.02" },
    ]);
    expect(m.messages).toHaveLength(6);
  });

  it("задачи — все семь видов, шлюзы — все четыре вида, подпроцессы, граничные события с прерыванием и без", () => {
    expect([...new Set(m.nodes.filter((n) => n.bpmn_scope && n.type === "task").map((n) => n.subtype))].sort()).toEqual(["business_rule", "manual", "receive", "script", "send", "service", "user"]);
    expect([...new Set(m.nodes.filter((n) => n.type === "gateway").map((n) => n.subtype))].sort()).toEqual(["event_based", "exclusive", "inclusive", "parallel"]);
    expect(m.nodes.filter((n) => n.type === "subprocess" && n.bpmn_scope)).toHaveLength(2);
    const boundary = m.nodes.filter((n) => n.attached_to);
    expect(boundary.map((n) => n.interrupting)).toEqual([false, true, true, false]); // таймер напоминания, таймер согласования, ошибка экспертизы, компенсация
    // у каждого граничного события есть продолжение
    for (const b of boundary) expect(m.flows.some((f) => f.from === b.id), b.id).toBe(true);
  });

  it("события: представлены все триггеры, кроме отмены; все допустимы своему виду; видны все параметры таймера", () => {
    const triggers = new Set(events.map((e) => e.spec.trigger));
    expect([...triggers].sort()).toEqual(["compensation", "conditional", "error", "escalation", "link", "message", "multiple", "none", "parallel_multiple", "signal", "terminate", "timer"]);
    for (const e of events) expect(triggerProblem(e.spec), e.n.id).toBeNull();
    const position = (p: string) => new Set(events.filter((e) => e.spec.position === p).map((e) => e.spec.trigger));
    expect(position("start")).toEqual(new Set(["none", "conditional", "signal", "message", "timer", "multiple", "parallel_multiple"]));
    expect(position("end")).toEqual(new Set(["none", "message", "error", "terminate", "signal"]));
    expect(position("boundary")).toEqual(new Set(["timer", "error", "compensation"]));
    expect(events.filter((e) => e.spec.position === "intermediate" && e.spec.throwing).map((e) => e.spec.trigger).sort()).toEqual(["compensation", "escalation", "escalation", "link"]);
    expect(new Set(events.filter((e) => e.spec.trigger === "timer").map((e) => e.spec.details.timer?.kind))).toEqual(new Set(["duration", "cycle", "date"]));
    expect(events.every((e) => e.spec.trigger !== "timer" || e.spec.details.timer?.value)).toBe(true);
    // ожидающее и выбрасывающее сообщение
    const msgs = events.filter((e) => e.spec.trigger === "message" && e.spec.position === "intermediate");
    expect(msgs.filter((e) => e.spec.throwing)).toHaveLength(0);
    expect(msgs).toHaveLength(2);
    // пара ссылок
    expect(events.filter((e) => e.spec.trigger === "link").map((e) => e.spec.details.name)).toEqual(["Повторить запрос", "Повторить запрос"]);
  });

  it("BPMN каждой операции строится и содержит определения триггеров", async () => {
    const xmls: Record<string, string> = {};
    for (const h of bpmnHosts(m)) {
      const { xml } = await generateBpmn(m, h.id);
      expect(new XMLParser({ ignoreAttributes: false }).parse(xml)["bpmn:definitions"], h.id).toBeTruthy();
      xmls[h.id] = xml;
    }
    expect(xmls.o11).toContain("<bpmn:conditionalEventDefinition>");
    expect(xmls.o11).toContain('<bpmn:signal id="Signal_1" name="Начало планового цикла закупок" />');
    expect(xmls.o11).toMatch(/<bpmn:boundaryEvent id="Node_o11_late"[^>]*cancelActivity="false"><bpmn:timerEventDefinition><bpmn:timeDuration[^>]*>P2D</);
    expect(xmls.o12).toMatch(/<bpmn:boundaryEvent id="Node_o12_overdue"[^>]*cancelActivity="true">/);
    expect(xmls.o12).toContain("<bpmn:escalationEventDefinition");
    expect(xmls.o12).toContain("<bpmn:terminateEventDefinition />");
    expect(xmls.o12).toContain('<bpmn:error id="Error_1" name="BUDGET_EXCEEDED" errorCode="BUDGET_EXCEEDED" />');
    expect(xmls.o21).toContain("<bpmn:eventBasedGateway");
    expect(xmls.o21.match(/<bpmn:linkEventDefinition name="Повторить запрос" \/>/g)).toHaveLength(2);
    expect(xmls.o21.match(/<bpmn:messageFlow /g)).toHaveLength(2);
    expect(xmls.o22).toContain("<bpmn:inclusiveGateway");
    expect(xmls.o22).toContain("<bpmn:scriptTask");
    expect(xmls.o22).toContain("<bpmn:receiveTask");
    expect(xmls.o31).toContain("<bpmn:timeCycle");
    expect(xmls.o31).toContain("<bpmn:timeDate");
    expect(xmls.o31).toMatch(/<bpmn:startEvent id="Node_o31_start2"[^>]*><bpmn:messageEventDefinition \/><bpmn:signalEventDefinition \/>/);
    expect(xmls.o32).toContain('parallelMultiple="true"');
    expect(xmls.o32).toContain("<bpmn:compensateEventDefinition />");
    expect(xmls.o32).toContain('<bpmn:participant id="Pool_p_acc" name="C025.02.02 Учёт основных средств" />');
    // событие-ссылка не считается началом или концом: синтетических начала и конца к ним не добавляется
    expect(xmls.o21).not.toMatch(/SynthFlow_s_o21_retry/);
  }, 90_000);

  it("ссылки: у приёмника нет входящей стрелки, но он достижим, а выбросивший — не тупик", () => {
    const rules = validateModel(m).map((i) => i.rule);
    for (const quiet of ["bpmn_unreachable_node", "bpmn_dead_end", "bpmn_link_unpaired", "bpmn_event_trigger_invalid", "bpmn_event_trigger_incomplete", "bpmn_boundary_no_trigger"]) expect(rules).not.toContain(quiet);
  });

  it("атлас Visio: контекст, A0, декомпозиции и BPMN в порядке кодов", async () => {
    const pages = await (await JSZip.loadAsync(await buildVsdx(m))).file("visio/pages/pages.xml")!.async("string");
    expect([...pages.matchAll(/<Page ID="\d+" NameU="([^"]+)"/g)].map((x) => x[1])).toEqual([
      "IDEF0 C090.00.00 контекст",
      "IDEF0 C090.00.00",
      "IDEF0 C090.01.00",
      "BPMN C090.01.01",
      "BPMN C090.01.02",
      "IDEF0 C090.02.00",
      "BPMN C090.02.01",
      "BPMN C090.02.02",
      "IDEF0 C090.03.00",
      "BPMN C090.03.01",
      "BPMN C090.03.02",
      "BPMN",
    ]);
  }, 90_000);

  it("реестр: процесс доступен как demo, модель проходит схему повторно", () => {
    expect(REFERENCE_PROCESSES.demo.build().process.code).toBe("C090.00.00");
    expect(ProcessLogicModel.safeParse(JSON.parse(JSON.stringify(m))).success).toBe(true);
  });
});

describe("демо в приложении", () => {
  let app: Awaited<ReturnType<typeof startApp>>;
  beforeAll(async () => {
    app = await startApp();
  });
  afterAll(() => app.close());

  it("принимается приложением как есть; агент видит принятое замечание отдельно; выгрузка BPMN по операциям", async () => {
    const s = (await app.call("POST", "/sessions/blank", { meta: { processName: "C090" } })).body;
    expect((await app.call("PUT", `/sessions/${s.id}/model`, demoModel())).status).toBe(200);
    const read = await app.call("GET", `/agent/sessions/${s.id}/model`);
    expect(read.body.codes).toMatchObject({ s1: "C090.01.00", o31: "C090.03.01", o32: "C090.03.02" });
    expect(read.body.issues).toEqual([]);
    expect(read.body.accepted.map((i: { rule: string }) => i.rule)).toEqual(["bpmn_xor_after_task"]);
    const zip = await app.raw(`/sessions/${s.id}/export/bpmn.zip`);
    expect(Object.keys((await JSZip.loadAsync(zip.body)).files).sort()).toHaveLength(6);
  }, 90_000);
});
