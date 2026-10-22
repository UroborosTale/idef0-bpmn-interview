import { ProcessLogicModel } from "../types/model.js";
import { END, IF, MSG_CATCH, MSG_START, START, T, TIMER, XOR, buildDiagram, type Diagram, type Item } from "./builder.js";

/**
 * Процесс C025 «Организация обучения и аттестации персонала ООО «РУ КМЗ»» — по документу «ДПО от 05.10»:
 * контекстная диаграмма A-0, A0 (два подпроцесса), A4 — декомпозиция C025.01.00, BPMN пяти операций
 * (C025.01.01, C025.01.02, C025.01.03, C025.02.01, C025.02.02). Диаграммы A3 (декомпозиция C025.02.00) в документе нет:
 * входы, выходы и управление операций C025.02.01 и C025.02.02 выведены из A0 и их BPMN.
 *
 * Отступления от документа (чтобы модель записывалась по Соглашению о моделировании):
 *  • события-существительные названы фактами: «Необходимость в повышении квалификации выявлена», «Поручение руководства
 *    получено», «Уведомление о необходимости согласования заявки получено», «Согласованная заявка» → «Заявка на обучение
 *    согласована»; конечное событие-письмо — «Сотруднику направлено уведомление о его отчислении»;
 *  • начальное событие-сообщение операции C025.02.01 — обычное начальное событие (тип сообщения в модели у начальных
 *    событий не хранится);
 *  • задача «Заявка отправлена на дополнительную проработку» названа действием: «Отправить заявку на дополнительную проработку»;
 *  • сроки согласования («1 день») и загрузки документа («2 рабочих дня») записаны в срок шага, а не граничным таймером без
 *    продолжения; шлюзы с одним входом и выходом (после начала в C025.02.01) опущены;
 *  • ELMA365 — дорожка автоматических действий (роль) и одновременно информационная система-механизм функций; два
 *    одноимённых свёрнутых пула «Поиск программы и внесение в список» в C025.01.03 объединены в один;
 *  • «Директор дирекции по операционной эффективности» (BPMN) и «Директор дирекции операционной эффективности» (IDEF0) —
 *    одна должность; примечания на диаграммах — правила-регламенты, привязанные к шагам.
 *
 * Чего в документе нет и что поэтому не заполнено (проверки Соглашения об этом сообщают): владелец процесса и подпроцессов,
 * внешние поставщики входов и потребители выходов, выход «Уведомление о невозможности исполнения заявки» на A0.
 */

const ROLES: Record<string, { name: string; description?: string }> = {
  elma: { name: "ELMA365", description: "Информационная система: автоматические действия и уведомления" },
  initiator: { name: "Инициатор заявки на обучение" },
  mgr: { name: "Руководитель инициатора заявки на обучение" },
  dird: { name: "Директор дирекции операционной эффективности" },
  dirhr: { name: "Директор по персоналу и операционной эффективности" },
  emp: { name: "Сотрудник прошедший обучение" },
  spec: { name: "Специалист отдела обучения и развития персонала" },
};

const SYSTEMS: Record<string, string> = { elma: "ELMA365" };

const CONTROLS: Record<string, { name: string; kind: "regulation" | "norm" | "rule"; description?: string }> = {
  law273: { name: "Федеральный закон от 29.12.2012 № 273-ФЗ «Об образовании в Российской Федерации»", kind: "regulation" },
  order266: { name: "Приказ Минобрнауки России от 24.03.2025 № 266", kind: "regulation" },
  tk187: { name: "Трудовой кодекс РФ ст.187", kind: "regulation" },
  tk196: { name: "Трудовой кодекс РФ ст.196", kind: "regulation" },
  list: { name: "Список направлений обучения", kind: "norm" },
  // примечания на диаграммах BPMN
  ruleList: { name: "Список формируется исходя из нынешних компетенций сотрудника и должности", kind: "rule" },
  ruleFields: {
    name: "Список необходимых полей для заполнения",
    kind: "rule",
    description: "1. Заголовок (обязательное, строка). 2. Краткое описание обучения (обязательное, строка). 3. Необходимость обучения (обязательное, список выбора – задача, проблема, проект). 4. Тема обучения (обязательное, строка). 5. Результат обучения (обязательное, строка). 6. Комментарий (обязательное, строка).",
  },
  ruleApproval: {
    name: "Согласование не требуется при выполнении обоих условий",
    kind: "rule",
    description: "1. Программа обучения первая за год у сотрудника. 2. Стоимость программы обучения менее 15000 рублей.",
  },
  ruleReminder: { name: "Напоминание об обучении приходит за 1 день до и в день занятия", kind: "rule" },
};

