import { ProcessLogicModel } from "../types/model.js";
import { validateModel } from "../shared/validate.js";
import { AND, BOUNDARY, END, EV, EVG, IF, MSG_CATCH, MSG_END, MSG_START, OR, SUB, START, T, XOR, buildDiagram, type Diagram, type Item } from "./builder.js";

/**
 * Демонстрационный процесс C090 «Закупка и ввод в эксплуатацию оборудования»: на нём показаны все возможности редактора.
 * Это не реальный процесс организации, а витрина — каждая операция показывает свою группу нововведений:
 *
 *  Структура и роли (Соглашение о моделировании)
 *   • коды C090.01.00 → C090.01.01; три подпроцесса, шесть операций, у каждой операции диаграмма BPMN; группа процессов в навигаторе;
 *   • ролевая модель: владелец процесса и подпроцессов, исполнитель операции, соисполнители, контролёры, наблюдатели;
 *   • продукты: внешние поставщики и потребители («Подразделение-заказчик», «Бухгалтерия»), ценность и стандарт качества;
 *   • ELMA-подобная роль «ERP» — дорожка автоматических действий и одновременно информационная система (хранилище данных).
 *  Задачи — все семь видов: пользовательская, сервисная, ручная, отправка, получение, скрипт, бизнес-правила; подпроцессы.
 *  Шлюзы — XOR (в том числе с возвратом на доработку), AND (параллельное согласование), OR, по событию.
 *  События и триггеры
 *   • C090.01.01 — три начала: обычное, по условию, по сигналу; граничный таймер без прерывания;
 *   • C090.01.02 — начало по сообщению, параллельное согласование, граничный таймер с прерыванием → эскалация → терминатор,
 *     конец с ошибкой, конец-сообщение;
 *   • C090.02.01 — шлюз по событию (сообщение или таймер), пара событий-ссылок, обмен сообщениями со свёрнутым пулом «Поставщики»;
 *   • C090.02.02 — включающий шлюз, свёрнутые подпроцессы, граничная ошибка, возврат на доработку, конец-сигнал, задача-получение;
 *   • C090.03.01 — начало по таймеру (период) и «несколько триггеров», эскалация, таймер по дате;
 *   • C090.03.02 — начало «несколько, все сразу», граничная компенсация, выбрасывание компенсации, конец с ошибкой,
 *     конец-сообщение во внешний процесс (пул с кодом).
 *  Принятое замечание: в C090.03.01 развилка «Поставка идёт по графику?» стоит сразу после события «Статус поставки
 *  получен», а не после задачи. Проверка сообщает об этом, но статус приходит от поставщика уже готовым («в срок» или
 *  «задержка»), отдельная оценка не нужна — замечание принято с причиной (accepted_issues).
 */

const ROLES: Record<string, { name: string; description?: string; qualification?: string }> = {
  erp: { name: "ERP «Закупки»", description: "Информационная система: автоматические действия и уведомления" },
  init: { name: "Инициатор закупки", description: "Сотрудник подразделения-заказчика", qualification: "Любой сотрудник подразделения" },
  head: { name: "Руководитель подразделения-заказчика", qualification: "Руководитель с правом согласования заявок" },
  fin: { name: "Финансовый директор", qualification: "Высшее экономическое образование, опыт от 5 лет" },
  buyer: { name: "Специалист по закупкам", qualification: "Опыт проведения закупочных процедур" },
  lawyer: { name: "Юрист", qualification: "Высшее юридическое образование" },
  logist: { name: "Логист", qualification: "Опыт организации поставок" },
  store: { name: "Кладовщик", qualification: "Допуск к приёмке материальных ценностей" },
  chief: { name: "Начальник отдела закупок", qualification: "Высшее образование, опыт руководства от 3 лет" },
  lchief: { name: "Руководитель службы логистики", qualification: "Высшее образование, опыт руководства от 3 лет" },
};

const SYSTEMS: Record<string, string> = { erp: "ERP «Закупки»", edo: "Система электронного документооборота" };

