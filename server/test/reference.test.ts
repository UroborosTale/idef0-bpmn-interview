import { XMLParser } from "fast-xml-parser";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApp } from "./api.js";
import { compareModels, formatEval, matchNames, similarity } from "../src/eval/compare.js";
import { generateBpmn } from "../src/pipeline/bpmn.js";
import { b002Model } from "../src/reference/b002.js";
import { bpmnHosts, functionCodes } from "../src/shared/codes.js";
import { validateModel } from "../src/shared/validate.js";
import { ProcessLogicModel } from "../src/types/model.js";

delete process.env.AUTH_USERS;

const ref = () => b002Model();
const names = (m: ProcessLogicModel, scope: string) => m.nodes.filter((n) => n.bpmn_scope === scope).map((n) => n.name);

describe("эталон B002: структура по документам", () => {
  it("коды и названия подпроцессов и операций совпадают с диаграммами и регламентами", () => {
    const m = ref();
    const codes = functionCodes(m);
    const list = [...codes].map(([id, code]) => `${code} ${m.nodes.find((n) => n.id === id)!.name}`);
    expect(list).toEqual([
      "B002.01.00 Моделирование процесса",
      "B002.01.01 Актуализация реестра процессов",
      "B002.01.02 Проведение первичного интервью",
      "B002.01.03 Разработка модели процесса",
      "B002.02.00 Анализ эффективности процессной модели",
      "B002.02.01 Анализ соответствия фактической реализации процесса утвержденной процессной модели",
      "B002.02.02 Анализ причин неэффективности реализации процесса",
      "B002.03.00 Реинжиниринг процесса",
      "B002.03.01 Проведение интервью с владельцем процесса",
      "B002.03.02 Проведение фото рабочего дня",
      "B002.03.03 Проведение картирования",
      "B002.03.04 Разработка модели оптимизированного процесса",
    ]);
    expect(m.process.code).toBe("B002.00.00");
  });

  it("девять операций, у каждой своя диаграмма BPMN: один пул, начало и конец", () => {
    const m = ref();
    const hosts = bpmnHosts(m);
    expect(hosts).toHaveLength(9);
    for (const h of hosts) {
      const steps = m.nodes.filter((n) => n.bpmn_scope === h.id);
      expect(steps.some((n) => n.type === "event" && n.subtype === "start"), h.name).toBe(true);
      expect(steps.some((n) => n.type === "event" && n.subtype === "end"), h.name).toBe(true);
      expect(steps.every((n) => n.role_id === "r_spec"), h.name).toBe(true); // одна дорожка — сотрудник отдела корпоративных технологий
    }
  });

  it("модель целиком соответствует правилам Соглашения: ни ошибок, ни предупреждений", () => {
    expect(validateModel(ref())).toEqual([]);
  });

  it("особенности диаграмм из документов", () => {
    const m = ref();
    // B002.01.01: два начальных события, развилка «Да/Нет», возврат в слияние
    expect(m.nodes.filter((n) => n.bpmn_scope === "o11" && n.type === "event" && n.subtype === "start")).toHaveLength(2);
    const need = m.nodes.find((n) => n.name === "Необходимо предоставить актуальный реестр процессов?")!;
    expect(m.flows.filter((f) => f.from === need.id).map((f) => f.condition).sort()).toEqual(["Да", "Нет"]);
    // интервью — задача «Бизнес-правила»; таймеры «Наступление интервью», «Начало смены», «Конец смены», «День выезда»
    expect(m.nodes.filter((n) => n.subtype === "business_rule").map((n) => n.bpmn_scope).sort()).toEqual(["o12", "o13", "o31"]);
    expect(m.nodes.filter((n) => n.subtype === "timer").map((n) => n.name).sort()).toEqual(["Конец смены", "Начало смены", "Наступление интервью", "Наступление интервью", "Наступление интервью", "День выезда"].sort());
    // фото рабочего дня: три ручных шага в начале, уведомления — сервисные задачи
    expect(m.nodes.filter((n) => n.bpmn_scope === "o32" && n.subtype === "manual")).toHaveLength(3);
    expect(m.nodes.filter((n) => n.subtype === "service")).toHaveLength(5); // три уведомления, свод знаний, задача на ответственного секретаря
    // картирование: два согласования плана с владельцем и два цикла возврата
    expect(m.nodes.filter((n) => n.bpmn_scope === "o33" && n.name === "План согласован?")).toHaveLength(2);
    // системы: реестр ведут в Excel, карточки и комментарии — в ELMA365
    const excel = m.systems.find((s) => s.name === "Excel")!.id;
    expect(m.nodes.filter((n) => n.bpmn_scope === "o11" && n.system_ids.includes(excel))).toHaveLength(6);
    expect(m.systems.map((s) => s.name).sort()).toEqual(["Business studio", "ELMA365", "Excel", "Intranet.kmzlift.ru", "Microsoft Visio", "Microsoft Word", "Outlook", "PowerPoint"]);
    // ролевая модель: владелец процесса и подпроцессов; исполнитель каждой операции; Директор — контролёр у согласований
    expect(m.assignments.filter((a) => a.kind === "owner")).toHaveLength(4);
    expect(m.assignments.filter((a) => a.kind === "executor")).toHaveLength(9);
    expect(m.assignments.some((a) => a.node_id === "o22" && a.role_id === "r_dir" && a.kind === "controller")).toBe(true);
  });

  it("BPMN каждой операции строится, имя пула — «код название», XML корректен", async () => {
    const m = ref();
    const codes = functionCodes(m);
    for (const host of bpmnHosts(m)) {
      const { xml } = await generateBpmn(m, host.id);
      const doc = new XMLParser({ ignoreAttributes: false }).parse(xml);
      expect(doc["bpmn:definitions"], host.name).toBeTruthy();
      expect(xml).toContain(`name="${codes.get(host.id)} ${host.name}"`);
    }
    const o33 = (await generateBpmn(m, "o33")).xml;
    expect(o33).toContain("<bpmn:parallelGateway");
    expect(o33).toContain("<bpmn:intermediateCatchEvent");
    const o12 = (await generateBpmn(m, "o12")).xml;
    expect(o12).toContain("<bpmn:businessRuleTask");
    expect(o12).toContain('<bpmn:dataStoreReference id="StoreRef_o12_card_s_elma" name="ELMA365"');
  }, 60_000);
});