const DATA: Record<string, string> = {
  need: "Сотрудник нуждающийся в обучении",
  mandate: "Поручение руководства",
  dismissal: "Уведомление об отчислении сотрудника от образовательной организации",
  formed: "Сформированная заявка на обучение",
  returned: "Заявка возвращена на доработку",
  approved: "Согласованная заявка на обучение",
  unapproved: "Несогласованная заявка на обучение",
  confirmed: "Подтверждённая заявка на обучение",
  impossible: "Уведомление о невозможности исполнения заявки",
  trained: "Обученный сотрудник",
  eduSection: "Актуализированный раздел об образовании в карточке сотрудника",
  dismissed: "Уведомление сотруднику о его отчислении",
};

type Kind = "owner" | "executor" | "coexecutor" | "controller" | "observer";

interface Fn {
  id: string;
  name: string;
  parent?: string;
  in: string[];
  controls: string[];
  out: string[];
  /** Исполнитель операции (дорожка по умолчанию) и роли-механизмы. */
  role?: string;
  roles: [role: string, kind: Kind][];
  /** Номер блока IDEF0, как в Business Studio (A4, A3 — порядок создания в BS отличается от порядка на диаграмме). */
  idef0_number?: string;
  /** Помеченные концы ICOM-стрелок: «open» — полый наконечник (выход без потребителя, I7). */
  tunnels?: Record<string, { up?: boolean; down?: boolean; upKind?: "tunnel" | "boundary" | "offpage" | "open"; downKind?: "tunnel" | "boundary" | "offpage" | "open" }>;
}

// Порядок как в документе: A0 → A4 (C025.01.00 и её операции) → операции C025.02.00
const FUNCTIONS: Fn[] = [
  { id: "s1", name: "Оформление заявки на обучение сотрудника", in: ["need", "mandate"], controls: ["order266", "tk196", "list"], out: ["confirmed"], roles: [["initiator", "coexecutor"], ["spec", "coexecutor"], ["mgr", "controller"], ["dird", "controller"], ["dirhr", "controller"]], idef0_number: "A4" },
  { id: "o11", parent: "s1", name: "Формирование заявки на обучение", in: ["need", "mandate", "returned"], controls: ["order266", "list"], out: ["formed"], role: "initiator", roles: [["initiator", "executor"], ["elma", "coexecutor"]] },
  { id: "o12", parent: "s1", name: "Согласование заявки на обучение", in: ["formed"], controls: ["tk196"], out: ["returned", "unapproved", "approved"], role: "mgr", roles: [["mgr", "executor"], ["dird", "coexecutor"], ["dirhr", "coexecutor"], ["elma", "coexecutor"]], tunnels: { "output:unapproved": { upKind: "open" } } },
  { id: "o13", parent: "s1", name: "Подтверждение программы обучения", in: ["approved"], controls: [], out: ["impossible", "confirmed"], role: "spec", roles: [["spec", "executor"], ["elma", "coexecutor"]], tunnels: { "output:impossible": { upKind: "open" } } },
  { id: "s2", name: "Проведение обучения", in: ["confirmed", "dismissal"], controls: ["law273", "tk187", "order266"], out: ["trained", "eduSection", "dismissed"], roles: [["emp", "coexecutor"], ["spec", "coexecutor"], ["mgr", "controller"], ["dird", "controller"], ["dirhr", "controller"]], idef0_number: "A3" },
  { id: "o21", parent: "s2", name: "Сопровождение обучения сотрудника", in: ["confirmed", "dismissal"], controls: ["law273", "tk187", "order266"], out: ["trained", "dismissed"], role: "spec", roles: [["spec", "executor"], ["elma", "coexecutor"]] },
  { id: "o22", parent: "s2", name: "Учет результата обучения", in: ["trained"], controls: ["tk187"], out: ["eduSection"], role: "spec", roles: [["spec", "executor"], ["emp", "coexecutor"], ["elma", "coexecutor"]] },
];