const CONTROLS: Record<string, { name: string; kind: "regulation" | "norm" | "rule"; description?: string }> = {
  policy: { name: "Положение о закупках", kind: "regulation" },
  budget: { name: "Бюджет закупок на год", kind: "norm" },
  tender: { name: "Регламент закупочных процедур", kind: "regulation" },
  template: { name: "Типовая форма договора поставки", kind: "norm" },
  delivSched: { name: "График поставки по договору", kind: "norm" },
  accept: { name: "Инструкция по приёмке оборудования", kind: "regulation" },
  // правила на диаграммах BPMN
  ruleComplete: { name: "Заявка полна, если заполнены наименование, количество, обоснование и срок", kind: "rule" },
  ruleBudget: { name: "Бюджет достаточен, если сумма заявки не превышает остаток по статье расходов", kind: "rule", description: "Остаток считается на дату согласования с учётом ранее согласованных заявок." },
};

interface Product {
  name: string;
  kind?: "document" | "data";
  supplier?: string;
  consumer?: string;
  value?: string;
  quality?: string;
}

const DATA: Record<string, Product> = {
  need: { name: "Потребность в оборудовании", kind: "data", supplier: "Подразделение-заказчик", value: "Основание для начала закупки", quality: "Описана номенклатура, количество и срок" },
  request: { name: "Заявка на закупку", value: "Единая форма заказа оборудования", quality: "Заполнены все обязательные поля" },
  approvedReq: { name: "Согласованная заявка на закупку", value: "Разрешение тратить бюджет", quality: "Есть подтверждение руководителя и финансового директора" },
  rejectedReq: { name: "Отклонённая заявка на закупку", consumer: "Подразделение-заказчик", value: "Объяснение причины отказа" },
  chosen: { name: "Выбранное коммерческое предложение", value: "Лучшее сочетание цены, срока и условий", quality: "Сравнение не менее трёх предложений либо обоснование их отсутствия" },
  contract: { name: "Договор поставки", value: "Обязательства поставщика", quality: "Подписан обеими сторонами" },
  arrived: { name: "Поставленное оборудование", kind: "data", value: "Оборудование на складе, готовое к приёмке" },
  act: { name: "Акт приёмки оборудования", consumer: "Бухгалтерия", value: "Основание для оплаты и учёта", quality: "Подписан кладовщиком и инициатором" },
  inUse: { name: "Оборудование в эксплуатации", kind: "data", consumer: "Подразделение-заказчик", value: "Потребность подразделения закрыта" },
};

type Kind = "owner" | "executor" | "coexecutor" | "controller" | "observer";

interface Fn {
  id: string;
  name: string;
  parent?: string;
  in: string[];
  controls: string[];
  out: string[];
  role?: string;
  roles: [role: string, kind: Kind][];
}

