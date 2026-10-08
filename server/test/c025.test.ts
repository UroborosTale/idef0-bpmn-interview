import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApp } from "./api.js";
import { buildVsdx } from "../src/export/vsdx.js";
import { generateBpmn } from "../src/pipeline/bpmn.js";
import { REFERENCE_PROCESSES } from "../src/reference/index.js";
import { c025Model } from "../src/reference/c025.js";
import { blockNumbers, bpmnHosts, functionCodes } from "../src/shared/codes.js";
import { applyPatch } from "../src/shared/patch.js";
import { validateModel } from "../src/shared/validate.js";

delete process.env.AUTH_USERS;

describe("процесс C025 по документу «ДПО от 05.10»", () => {
  it("структура и порядок как в документе: A-0 → A0 → C025.01.00 и её операции → C025.02.00 и её операции", () => {
    const m = c025Model();
    const codes = functionCodes(m);
    expect([...codes].map(([id, c]) => `${c} ${m.nodes.find((n) => n.id === id)!.name}`)).toEqual([
      "C025.01.00 Оформление заявки на обучение сотрудника",
      "C025.01.01 Формирование заявки на обучение",
      "C025.01.02 Согласование заявки на обучение",
      "C025.01.03 Подтверждение программы обучения",
      "C025.02.00 Проведение обучения",
      "C025.02.01 Сопровождение обучения сотрудника",
      "C025.02.02 Учет результата обучения",
    ]);
    expect(m.process).toMatchObject({ code: "C025.00.00", name: "Организация обучения и аттестации персонала ООО «РУ КМЗ»", group: "Организация дополнительного профессионального обучения персонала ООО «РУ КМЗ»" });
    expect(bpmnHosts(m).map((h) => codes.get(h.id))).toEqual(["C025.01.01", "C025.01.02", "C025.01.03", "C025.02.01", "C025.02.02"]); // пять BPMN
    expect(Object.fromEntries(blockNumbers(m))).toMatchObject({ s1: "A1", o11: "A1.1", s2: "A2", o22: "A2.2" });
    expect(m.nodes.every((n) => n.status === "confirmed")).toBe(true); // всё взято из документа
  });

  it("IDEF0 по документу: вход, управление, выход и механизмы A0 и C025.01.00", () => {
    const m = c025Model();
    const name = (id: string, list: { id: string; name: string }[]) => list.find((x) => x.id === id)!.name;
    const s1 = m.nodes.find((n) => n.id === "s1")!;
    const s2 = m.nodes.find((n) => n.id === "s2")!;
    expect(s1.inputs.map((i) => name(i, m.data))).toEqual(["Сотрудник нуждающийся в обучении", "Поручение руководства"]);
    expect(s1.controls.map((i) => name(i, m.controls))).toEqual(["Приказ Минобрнауки России от 24.03.2025 № 266", "Трудовой кодекс РФ ст.196", "Список направлений обучения"]);
    expect(s1.outputs.map((i) => name(i, m.data))).toEqual(["Несогласованная заявка на обучение", "Подтверждённая заявка на обучение"]);
    expect(s2.inputs.map((i) => name(i, m.data))).toEqual(["Подтверждённая заявка на обучение", "Уведомление об отчислении сотрудника от образовательной организации"]);
    expect(s2.outputs.map((i) => name(i, m.data))).toEqual(["Обученный сотрудник", "Актуализированный раздел об образовании в карточке сотрудника", "Уведомление сотруднику о его отчислении"]);
    // A4 (декомпозиция C025.01.00): петля «Заявка возвращена на доработку» от согласования к формированию
    const o11 = m.nodes.find((n) => n.id === "o11")!;
    const o12 = m.nodes.find((n) => n.id === "o12")!;
    expect(o11.inputs).toContain("d_returned");
    expect(o12.outputs).toEqual(["d_returned", "d_unapproved", "d_approved"]);
    expect(m.nodes.find((n) => n.id === "o13")!.outputs).toEqual(["d_impossible", "d_confirmed"]);
    // механизмы: ELMA365 — система на всех функциях; должности по A0 и A4
    expect(m.nodes.filter((n) => !n.bpmn_scope).every((n) => n.system_ids.join() === "s_elma")).toBe(true);
    const roles = (node: string) => m.assignments.filter((a) => a.node_id === node).map((a) => a.role_id.replace("r_", ""));
    expect(roles("o11")).toEqual(["initiator", "elma"]);
    expect(roles("o12").sort()).toEqual(["dird", "dirhr", "elma", "mgr"]);
    expect(roles("s2")).toContain("emp");
    expect(m.roles.map((r) => r.name)).toEqual([
      "ELMA365",
      "Инициатор заявки на обучение",
      "Руководитель инициатора заявки на обучение",
      "Директор дирекции операционной эффективности",
      "Директор по персоналу и операционной эффективности",
      "Сотрудник прошедший обучение",
      "Специалист отдела обучения и развития персонала",
    ]);
    expect(m.controls.filter((c) => c.kind === "regulation").map((c) => c.name)).toEqual([
      "Федеральный закон от 29.12.2012 № 273-ФЗ «Об образовании в Российской Федерации»",
      "Приказ Минобрнауки России от 24.03.2025 № 266",
      "Трудовой кодекс РФ ст.187",
      "Трудовой кодекс РФ ст.196",
    ]);
  });

  it("BPMN по документу: состав шагов, события, развилки и дорожки каждой операции", () => {
    const m = c025Model();
    const of = (op: string) => m.nodes.filter((n) => n.bpmn_scope === op);
    const count = (op: string) => ({
      tasks: of(op).filter((n) => n.type === "task").length,
      events: of(op).filter((n) => n.type === "event").length,
      gateways: of(op).filter((n) => n.type === "gateway").length,
    });
    expect(count("o11")).toEqual({ tasks: 9, events: 4, gateways: 6 });
    expect(count("o12")).toEqual({ tasks: 13, events: 10, gateways: 5 }); // три согласования с уведомлениями
    expect(count("o13")).toEqual({ tasks: 11, events: 3, gateways: 4 });
    expect(count("o21")).toEqual({ tasks: 6, events: 6, gateways: 4 });
    expect(count("o22")).toEqual({ tasks: 7, events: 2, gateways: 3 });
    // дорожки: ELMA365 первой, затем роли в порядке документа
    const lanes = (op: string) => {
      const used = new Set(of(op).map((n) => n.role_id));
      return m.roles.filter((r) => used.has(r.id)).map((r) => r.name);
    };
    expect(lanes("o11")).toEqual(["ELMA365", "Инициатор заявки на обучение"]);
    expect(lanes("o12")).toEqual(["ELMA365", "Руководитель инициатора заявки на обучение", "Директор дирекции операционной эффективности", "Директор по персоналу и операционной эффективности"]);
    expect(lanes("o13")).toEqual(["ELMA365", "Специалист отдела обучения и развития персонала"]);
    expect(lanes("o22")).toEqual(["ELMA365", "Сотрудник прошедший обучение", "Специалист отдела обучения и развития персонала"]);
    // автоматические действия ELMA365 — сервисные задачи
    expect(of("o11").find((n) => n.name === "Выдать список подходящих направлений")).toMatchObject({ subtype: "service", role_id: "r_elma" });
    expect(of("o12").find((n) => n.name === "Принять решение о согласовании")).toMatchObject({ subtype: "user", duration: "1 день" });
    expect(of("o22").find((n) => n.name.startsWith("Прикрепить документ"))!.duration).toBe("2 рабочих дня");
    // условия на развилках: «Да»/«Нет»
    const cond = (op: string, gate: string) => m.flows.filter((f) => f.from === `${op}_${gate}`).map((f) => f.condition).sort();
    expect(cond("o11", "many")).toEqual(["Да", "Нет"]);
    expect(cond("o12", "req")).toEqual(["Да", "Нет"]);
    expect(cond("o13", "found")).toEqual(["Да", "Нет"]);
    expect(cond("o22", "correct")).toEqual(["Да", "Нет"]);
    // в C025.02.01 два начала (запуск и уведомление об отчислении), в C025.01.01 — два начала и общее слияние
    expect(of("o21").filter((n) => n.type === "event" && n.subtype === "start")).toHaveLength(2);
    expect(of("o11").filter((n) => n.type === "event" && n.subtype === "start")).toHaveLength(2);
    // примечания диаграмм — правила, привязанные к шагам
    expect(of("o11").find((n) => n.name === "Заполнить обязательные поля")!.controls).toEqual(["c_ruleFields"]);
    expect(m.controls.find((c) => c.id === "c_ruleApproval")!.description).toContain("15000 рублей");
  });

  it("свёрнутый пул «Поиск программы и внесение в список» с потоками сообщений от поиска и тендерной закупки", () => {
    const m = c025Model();
    expect(m.pools).toEqual([{ id: "p_search", name: "Поиск программы и внесение в список", code: null }]);
    const label = (id: string) => m.nodes.find((n) => n.id === id)?.name ?? m.pools.find((p) => p.id === id)?.name;
    expect(m.messages.map((x) => `${label(x.from)} → ${label(x.to)}`)).toEqual([
      "Поиск программы во внешнем контуре → Поиск программы и внесение в список",
      "Поиск программы и внесение в список → Поиск программы во внешнем контуре",
      "Проведение тендерной закупки → Поиск программы и внесение в список",
      "Поиск программы и внесение в список → Проведение тендерной закупки",
    ]);
  });

  it("что нашла проверка в документе: все замечания — настоящие пробелы документа, не ошибки модели", () => {
    const issues = validateModel(c025Model());
    const byRule = (rule: string) => issues.filter((i) => i.rule === rule);
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
    // три развилки не после задачи — так нарисованы C025.01.03 (дважды) и C025.02.01
    expect(byRule("bpmn_xor_after_task").map((i) => i.message.match(/Перед развилкой «([^»]+)»/)![1])).toEqual([
      "Договор с учебной организацией заключен?",
      "Возможно провести тендерную процедуру?",
      "Обучение было продлено?",
    ]);
    // A0 из двух блоков при рекомендуемых 3–6
    expect(byRule("idef0_block_count")).toHaveLength(1);
    // выход операции C025.01.03 «Уведомление о невозможности исполнения заявки» на A0 не показан
    expect(byRule("idef0_unbalanced")[0].message).toContain("Уведомление о невозможности исполнения заявки");
    // владелец процесса и подпроцессов в документе не назван
    expect(byRule("role_no_owner")).toHaveLength(3);
    // у входов нет поставщиков, у выходов — потребителей
    expect(byRule("data_no_supplier")[0].message).toContain("3 входов");
    expect(byRule("data_no_consumer")[0].message).toContain("4 выходов");
    expect(issues).toHaveLength(3 + 1 + 1 + 3 + 2);
  });

  it("события — факты, названия задач — действия, потоки сообщений допустимы: эти правила молчат", () => {
    const rules = new Set(validateModel(c025Model()).map((i) => i.rule));
    for (const quiet of ["bpmn_event_not_fact", "naming_action_style", "bpmn_message_endpoint", "bpmn_split_without_gateway", "bpmn_merge_without_gateway", "bpmn_unreachable_node", "bpmn_dead_end", "role_no_executor", "operation_no_bpmn", "idef0_duplicate_name"]) expect(rules.has(quiet), quiet).toBe(false);
  });

  it("BPMN каждой операции строится; в XML — пул и потоки сообщений, дорожки, шлюзы", async () => {
    const m = c025Model();
    const xmls: Record<string, string> = {};
    for (const h of bpmnHosts(m)) {
      const { xml } = await generateBpmn(m, h.id);
      expect(new XMLParser({ ignoreAttributes: false }).parse(xml)["bpmn:definitions"], h.id).toBeTruthy();
      xmls[h.id] = xml;
    }
    expect(xmls.o13).toContain('<bpmn:participant id="Pool_p_search" name="Поиск программы и внесение в список" />');
    expect(xmls.o13.match(/<bpmn:messageFlow /g)).toHaveLength(4);
    expect(xmls.o12.match(/<bpmn:intermediateCatchEvent /g)).toHaveLength(3); // три уведомления о согласовании
    expect(xmls.o12.match(/<bpmn:exclusiveGateway /g)).toHaveLength(5);
    expect([...xmls.o12.matchAll(/<bpmn:lane id="[^"]+" name="([^"]+)"/g)].map((x) => x[1])).toEqual([
      "ELMA365",
      "Руководитель инициатора заявки на обучение",
      "Директор дирекции операционной эффективности",
      "Директор по персоналу и операционной эффективности",
    ]);
    expect(xmls.o21).toContain("<bpmn:intermediateCatchEvent");
    expect(xmls.o11).toContain("<bpmn:serviceTask");
    expect(xmls.o11).toContain("Список необходимых полей для заполнения"); // примечание диаграммы
  }, 60_000);

  it("атлас Visio идёт в порядке документа: A-0, A0, A4, BPMN 01.01–01.03, A3, BPMN 02.01–02.02", async () => {
    const buf = await buildVsdx(c025Model());
    const pages = await (await JSZip.loadAsync(buf)).file("visio/pages/pages.xml")!.async("string");
    const names = [...pages.matchAll(/<Page ID="\d+" NameU="([^"]+)"/g)].map((x) => x[1]);
    expect(names).toEqual([
      "IDEF0 C025.00.00 контекст",
      "IDEF0 C025.00.00",
      "IDEF0 C025.01.00",
      "BPMN C025.01.01",
      "BPMN C025.01.02",
      "BPMN C025.01.03",
      "IDEF0 C025.02.00",
      "BPMN C025.02.01",
      "BPMN C025.02.02",
      "BPMN",
    ]);
  }, 60_000);

  it("агент может предложить правку по этому процессу; реестр демонстрационных процессов", () => {
    const m = c025Model();
    const patched = applyPatch(m, { ops: [{ op: "set_assignments", node_id: null, items: [{ role_id: "r_spec", kind: "owner", functions: [] }] }] });
    expect(patched.errors).toEqual([]);
    expect(Object.keys(REFERENCE_PROCESSES)).toEqual(["b002", "c025"]);
    // владелец процесса назначен — остаются замечания только по подпроцессам
    expect(validateModel(patched.model).filter((i) => i.rule === "role_no_owner")).toHaveLength(2);
  });
});

describe("C025 в приложении", () => {
  let app: Awaited<ReturnType<typeof startApp>>;
  beforeAll(async () => {
    app = await startApp();
  });
  afterAll(() => app.close());

  it("принимается приложением как есть; выгрузка BPMN по операциям в порядке кодов", async () => {
    const s = (await app.call("POST", "/sessions/blank", { meta: { processName: "C025" } })).body;
    expect((await app.call("PUT", `/sessions/${s.id}/model`, c025Model())).status).toBe(200);
    const read = await app.call("GET", `/agent/sessions/${s.id}/model`);
    expect(read.body.codes).toMatchObject({ s1: "C025.01.00", o13: "C025.01.03", o22: "C025.02.02" });
    const zip = await app.raw(`/sessions/${s.id}/export/bpmn.zip`);
    expect(zip.status).toBe(200);
    expect(Object.keys((await JSZip.loadAsync(zip.body)).files).sort()).toEqual([
      "C025.01.01 Формирование заявки на обучение.bpmn",
      "C025.01.02 Согласование заявки на обучение.bpmn",
      "C025.01.03 Подтверждение программы обучения.bpmn",
      "C025.02.01 Сопровождение обучения сотрудника.bpmn",
      "C025.02.02 Учет результата обучения.bpmn",
    ]);
  }, 60_000);
});