const svc = { k: "service" as const, r: "elma" };
const at = (r: string) => ({ r });

const o11: Diagram = {
  op: "o11",
  role: "initiator",
  items: [
    START("start1", "Необходимость в повышении квалификации выявлена"),
    START("start2", "Поручение руководства получено"),
    XOR("m1"),
    T("enter", "Зайти в раздел “Заявки на обучение”"),
    T("create", "Нажать кнопку “Создать заявку”"),
    XOR("many", "Направленных сотрудников на обучение >1?"),
    T("all", "Указать всех сотрудников направленных на обучение"),
    XOR("m2"),
    T("list", "Выдать список подходящих направлений", { ...svc, ctl: ["ruleList"] }),
    XOR("chosen", "Программа обучения выбрана?"),
    T("continue", "Нажать “Продолжить создание заявки”"),
    T("write", "Написать в поле “Напишите вашу желаемую программу обучения”"),
    T("fill", "Заполнить обязательные поля", { ctl: ["ruleFields"] }),
    XOR("m3"),
    T("approver", "Заполнить первое согласующее лицо – руководителя инициатора заявки", svc),
    T("send", "Нажать кнопку “Отправить на согласование”"),
    XOR("fromList", "Программа выбрана из списка?"),
    END("end1", "Программа выбрана из списка"),
    END("end2", "Программа предложена сотрудником"),
  ],
  flows: [
    ["start1", "m1"],
    ["start2", "m1"],
    ["m1", "enter", "create", "many"],
    IF("many", "all", "Да"),
    ["all", "m2"],
    IF("many", "m2", "Нет"),
    ["m2", "list", "chosen"],
    IF("chosen", "continue", "Да"),
    ["continue", "m3"],
    IF("chosen", "write", "Нет"),
    ["write", "fill", "m3"],
    ["m3", "approver", "send", "fromList"],
    IF("fromList", "end1", "Да"),
    IF("fromList", "end2", "Нет"),
  ],
};

/** Три согласования подряд устроены одинаково: уведомление → карточка → решение (срок 1 день) → «Согласовано?». */
const approval = (n: number, role: string, createName: string, msgName: string): Item[] => [
  T(`c${n}`, createName, svc),
  MSG_CATCH(`msg${n}`, msgName, "Уведомление о необходимости согласования заявки", role),
  T(`open${n}`, "Открыть карточку согласования заявки", at(role)),
  T(`dec${n}`, "Принять решение о согласовании", { ...at(role), dur: "1 день" }),
  XOR(`ok${n}`, "Согласовано?", "elma"),
  T(`rew${n}`, "Создать заявку на доработку заявки", svc),
  END(`endRew${n}`, "Заявка отправлена на доработку", "elma"),
];

const o12: Diagram = {
  op: "o12",
  role: "elma",
  items: [
    START("start1", "Программа обучения и организация подобраны из списка"),
    START("start2", "Инициатор предложил свой вариант программы"),
    XOR("m1"),
    T("need", "Определить необходимость согласования", { ...svc, ctl: ["ruleApproval"] }),
    XOR("req", "Требуется согласование?"),
    END("skip", "Заявка согласована"),
    ...approval(1, "mgr", "Создать задачу на согласование руководителю инициатора заявки", "Уведомление о необходимости согласования заявки получено"),
    ...approval(2, "dird", "Создать задачу на согласование директору дирекции по операционной эффективности", "Уведомление о необходимости согласования заявки получено"),
    ...approval(3, "dirhr", "Создать задачу на согласование директору по персоналу и операционной эффективности", "Копия уведомления о необходимости согласования заявки получена"),
    END("end", "Заявка согласована"),
  ],
  flows: [
    ["start1", "m1"],
    ["start2", "m1"],
    ["m1", "need", "req"],
    IF("req", "skip", "Нет"),
    IF("req", "c1", "Да"),
    ["c1", "msg1", "open1", "dec1", "ok1"],
    IF("ok1", "rew1", "Нет"),
    ["rew1", "endRew1"],
    IF("ok1", "c2", "Да"),
    ["c2", "msg2", "open2", "dec2", "ok2"],
    IF("ok2", "rew2", "Нет"),
    ["rew2", "endRew2"],
    IF("ok2", "c3", "Да"),
    ["c3", "msg3", "open3", "dec3", "ok3"],
    IF("ok3", "rew3", "Нет"),
    ["rew3", "endRew3"],
    IF("ok3", "end", "Да"),
  ],
};