const FUNCTIONS: Fn[] = [
  { id: "s1", name: "Подготовка закупки", in: ["need"], controls: ["policy", "budget"], out: ["approvedReq", "rejectedReq"], roles: [["chief", "owner"], ["init", "coexecutor"], ["head", "coexecutor"], ["fin", "controller"]] },
  { id: "o11", parent: "s1", name: "Оформление заявки на закупку", in: ["need"], controls: ["policy"], out: ["request"], role: "init", roles: [["init", "executor"], ["erp", "coexecutor"], ["chief", "observer"]] },
  { id: "o12", parent: "s1", name: "Согласование заявки на закупку", in: ["request"], controls: ["policy", "budget"], out: ["approvedReq", "rejectedReq"], role: "head", roles: [["head", "executor"], ["fin", "coexecutor"], ["erp", "coexecutor"]] },
  { id: "s2", name: "Выбор поставщика", in: ["approvedReq"], controls: ["tender", "template"], out: ["contract"], roles: [["chief", "owner"], ["buyer", "coexecutor"], ["lawyer", "coexecutor"], ["fin", "controller"]] },
  { id: "o21", parent: "s2", name: "Проведение запроса предложений", in: ["approvedReq"], controls: ["tender"], out: ["chosen"], role: "buyer", roles: [["buyer", "executor"], ["erp", "coexecutor"]] },
  { id: "o22", parent: "s2", name: "Заключение договора поставки", in: ["chosen"], controls: ["template"], out: ["contract"], role: "buyer", roles: [["buyer", "executor"], ["lawyer", "coexecutor"], ["fin", "coexecutor"], ["erp", "coexecutor"]] },
  { id: "s3", name: "Поставка и приёмка", in: ["contract"], controls: ["delivSched", "accept"], out: ["act", "inUse"], roles: [["lchief", "owner"], ["logist", "coexecutor"], ["store", "coexecutor"], ["chief", "observer"]] },
  { id: "o31", parent: "s3", name: "Контроль поставки", in: ["contract"], controls: ["delivSched"], out: ["arrived"], role: "logist", roles: [["logist", "executor"], ["store", "coexecutor"], ["erp", "coexecutor"]] },
  { id: "o32", parent: "s3", name: "Приёмка и ввод в эксплуатацию", in: ["arrived"], controls: ["accept"], out: ["act", "inUse"], role: "store", roles: [["store", "executor"], ["init", "coexecutor"], ["erp", "coexecutor"]] },
];

const svc = { k: "service" as const, r: "erp" };
const at = (r: string) => ({ r });

/** C090.01.01 — три начала (обычное, по условию, по сигналу), слияние, возврат на доработку, граничный таймер без прерывания. */
const o11: Diagram = {
  op: "o11",
  role: "init",
  items: [
    START("start1", "Потребность в оборудовании выявлена"),
    EV("start2", "start", { type: "conditional", condition: "остаток на складе ниже минимального" }, "Остаток на складе опустился ниже минимального", "erp"),
    EV("start3", "start", { type: "signal", name: "Начало планового цикла закупок" }, "Плановый цикл закупок запущен", "chief"),
    XOR("m1"),
    T("fill", "Заполнить заявку на закупку", { in: ["need"], out: ["request"], sys: ["erp"], ctl: ["policy"] }),
    BOUNDARY("late", "fill", "timer", "Срок заполнения истёк", false, { timer: { kind: "duration", value: "P2D" } }),
    T("remind", "Напомнить инициатору о заявке", svc),
    END("endRemind", "Напоминание отправлено", "erp"),
    T("check", "Проверить комплектность заявки", { k: "business_rule", r: "erp", ctl: ["ruleComplete"] }),
    XOR("ok", "Заявка заполнена верно?", "erp"),
    T("send", "Отправить заявку на согласование", { k: "send" }),
    MSG_END("done", "Заявка направлена на согласование", "Заявка на закупку"),
  ],
  flows: [
    ["start1", "m1"],
    ["start2", "m1"],
    ["start3", "m1"],
    ["m1", "fill", "check", "ok"],
    IF("ok", "m1", "Нет"),
    IF("ok", "send", "Да"),
    ["send", "done"],
    ["late", "remind", "endRemind"],
  ],
};