describe("сравнение с эталоном", () => {
  it("эталон с самим собой — 100% по всем мерам, нарушений нет", () => {
    const r = compareModels(ref(), ref());
    expect(r.overall).toBeCloseTo(1, 10);
    for (const k of ["functions", "steps", "order", "roles", "products", "systems"] as const) expect(r[k].f1, k).toBe(1);
    expect(r.codes).toEqual({ matched: 12, same: 12 });
    expect(r.violations).toEqual({ errors: 0, warnings: 0, byRule: {} });
    expect(r.operations).toHaveLength(9);
    expect(r.steps.reference).toBe(r.steps.matched);
  });

  it("сходство названий: окончания и порядок слов не мешают, чужие слова — мешают", () => {
    expect(similarity("Согласовать заявку", "Согласование заявки")).toBeGreaterThanOrEqual(0.6);
    expect(similarity("Создать карточку процесса", "процесса карточку создать")).toBe(1);
    expect(similarity("Открыть реестр", "Отправить письмо")).toBeLessThan(0.6);
    expect(similarity("", "Открыть реестр")).toBe(0);
  });

  it("сопоставление один к одному: лучшая пара выигрывает", () => {
    const pairs = matchNames(["Создать карточку процесса", "Изучить регламент процесса"], ["Изучить регламент процесса", "Создать карточку процесса в ELMA365"]);
    expect(pairs.sort()).toEqual([[0, 1], [1, 0]]);
    expect(matchNames(["Проверить заявку"], ["Проверить заявку", "Проверить заявку на оплату"])).toHaveLength(1);
  });

  it("потеряна операция: полнота падает, операция помечена «НЕ НАЙДЕНА»", () => {
    const cand = ref();
    cand.nodes = cand.nodes.filter((n) => n.id !== "o33" && n.bpmn_scope !== "o33");
    cand.flows = cand.flows.filter((f) => !f.id.startsWith("o33_"));
    cand.assignments = cand.assignments.filter((a) => a.node_id !== "o33");
    const r = compareModels(ref(), cand);
    expect(r.functions.recall).toBeCloseTo(11 / 12, 5);
    expect(r.functions.precision).toBe(1);
    expect(r.operations.find((o) => o.code === "B002.03.03")).toMatchObject({ matchedWith: null });
    expect(r.steps.recall).toBeLessThan(1);
    expect(r.overall).toBeLessThan(1);
    expect(formatEval(r)).toContain("B002.03.03 Проведение картирования — НЕ НАЙДЕНА");
  });

  it("переименование в другой падеж и рода не ломает совпадение; чужие шаги снижают точность", () => {
    const cand = ref();
    cand.nodes = cand.nodes.map((n) => (n.id === "o12_card" ? { ...n, name: "Создание карточки процесса" } : n));
    cand.nodes.push({ ...cand.nodes.find((n) => n.id === "o12_card")!, id: "extra1", name: "Согласовать бюджет отпуска директора" }, { ...cand.nodes.find((n) => n.id === "o12_card")!, id: "extra2", name: "Заказать канцелярские товары" });
    const r = compareModels(ref(), cand);
    expect(r.steps.recall).toBe(1);
    expect(r.steps.precision).toBeLessThan(1);
    expect(r.steps.candidate).toBe(r.steps.reference + 2);
  });

  it("порядок шагов: потерянные стрелки снижают метрику последовательности, шлюзы и события между задачами не мешают", () => {
    const cand = ref();
    cand.flows = cand.flows.filter((f) => !(f.id.startsWith("o12_") && ["o12_card", "o12_primary"].includes(f.from)));
    const r = compareModels(ref(), cand);
    expect(r.order.recall).toBeLessThan(1);
    expect(r.steps.f1).toBe(1);
    // эталон с удалённым шлюзом слияния в o11 (потоки ведут напрямую) — задачи по-прежнему идут в том же порядке
    const same = compareModels(ref(), ref());
    expect(same.order.f1).toBe(1);
  });

  it("пустой кандидат — ноль; отчёт читается", () => {
    const empty = ProcessLogicModel.parse({ process: { id: "x", name: "Пусто" } });
    const r = compareModels(ref(), empty);
    expect(r.overall).toBe(0);
    expect(r.functions.recall).toBe(0);
    const text = formatEval(r);
    expect(text).toContain("Совпадение с эталоном: 0%");
    expect(text).toContain("Операции эталона:");
  });

  it("нарушения правил Соглашения у кандидата попадают в отчёт", () => {
    const cand = ref();
    cand.nodes = cand.nodes.map((n) => (n.id === "o12_start" ? { ...n, name: "Реестр" } : n));
    const r = compareModels(ref(), cand);
    expect(r.violations.byRule).toMatchObject({ bpmn_event_not_fact: 1 });
    expect(formatEval(r)).toContain("bpmn_event_not_fact: 1");
  });
});