const o13: Diagram = {
  op: "o13",
  role: "elma",
  items: [
    START("start", "Заявка на обучение согласована"),
    T("task", "Создать задачу специалисту на проверку направления", svc),
    T("assign", "Назначить специалиста на задачу", svc),
    XOR("m1", "Слияние потоков", "spec"),
    T("open", "Открыть задачу и изучить контекст заявки", at("spec")),
    T("pick", "Выбрать программу обучения из списка под целевой результат", at("spec")),
    XOR("found", "Удалось подобрать программу обучения?", "spec"),
    XOR("contract", "Договор с учебной организацией заключен?", "spec"),
    T("confirm", "Подтвердить программу обучения и организацию", at("spec")),
    T("notify", "Отправить уведомление сотруднику о подтверждении заявки", svc),
    END("endOk", "Заявка на обучение подтверждена"),
    T("search", "Поиск программы во внешнем контуре", at("spec")),
    XOR("tender", "Возможно провести тендерную процедуру?", "spec"),
    T("docs", "Подготовка документов для проведения тендерной закупки", at("spec")),
    T("buy", "Проведение тендерной закупки", at("spec")),
    END("endBuy", "Необходимая программа обучения куплена, заявка подтверждена", "spec"),
    T("fail", "Нажать кнопку “Не удалось подобрать направление”", at("spec")),
    T("again", "Отправить заявку на дополнительную проработку", svc),
  ],
  flows: [
    ["start", "task", "assign", "m1", "open", "pick", "found"],
    IF("found", "contract", "Да"),
    IF("found", "search", "Нет"),
    ["search", "tender"],
    IF("contract", "confirm", "Да"),
    IF("contract", "tender", "Нет"),
    ["confirm", "notify", "endOk"],
    IF("tender", "docs", "Да"),
    ["docs", "buy", "endBuy"],
    IF("tender", "fail", "Нет"),
    ["fail", "again", "m1"],
  ],
  // свёрнутый пул «Поиск программы и внесение в список»: обмен с ним у поиска и у тендерной закупки
  messages: [
    { from: "search", to: "p_search" },
    { from: "p_search", to: "search" },
    { from: "buy", to: "p_search" },
    { from: "p_search", to: "buy" },
  ],
};

const o21: Diagram = {
  op: "o21",
  role: "spec",
  items: [
    START("start", "Программа обучения и организации подтверждены", "elma"),
    T("calendar", "Создать событие в календаре за 1 день до начала обучения и направить уведомление сотруднику о начале обучения", { ...svc, ctl: ["ruleReminder"] }),
    TIMER("begin", "Дата начала обучения", "elma", { kind: "date", value: "Дата начала обучения из заявки" }),
    T("auto", "Автоматическое подтверждение начала обучения и установка статуса “Обучение идёт”", svc),
    XOR("m2"),
    TIMER("finish", "Дата окончания обучения", undefined, { kind: "date", value: "Дата окончания обучения из заявки" }),
    T("ask", "Запросить у организации сведения о прохождении обучения"),
    T("check", "Проверить прохождение обучения"),
    XOR("done", "Сотрудник закончил обучение?"),
    END("endDone", "Сотрудник закончил обучение"),
    XOR("extended", "Обучение было продлено?"),
    MSG_START("dismissalStart", "Уведомление об отчислении сотрудника от образовательной организации получено", "Уведомление об отчислении"),
    XOR("m3", "Слияние потоков", "elma"),
    T("notify", "Направить уведомление об отчислении сотруднику", svc),
    T("close", "Внести запись “Обучение не завершено”, статус заявки ”Закрыта”", svc),
    END("endDismissed", "Сотруднику направлено уведомление о его отчислении", "elma"),
  ],
  flows: [
    ["start", "calendar", "begin", "auto", "m2", "finish", "ask", "check", "done"],
    IF("done", "endDone", "Да"),
    IF("done", "extended", "Нет"),
    IF("extended", "m2", "Да"),
    IF("extended", "m3", "Нет"),
    ["dismissalStart", "m3"],
    ["m3", "notify", "close", "endDismissed"],
  ],
};