/** C090.01.02 — начало по сообщению, параллельное согласование (AND), граничный таймер с прерыванием → эскалация → терминатор. */
const o12: Diagram = {
  op: "o12",
  role: "head",
  items: [
    MSG_START("start", "Заявка на закупку получена", "Заявка на закупку", "erp"),
    T("route", "Направить заявку на согласование", svc),
    AND("split", "Параллельное согласование", "erp"),
    T("byNeed", "Согласовать заявку по потребности", { in: ["request"], dur: "2 дня" }),
    BOUNDARY("overdue", "byNeed", "timer", "Срок согласования истёк", true, { timer: { kind: "duration", value: "P2D" } }),
    EV("esc", "intermediate", { type: "escalation", direction: "throw", name: "Просрочка согласования" }, "Просрочка согласования эскалирована", "head"),
    EV("stop", "end", { type: "terminate" }, "Согласование прекращено", "head"),
    T("budget", "Проверить наличие бюджета", { k: "business_rule", r: "fin", ctl: ["budget", "ruleBudget"] }),
    XOR("enough", "Бюджет достаточен?", "fin"),
    T("reject", "Зафиксировать отказ в заявке", { ...svc, out: ["rejectedReq"] }),
    EV("noBudget", "end", { type: "error", name: "BUDGET_EXCEEDED" }, "Заявка отклонена из-за нехватки бюджета", "fin"),
    AND("join", "Согласование завершено", "erp"),
    T("record", "Зафиксировать решение о согласовании", { ...svc, out: ["approvedReq"], sys: ["erp"] }),
    MSG_END("approved", "Заявка согласована", "Заявка согласована", "erp"),
  ],
  flows: [
    ["start", "route", "split"],
    ["split", "byNeed"],
    ["split", "budget", "enough"],
    IF("enough", "reject", "Нет"),
    ["reject", "noBudget"],
    IF("enough", "join", "Да"),
    ["byNeed", "join"],
    ["join", "record", "approved"],
    ["overdue", "esc", "stop"],
  ],
};

/** C090.02.01 — шлюз по событию, пара событий-ссылок, обмен сообщениями со свёрнутым пулом «Поставщики». */
const o21: Diagram = {
  op: "o21",
  role: "buyer",
  items: [
    START("start", "Заявка на закупку согласована"),
    EV("retry", "intermediate", { type: "link", direction: "catch", name: "Повторить запрос" }, "Рассылка запроса возобновлена"),
    XOR("m1"),
    T("send", "Разослать запрос предложений поставщикам", { k: "send", sys: ["edo"], ctl: ["tender"], in: ["approvedReq"] }),
    EVG("wait", "Что наступит раньше?"),
    MSG_CATCH("got", "Предложения получены", "Предложение поставщика"),
    EV("timeout", "intermediate", { type: "timer", direction: "catch", timer: { kind: "duration", value: "P5D" } }, "Срок приёма предложений истёк"),
    T("compare", "Сравнить предложения и выбрать победителя", { out: ["chosen"], ctl: ["tender"] }),
    END("end", "Поставщик выбран"),
    T("noOffers", "Зафиксировать отсутствие предложений", svc),
    XOR("again", "Повторить запрос?"),
    EV("jump", "intermediate", { type: "link", direction: "throw", name: "Повторить запрос" }, "Повторный запрос инициирован"),
    EV("cancel", "end", { type: "terminate" }, "Закупка прекращена"),
  ],
  flows: [
    ["start", "m1"],
    ["retry", "m1"],
    ["m1", "send", "wait"],
    ["wait", "got"],
    ["wait", "timeout"],
    ["got", "compare", "end"],
    ["timeout", "noOffers", "again"],
    IF("again", "jump", "Да"),
    IF("again", "cancel", "Нет"),
  ],
  messages: [
    { from: "send", to: "p_suppl", name: "Запрос предложений" },
    { from: "p_suppl", to: "got", name: "Предложение" },
  ],
};

/** C090.02.02 — включающий шлюз, свёрнутые подпроцессы, граничная ошибка с возвратом на доработку, задача-получение, конец-сигнал. */
const o22: Diagram = {
  op: "o22",
  role: "buyer",
  items: [
    START("start", "Поставщик выбран"),
    XOR("m0"),
    T("draft", "Подготовить проект договора поставки", { in: ["chosen"], ctl: ["template"], sys: ["edo"] }),
    T("calc", "Рассчитать сумму договора", { k: "script", r: "erp" }),
    OR("split", "Какие проверки нужны?", "erp"),
    SUB("legal", "Проведение юридической экспертизы договора", "lawyer"),
    SUB("finance", "Проведение финансовой проверки договора", "fin"),
    BOUNDARY("violation", "legal", "error", "Нарушение выявлено", true, { name: "LEGAL_VIOLATION" }),
    T("rework", "Вернуть проект договора на доработку", at("buyer")),
    OR("join", "Проверки завершены", "buyer"),
    T("sign", "Подписать договор поставки", { out: ["contract"], dur: "3 дня" }),
    T("signedBack", "Получить договор, подписанный поставщиком", { k: "receive" }),
    EV("end", "end", { type: "signal", name: "Договор заключён" }, "Договор заключён"),
  ],
  flows: [
    ["start", "m0", "draft", "calc", "split"],
    IF("split", "legal", "Есть нестандартные условия"),
    IF("split", "finance", "Сумма договора свыше 1 млн руб."),
    ["legal", "join"],
    ["finance", "join"],
    ["join", "sign", "signedBack", "end"],
    ["violation", "rework", "m0"],
  ],
  messages: [{ from: "p_suppl", to: "signedBack", name: "Подписанный договор" }],
};

