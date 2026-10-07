import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApp } from "./api.js";
import { generateBpmn } from "../src/pipeline/bpmn.js";
import { REFERENCE_PROCESSES } from "../src/reference/index.js";
import { c025Model } from "../src/reference/c025.js";
import { bpmnHosts, functionCodes } from "../src/shared/codes.js";
import { applyPatch } from "../src/shared/patch.js";
import { productStages } from "../src/shared/products.js";
import { validateModel } from "../src/shared/validate.js";

delete process.env.AUTH_USERS;

describe("демонстрационный процесс C025: все нововведения в одном процессе", () => {
  it("структура по кодам Соглашения; группа процессов; черновик", () => {
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
      "C025.03.00 Аттестация сотрудника по итогам обучения",
      "C025.03.01 Проведение аттестации сотрудника",
    ]);
    expect(m.process).toMatchObject({ code: "C025.00.00", group: "Организация дополнительного профессионального обучения персонала ООО «РУ КМЗ»", status: "draft" });
    expect(m.process.goal).toMatch(/^ЧЕРНОВИК/);
    expect(bpmnHosts(m)).toHaveLength(6); // у каждой операции своя диаграмма BPMN
    // содержание придумано — все функции и шаги помечены гипотезами
    expect(m.nodes.every((n) => n.status === "hypothesis")).toBe(true);
  });

  it("проходит все проверки: ни ошибок, ни предупреждений", () => {
    expect(validateModel(c025Model())).toEqual([]);
  });

  it("ролевая модель: все пять видов ролей, квалификация, функции ролей", () => {
    const m = c025Model();
    expect(new Set(m.assignments.map((a) => a.kind))).toEqual(new Set(["owner", "executor", "coexecutor", "controller", "observer"]));
    expect(m.roles).toHaveLength(5);
    expect(m.roles.find((r) => r.id === "r_hr")!.qualification).toMatch(/Опыт организации обучения/);
    expect(m.assignments.find((a) => a.node_id === "o11" && a.role_id === "r_hr")!.functions).toHaveLength(2);
    expect(m.assignments.filter((a) => a.kind === "owner").map((a) => a.node_id)).toEqual([null, "s1", "s2", "s3"]);
  });

  it("элементы BPMN: бизнес-правила, граничные события (прерывающее и нет), подпроцесс, шлюзы XOR и AND, таймеры", () => {
    const m = c025Model();
    expect(m.nodes.filter((n) => n.subtype === "business_rule").map((n) => n.bpmn_scope).sort()).toEqual(["o11", "o22", "o31"]);
    const boundary = m.nodes.filter((n) => n.attached_to);
    expect(boundary.map((n) => [n.bpmn_scope, n.subtype, n.interrupting])).toEqual([["o11", "timer", false], ["o12", "timer", true]]);
    for (const b of boundary) {
      const host = m.nodes.find((n) => n.id === b.attached_to)!;
      expect(host.bpmn_scope).toBe(b.bpmn_scope);
      expect(b.role_id).toBe(host.role_id); // граничное событие — в дорожке своей задачи
      expect(m.flows.some((f) => f.from === b.id)).toBe(true); // у него есть своя ветка
    }
    expect(m.nodes.filter((n) => n.type === "subprocess" && n.bpmn_scope)).toHaveLength(1);
    expect(m.nodes.filter((n) => n.type === "gateway" && n.subtype === "parallel")).toHaveLength(2); // разветвление и слияние
    expect(m.nodes.filter((n) => n.subtype === "timer" && !n.attached_to).map((n) => n.name)).toEqual(["Начало обучения", "Наступление даты аттестации"]);
    // документы на ассоциациях и хранилища данных
    const withDocs = m.nodes.filter((n) => n.bpmn_scope && (n.inputs.length > 0 || n.outputs.length > 0));
    expect(withDocs.length).toBeGreaterThan(10);
    expect(new Set(m.nodes.flatMap((n) => n.system_ids))).toEqual(new Set(["s_elma", "s_outlook", "s_excel", "s_zup"]));
    expect(m.nodes.filter((n) => n.controls.length > 0 && n.bpmn_scope).length).toBeGreaterThanOrEqual(3); // регламенты-аннотации
  });

  it("внешний пул «Учебный центр» и потоки сообщений: заявка — подтверждение, документ — запрос исправления", () => {
    const m = c025Model();
    expect(m.pools).toEqual([{ id: "p_center", name: "Учебный центр", code: null }]);
    const label = (id: string) => m.nodes.find((n) => n.id === id)?.name ?? m.pools.find((p) => p.id === id)?.name;
    expect(m.messages.map((x) => `${label(x.from)} → ${label(x.to)}: ${x.name}`)).toEqual([
      "Отправить заявку в учебный центр → Учебный центр: Заявка на обучение",
      "Учебный центр → Получить подтверждение программы обучения: Подтверждение программы",
      "Учебный центр → Получить документ о результатах обучения: Документ об обучении",
      "Запросить исправление документа → Учебный центр: Запрос исправления документа",
    ]);
    // отправляет задача «Отправка», получает — «Получение» (проверка Соглашения об этом молчит)
    expect(validateModel(m).filter((i) => i.rule === "bpmn_message_endpoint")).toEqual([]);
  });

  it("карточки продуктов: внешний поставщик и потребитель, ценность, стандарт качества; цепочка статусов", () => {
    const m = c025Model();
    const card = (id: string) => m.data.find((d) => d.id === id)!;
    expect(card("d_need")).toMatchObject({ supplier: "Руководители подразделений", value: expect.any(String), quality_standard: expect.any(String) });
    expect(card("d_application")).toMatchObject({ value: expect.stringContaining("согласования расходов"), quality_standard: expect.stringContaining("обязательные поля") });
    expect(card("d_attestation").consumer).toBe("Отдел кадров (личное дело сотрудника)");
    const stages = productStages(m);
    const layer = Object.fromEntries(stages.items.map((i) => [i.id, i.layer]));
    // на схеме верхнего уровня: потребность → подтверждённая программа → результат обучения → результат аттестации
    const chain = ["d_need", "d_confirmed", "d_result", "d_attestation"];
    for (let i = 1; i < chain.length; i++) expect(layer[chain[i]], chain[i]).toBeGreaterThan(layer[chain[i - 1]]);
  });

  it("BPMN каждой операции строится и содержит все новые элементы", async () => {
    const m = c025Model();
    const xmls: Record<string, string> = {};
    for (const h of bpmnHosts(m)) {
      const { xml } = await generateBpmn(m, h.id);
      expect(new XMLParser({ ignoreAttributes: false }).parse(xml)["bpmn:definitions"], h.id).toBeTruthy();
      xmls[h.id] = xml;
    }
    expect(xmls.o11).toMatch(/<bpmn:boundaryEvent id="Node_o11_late"[^>]*attachedToRef="Node_o11_fill" cancelActivity="false"><bpmn:timerEventDefinition/);
    expect(xmls.o12).toMatch(/<bpmn:boundaryEvent id="Node_o12_late"[^>]*cancelActivity="true"/);
    expect(xmls.o11).toContain("<bpmn:businessRuleTask");
    expect(xmls.o13).toContain('<bpmn:participant id="Pool_p_center" name="Учебный центр" />');
    expect(xmls.o13).toContain('name="Заявка на обучение" sourceRef="Node_o13_send" targetRef="Pool_p_center"');
    expect(xmls.o13).toContain('sourceRef="Pool_p_center" targetRef="Node_o13_recv"');
    expect(xmls.o22).toContain("<bpmn:parallelGateway");
    expect(xmls.o22).toContain('<bpmn:dataStoreReference id="StoreRef_o22_file_s_zup" name="1С:ЗУП"');
    expect(xmls.o31).toContain("<bpmn:subProcess");
    // три дорожки у согласования: специалист, руководитель, директор
    const lanes = [...xmls.o12.matchAll(/<bpmn:lane id="[^"]+" name="([^"]+)"/g)].map((x) => x[1]);
    expect(lanes.sort()).toEqual(["Директор по персоналу и операционной эффективности", "Непосредственный руководитель сотрудника", "Специалист по обучению персонала"].sort());
    // две дорожки у сопровождения: специалист и сотрудник
    expect([...xmls.o21.matchAll(/<bpmn:lane id="[^"]+" name="([^"]+)"/g)].map((x) => x[1]).sort()).toEqual(["Специалист по обучению персонала", "Сотрудник (инициатор обучения)"].sort());
  }, 60_000);

  it("агент может предложить правку по этому процессу; реестр демонстрационных процессов", () => {
    const m = c025Model();
    const patched = applyPatch(m, { ops: [{ op: "update", collection: "nodes", id: "o11_fill", patch: { name: "Заполнить заявку на обучение в ELMA365" } }] });
    expect(patched.errors).toEqual([]);
    expect(Object.keys(REFERENCE_PROCESSES)).toEqual(["b002", "c025"]);
    expect(REFERENCE_PROCESSES.c025.build().process.code).toBe("C025.00.00");
  });
});