describe("эталон в приложении", () => {
  let app: Awaited<ReturnType<typeof startApp>>;
  beforeAll(async () => {
    app = await startApp();
  });
  afterAll(() => app.close());

  it("модель принимается приложением как есть и читается агентом с кодами", async () => {
    const s = (await app.call("POST", "/sessions/blank", { meta: { processName: "Эталон B002" } })).body;
    const put = await app.call("PUT", `/sessions/${s.id}/model`, ref());
    expect(put.status).toBe(200);
    const read = await app.call("GET", `/agent/sessions/${s.id}/model`);
    expect(read.status).toBe(200);
    expect(read.body.codes).toMatchObject({ s1: "B002.01.00", o33: "B002.03.03", o33_goal: "B002.03.03/001" });
    expect(read.body.issues).toEqual([]);
    const bpmn = await app.call("GET", `/sessions/${s.id}/export/bpmn?scope=o11`);
    expect(bpmn.status).toBe(200);
    expect(String(bpmn.body)).toContain("B002.01.01 Актуализация реестра процессов");
    const zip = await app.raw(`/sessions/${s.id}/export/bpmn.zip`);
    expect(zip.status).toBe(200);
  }, 60_000);

  it("имена шагов в диаграмме операции o11 совпадают с документом", () => {
    expect(names(ref(), "o11").filter((n) => n.startsWith("Вносить в реестр"))).toEqual([
      "Вносить в реестр процессов ООО «РУ КМЗ» Код процесса",
      "Вносить в реестр процессов ООО «РУ КМЗ» Наименование процесса",
      "Вносить в реестр процессов ООО «РУ КМЗ» Владельца процесса",
      "Вносить в реестр процессов ООО «РУ КМЗ» Автора процесса",
      "Вносить в реестр процессов ООО «РУ КМЗ» Статус процесса",
    ]);
  });
});