const o22: Diagram = {
  op: "o22",
  role: "elma",
  items: [
    START("start", "Обучение завершено"),
    XOR("m1"),
    T("remind", "Автоматическое ежедневное напоминание о прикреплении корректного документа", svc),
    T("create", "Создать задачу сотруднику на загрузку документа в КЭДО", svc),
    T("open", "Открыть задачу", at("emp")),
    T("attach", "Прикрепить документ об окончании обучения и заполнить реквизиты документа об окончании", { ...at("emp"), dur: "2 рабочих дня" }),
    XOR("inTime", "Документ загружен в срок?", "emp"),
    T("taskSpec", "Создать задачу специалисту на проверку документа", svc),
    T("verify", "Открыть задачу, проверить документ и реквизиты", at("spec")),
    XOR("correct", "Документ корректный?"),
    T("update", "Актуализировать раздел об обучении сотрудника", svc),
    END("end", "Раздел об образовании актуализирован"),
  ],
  flows: [
    ["start", "m1", "remind", "create", "open", "attach", "inTime"],
    IF("inTime", "m1", "Нет"),
    IF("inTime", "taskSpec", "Да"),
    ["taskSpec", "verify", "correct"],
    IF("correct", "m1", "Нет"),
    IF("correct", "update", "Да"),
    ["update", "end"],
  ],
};

const DIAGRAMS: Diagram[] = [o11, o12, o13, o21, o22];

export function c025Model(): ProcessLogicModel {
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
      system_ids: [id.system("elma")], // ELMA365 — механизм на всех диаграммах IDEF0
      status: "confirmed",
      confidence: 1,
      ...(f.idef0_number ? { idef0_number: f.idef0_number } : {}),
      ...(f.tunnels ? { tunnels: f.tunnels } : {}),
    });
  }
  for (const d of DIAGRAMS) {
    const built = buildDiagram(d, id);
    nodes.push(...built.nodes);
    flows.push(...built.flows);
    messages.push(...built.messages);
  }

  const assignments: Record<string, unknown>[] = [];
  for (const f of FUNCTIONS) for (const [role, kind] of f.roles) assignments.push({ node_id: f.id, role_id: id.role(role), kind, functions: [] });

  return ProcessLogicModel.parse({
    process: {
      id: "c025",
      name: "Организация обучения и аттестации персонала ООО «РУ КМЗ»",
      code: "C025.00.00",
      group: "Организация дополнительного профессионального обучения персонала ООО «РУ КМЗ»",
      type: "AS-IS",
      status: "draft",
    },
    roles: Object.entries(ROLES).map(([k, r]) => ({ id: id.role(k), name: r.name, description: r.description ?? null })),
    systems: Object.entries(SYSTEMS).map(([k, name]) => ({ id: id.system(k), name })),
    controls: Object.entries(CONTROLS).map(([k, c]) => ({ id: id.control(k), name: c.name, kind: c.kind, description: c.description ?? null })),
    data: Object.entries(DATA).map(([k, name]) => ({ id: id.data(k), name, kind: "data" })),
    nodes,
    flows,
    pools: [{ id: "p_search", name: "Поиск программы и внесение в список", code: null }],
    messages,
    assignments,
  });
}