describe("C025 в приложении", () => {
  let app: Awaited<ReturnType<typeof startApp>>;
  beforeAll(async () => {
    app = await startApp();
  });
  afterAll(() => app.close());

  it("принимается приложением как есть; выгрузка BPMN по операциям и атлас", async () => {
    const s = (await app.call("POST", "/sessions/blank", { meta: { processName: "C025" } })).body;
    expect((await app.call("PUT", `/sessions/${s.id}/model`, c025Model())).status).toBe(200);
    const read = await app.call("GET", `/agent/sessions/${s.id}/model`);
    expect(read.body.issues).toEqual([]);
    expect(read.body.codes).toMatchObject({ s1: "C025.01.00", o13: "C025.01.03", o22: "C025.02.02", o31: "C025.03.01", o13_send: "C025.01.03/001", o13_recv: "C025.01.03/002" });
    const zip = await app.raw(`/sessions/${s.id}/export/bpmn.zip`);
    expect(zip.status).toBe(200);
    expect(Object.keys((await JSZip.loadAsync(zip.body)).files)).toHaveLength(6);
    // схема перехода статусов и паспорт процесса строятся из модели без ошибок
    expect((await app.call("GET", `/sessions/${s.id}/export/bpmn`)).status).toBe(200);
  }, 60_000);
});