/** C090.03.01 — начало по таймеру (период) и «несколько триггеров», эскалация, таймер по дате. */
const o31: Diagram = {
  op: "o31",
  role: "logist",
  items: [
    EV("start1", "start", { type: "timer", timer: { kind: "cycle", value: "R/P1W" } }, "Наступил срок еженедельной проверки", "erp"),
    EV("start2", "start", { type: "multiple", members: ["message", "signal"] }, "Обращение по поставке получено"),
    XOR("m0"),
    T("ask", "Запросить у поставщика статус поставки", { k: "send", in: ["contract"], ctl: ["delivSched"] }),
    MSG_CATCH("status", "Статус поставки получен", "Статус поставки"),
    XOR("onTime", "Поставка идёт по графику?"),
    EV("esc", "intermediate", { type: "escalation", direction: "throw", name: "Задержка поставки" }, "Задержка поставки эскалирована"),
    T("replan", "Согласовать новый срок поставки"),
    XOR("m1"),
    EV("date", "intermediate", { type: "timer", direction: "catch", timer: { kind: "date", value: "срок поставки по договору" } }, "Наступила дата поставки"),
    T("receive", "Принять поставку на склад", { k: "manual", r: "store", out: ["arrived"] }),
    END("end", "Поставка принята на склад", "store"),
  ],
  flows: [
    ["start1", "m0"],
    ["start2", "m0"],
    ["m0", "ask", "status", "onTime"],
    IF("onTime", "m1", "Да"),
    IF("onTime", "esc", "Нет"),
    ["esc", "replan", "m1"],
    ["m1", "date", "receive", "end"],
  ],
  messages: [
    { from: "ask", to: "p_suppl", name: "Запрос статуса" },
    { from: "p_suppl", to: "status", name: "Статус" },
  ],
};

/** C090.03.02 — «несколько, все сразу», граничная компенсация, выбрасывание компенсации, конец с ошибкой, конец-сообщение в другой процесс. */
const o32: Diagram = {
  op: "o32",
  role: "store",
  items: [
    EV("start", "start", { type: "parallel_multiple", members: ["message", "signal"] }, "Поставка прибыла и приёмка подготовлена"),
    T("count", "Проверить комплектность поставки", { k: "manual", in: ["arrived"] }),
    T("pay", "Оплатить поставку", { ...svc, sys: ["erp"] }),
    BOUNDARY("undo", "pay", "compensation", "Оплата подлежит отмене", false),
    T("refund", "Вернуть оплату", svc),
    END("refunded", "Оплата возвращена", "erp"),
    T("quality", "Проверить качество оборудования", { ...at("init"), ctl: ["accept"] }),
    XOR("okq", "Оборудование принято?", "init"),
    EV("cancel", "intermediate", { type: "compensation", direction: "throw" }, "Покупка отменена", "init"),
    EV("failed", "end", { type: "error", name: "ACCEPTANCE_FAILED" }, "Приёмка не пройдена", "init"),
    T("act", "Подписать акт приёмки", { out: ["act"] }),
    T("register", "Поставить оборудование на учёт", { ...svc, out: ["inUse"], sys: ["erp"] }),
    MSG_END("end", "Оборудование введено в эксплуатацию", "Уведомление о вводе в эксплуатацию", "erp"),
  ],
  flows: [
    ["start", "count", "pay", "quality", "okq"],
    IF("okq", "act", "Да"),
    IF("okq", "cancel", "Нет"),
    ["cancel", "failed"],
    ["act", "register", "end"],
    ["undo", "refund", "refunded"],
  ],
  messages: [{ from: "end", to: "p_acc", name: "Ввод в эксплуатацию" }],
};

const DIAGRAMS: Diagram[] = [o11, o12, o21, o22, o31, o32];

export function demoModel(): ProcessLogicModel {
  const id = {
    role: (k: string) => `r_${k}`,
    data: (k: string) => `d_${k}`,
    system: (k: string) => `s_${k}`,
    control: (k: string) => `c_${k}`,
    status: "confirmed" as const,
  };

  const nodes: Record<string, unknown>[] = [];
  const flows: Record<string, unknown>[] = [];
  const messages: Record<string, unknown>[] = [];

  for (const f of FUNCTIONS) {
    nodes.push({
      id: f.id,
      type: "task",
      name: f.name,
      idef0_parent: f.parent ?? null,
      role_id: f.role ? id.role(f.role) : null,
      inputs: f.in.map(id.data),
      outputs: f.out.map(id.data),
      controls: f.controls.map(id.control),
      system_ids: [id.system("erp")],
      status: "confirmed",
      confidence: 1,
    });
  }
  for (const d of DIAGRAMS) {
    const built = buildDiagram(d, id);
    nodes.push(...built.nodes);
    flows.push(...built.flows);
    messages.push(...built.messages);
  }

  const assignments: Record<string, unknown>[] = [{ node_id: null, role_id: id.role("chief"), kind: "owner", functions: [] }];
  for (const f of FUNCTIONS) for (const [role, kind] of f.roles) assignments.push({ node_id: f.id, role_id: id.role(role), kind, functions: [] });

  const model = ProcessLogicModel.parse({
    process: {
      id: "demo",
      name: "Закупка и ввод в эксплуатацию оборудования",
      code: "C090.00.00",
      group: "Демонстрационные процессы",
      department: "Отдел закупок",
      goal: "Обеспечить подразделения оборудованием в срок и в рамках бюджета",
      trigger: "Выявлена потребность в оборудовании",
      result: "Оборудование принято и введено в эксплуатацию",
      type: "AS-IS",
      status: "draft",
    },
    roles: Object.entries(ROLES).map(([k, r]) => ({ id: id.role(k), name: r.name, description: r.description ?? null, qualification: r.qualification ?? null })),
    systems: Object.entries(SYSTEMS).map(([k, name]) => ({ id: id.system(k), name })),
    controls: Object.entries(CONTROLS).map(([k, c]) => ({ id: id.control(k), name: c.name, kind: c.kind, description: c.description ?? null })),
    data: Object.entries(DATA).map(([k, p]) => ({ id: id.data(k), name: p.name, kind: p.kind ?? "document", supplier: p.supplier ?? null, consumer: p.consumer ?? null, value: p.value ?? null, quality_standard: p.quality ?? null })),
    nodes,
    flows,
    pools: [
      { id: "p_suppl", name: "Поставщики", code: null },
      { id: "p_acc", name: "Учёт основных средств", code: "C025.02.02" },
    ],
    messages,
    assignments,
  });

  // осознанное отступление от правила принимается с причиной — так в студии выглядит «принято»
  const accepted = validateModel(model).filter((i) => i.rule === "bpmn_xor_after_task" && i.element_id === "o31_onTime");
  model.accepted_issues = accepted.map((i) => ({
    rule: i.rule,
    element_id: i.element_id,
    message: i.message,
    reason: "Статус поставки приходит от поставщика уже готовым («в срок» или «задержка»): отдельная задача оценки не нужна",
    at: "2026-10-08T09:00:00.000Z",
  }));
  return model;
}

export type { Item };
