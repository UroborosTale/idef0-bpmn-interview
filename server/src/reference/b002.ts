import { ProcessLogicModel } from "../types/model.js";

/**
 * Эталонная модель процесса B002 «Управление процессами ООО «РУ КМЗ»» — по IDEF0 (уровни 0 и 1) и BPMN девяти операций
 * из документов организации (УП РУ КМЗ, 23.09). Нужна для проверки агентов и документов: что бы ни сгенерировали, результат
 * можно сравнить с утверждённой моделью (eval/compare.ts) и открыть в студии рядом с диаграммами Visio.
 *
 * Отступления от исходных диаграмм (все — осознанные, чтобы эталон сам соответствовал Соглашению о моделировании):
 *  • код процесса B002 везде: в диаграммах IDEF0 он напечатан как C037, в BPMN, регламентах и инструкциях — B002;
 *  • стартовые события операции B002.01.01 названы фактами («Информация о вновь выявленном процессе получена»,
 *    «Пункт протокола совещания получен») вместо существительных на диаграмме;
 *  • «Обновленный реестр процессов» (BPMN) и «Актуальный реестр процессов» (IDEF0) — один продукт «Актуальный реестр…»;
 *  • «Чек-лист для интервью» (BPMN) и «Чек-лист интервью» (IDEF0) — один документ «Чек-лист интервью», он управляет
 *    интервью (в IDEF0 стоит механизмом, но это документ, а не ресурс);
 *  • владельцем процесса и подпроцессов назначен начальник отдела корпоративных технологий; внешние поставщики и потребители
 *    продуктов верхнего уровня — предположения (в документах не названы).
 */

interface StepOpts {
  /** Вид задачи BPMN: по умолчанию пользовательская. */
  k?: "user" | "manual" | "service" | "send" | "receive" | "business_rule";
  in?: string[];
  out?: string[];
  sys?: string[];
}

type Item =
  | ({ kind: "task"; key: string; name: string } & StepOpts)
  | { kind: "sub"; key: string; name: string } // свёрнутый подпроцесс (согласование)
  | { kind: "event"; key: string; k: "start" | "end" | "timer"; name: string }
  | { kind: "gw"; key: string; k: "exclusive" | "parallel"; name: string };

const T = (key: string, name: string, o: StepOpts = {}): Item => ({ kind: "task", key, name, ...o });
const SUB = (key: string, name: string): Item => ({ kind: "sub", key, name });
const START = (key: string, name: string): Item => ({ kind: "event", key, k: "start", name });
const END = (key: string, name: string): Item => ({ kind: "event", key, k: "end", name });
const TIMER = (key: string, name: string): Item => ({ kind: "event", key, k: "timer", name });
const XOR = (key: string, name = "Слияние потоков"): Item => ({ kind: "gw", key, k: "exclusive", name });
const AND = (key: string, name = "Слияние потоков"): Item => ({ kind: "gw", key, k: "parallel", name });

// --- справочники ---

const ROLES = {
  spec: "Сотрудник отдела корпоративных технологий",
  head: "Начальник отдела корпоративных технологий",
  dir: "Директор по персоналу и операционной эффективности",
};

const SYSTEMS = {
  elma: "ELMA365",
  excel: "Excel",
  word: "Microsoft Word",
  visio: "Microsoft Visio",
  bs: "Business studio",
  outlook: "Outlook",
  intranet: "Intranet.kmzlift.ru",
  ppt: "PowerPoint",
};

const CONTROLS = {
  agree: "«Соглашение о моделировании» утверждено Протоколом № КК-06-2026 от 19.05.2026",
  map: "«Методика картирования процессов» утверждено Протоколом № КК-06-2026 от 19.05.2026",
  std: "«Методика стандартизации процессов» утверждено Протоколом № КК-06-2026 от 19.05.2026",
  stp: "СТП 113-01-2025 «Процессное управление»",
};

/** Документы и данные; supplier/consumer — только внешние (внутри модели их выводят связи функций). */
const DATA: Record<string, [name: string, ext?: { supplier?: string; consumer?: string }]> = {
  minutes: ["Пункт протокола совещания", { supplier: "Совещание (протокол)" }],
  incoming: ["Информация о вновь выявленном процессе", { supplier: "Владелец процесса" }],
  results: ["Информация об итогах реализации процессов", { supplier: "Владельцы процессов" }],
  checklist: ["Чек-лист интервью", { supplier: "Отдел корпоративных технологий" }],
  registry: ["Реестр процессов ООО «РУ КМЗ»", { supplier: "Отдел корпоративных технологий" }],
  registryActual: ["Актуальный реестр процессов ООО «РУ КМЗ»"],
  protocol: ["Протокол интервью"],
  chain: ["Продуктовая цепочка"],
  idef0_0: ["Диаграмма процесса IDEF0 (0 уровень)"],
  idef0_1: ["Диаграмма процесса IDEF0 (1 уровень)"],
  bpmn: ["Диаграмма процесса BPMN 2.0"],
  atlas: ["Атлас процессов", { supplier: "Отдел корпоративных технологий" }],
  wiTpl: ["Шаблон рабочей инструкции", { supplier: "Отдел корпоративных технологий" }],
  wi: ["Рабочая инструкция"],
  regTpl: ["Шаблон регламента процесса", { supplier: "Отдел корпоративных технологий" }],
  reg: ["Регламент процесса", { supplier: "Отдел корпоративных технологий" }],
  procInfo: ["Информация по процессу", { supplier: "Владелец процесса" }],
  report: ["Отчет о результатах анализа соответствия"],
  devReg: ["Реестр отклонений"],
  devList: ["Перечень выявленных отклонений"],
  eff: ["Информация об эффективности реализации процесса", { consumer: "Владелец процесса" }],
  ineff: ["Информация о неэффективности реализации процесса"],
  frd: ["Результаты ФРД ООО «РУ КМЗ»"],
  loss: ["Карточка потерь"],
  mapCur: ["Текущая карта потока создания ценности"],
  mapIdeal: ["Идеальная карта потока создания ценности"],
  mapTarget: ["Целевая карта потока создания ценности"],
  catWork: ["Справочник «Виды работ»", { supplier: "ELMA365" }],
  catSub: ["Справочник «Подвид работ»", { supplier: "ELMA365" }],
  catSw: ["Справочник «Программное обеспечение»", { supplier: "ELMA365" }],
  procProject: ["Проект процесса", { consumer: "Комиссия по качеству (утверждение процесса)" }],
  kbProject: ["Проект свода знаний процесса", { consumer: "Комиссия по качеству (утверждение процесса)" }],
  optProject: ["Проект оптимизированного процесса", { consumer: "Комиссия по качеству (утверждение процесса)" }],
  optKb: ["Проект свода знаний оптимизированного процесса", { consumer: "Комиссия по качеству (утверждение процесса)" }],
};

// --- IDEF0: подпроцессы и операции ---

interface Fn {
  id: string;
  name: string;
  parent?: string;
  in: string[];
  controls: string[];
  /** Документы, управляющие работой (чек-лист интервью): в IDEF0 они стоят механизмом, но это документ, а не ресурс. */
  ctrlData?: string[];
  out: string[];
  /** Должности-механизмы: исполнитель (executor) и контролёры (controller). */
  controllers: (keyof typeof ROLES)[];
}

const FUNCTIONS: Fn[] = [
  { id: "s1", name: "Моделирование процесса", in: ["minutes", "incoming"], controls: ["agree", "stp", "std"], ctrlData: ["checklist"], out: ["kbProject", "procProject"], controllers: ["head", "dir"] },
  { id: "s2", name: "Анализ эффективности процессной модели", in: ["results"], controls: ["stp", "std"], out: ["eff", "ineff"], controllers: ["head", "dir"] },
  { id: "s3", name: "Реинжиниринг процесса", in: ["ineff"], controls: ["agree", "stp", "std", "map"], ctrlData: ["checklist"], out: ["optProject", "optKb"], controllers: ["head", "dir"] },
  { id: "o11", parent: "s1", name: "Актуализация реестра процессов", in: ["incoming", "minutes"], controls: ["stp"], out: ["registryActual"], controllers: ["dir"] },
  { id: "o12", parent: "s1", name: "Проведение первичного интервью", in: ["registryActual"], controls: ["stp"], ctrlData: ["checklist"], out: ["protocol", "chain"], controllers: ["head"] },
  { id: "o13", parent: "s1", name: "Разработка модели процесса", in: ["protocol", "chain"], controls: ["stp", "std", "agree"], out: ["procProject", "kbProject"], controllers: ["head"] },
  { id: "o21", parent: "s2", name: "Анализ соответствия фактической реализации процесса утвержденной процессной модели", in: ["results"], controls: ["stp", "std"], out: ["eff", "devList"], controllers: [] },
  { id: "o22", parent: "s2", name: "Анализ причин неэффективности реализации процесса", in: ["devList"], controls: ["std"], out: ["ineff"], controllers: ["head", "dir"] },
  { id: "o31", parent: "s3", name: "Проведение интервью с владельцем процесса", in: ["ineff"], controls: ["stp"], ctrlData: ["checklist"], out: ["protocol", "chain"], controllers: ["head"] },
  { id: "o32", parent: "s3", name: "Проведение фото рабочего дня", in: ["protocol", "chain"], controls: ["stp"], out: ["frd"], controllers: [] },
  { id: "o33", parent: "s3", name: "Проведение картирования", in: ["protocol", "chain", "frd"], controls: ["stp", "map", "std"], out: ["mapTarget"], controllers: [] },
  { id: "o34", parent: "s3", name: "Разработка модели оптимизированного процесса", in: ["frd", "mapTarget"], controls: ["agree", "stp", "std", "map"], out: ["optProject", "optKb"], controllers: [] },
];

// --- BPMN операций ---

interface Diagram {
  op: string;
  items: Item[];
  /** Цепочки ключей; тройка [от, к, условие] — одна стрелка с условием. */
  flows: (string[] | [string, string, string])[];
}

const approve = (key: string, who = "руководителем отдела корпоративных технологий") => SUB(key, `Согласовать с ${who}`);
const elma = (o: StepOpts = {}): StepOpts => ({ sys: ["elma"], ...o });

const INTERVIEW_TAIL: Item[] = [
  T("comment1", "Заполнить текстовый комментарий по проведению первичного интервью", elma()),
  T("finish", "Завершить задачу по проведению первичного интервью", elma()),
  T("notify", "Отправить уведомление руководителю отдела корпоративных технологий о выполненной задаче", elma({ k: "service" })),
  T("chain", "Создать продуктовую цепочку", { in: ["protocol"], out: ["chain"] }),
  T("attach", "Прикрепить файл к задаче по составлению продуктовой цепочки", elma({ in: ["chain"] })),
  T("comment2", "Заполнить текстовый комментарий по проведению первичного интервью", elma()),
  approve("approve"),
];
const INTERVIEW_TAIL_KEYS = ["comment1", "finish", "notify", "chain", "attach", "comment2", "approve"];

const DIAGRAMS: Diagram[] = [
  {
    op: "o11",
    items: [
      START("start1", "Информация о вновь выявленном процессе получена"),
      START("start2", "Пункт протокола совещания получен"),
      AND("m1"),
      T("open", "Открыть последнюю версию реестра процессов ООО «РУ КМЗ»", { in: ["registry"], sys: ["excel"] }),
      T("code", "Вносить в реестр процессов ООО «РУ КМЗ» Код процесса", { out: ["registryActual"], sys: ["excel"] }),
      T("name", "Вносить в реестр процессов ООО «РУ КМЗ» Наименование процесса", { out: ["registryActual"], sys: ["excel"] }),
      T("owner", "Вносить в реестр процессов ООО «РУ КМЗ» Владельца процесса", { out: ["registryActual"], sys: ["excel"] }),
      T("author", "Вносить в реестр процессов ООО «РУ КМЗ» Автора процесса", { out: ["registryActual"], sys: ["excel"] }),
      T("status", "Вносить в реестр процессов ООО «РУ КМЗ» Статус процесса", { out: ["registryActual"], sys: ["excel"] }),
      XOR("m2"),
      XOR("need", "Необходимо предоставить актуальный реестр процессов?"),
      T("load", "Загрузить последнюю версию реестра процессов ООО «РУ КМЗ»", { in: ["registryActual"], sys: ["elma"] }),
      END("end", "Актуализирован реестр процессов ООО «РУ КМЗ»"),
    ],
    flows: [["start1", "m1"], ["start2", "m1"], ["m1", "open", "code", "name", "owner", "author", "status", "m2", "need"], ["need", "end", "Нет"], ["need", "load", "Да"], ["load", "m2"]],
  },
  {
    op: "o12",
    items: [
      START("start", "Актуализирован реестр процессов ООО «РУ КМЗ»"),
      T("card", "Создать карточку процесса", elma()),
      T("primary", "Заполнить первичные данные по процессу", elma()),
      T("study", "Изучить нормативную документацию по процессу", { sys: ["intranet"] }),
      T("collect", "Собрать данные по процессу из нормативной документации", { sys: ["word"], out: ["protocol"] }),
      T("assign", "Назначить первичное интервью с владельцем процесса", { sys: ["outlook"] }),
      TIMER("timer", "Наступление интервью"),
      T("interview", "Интервьюировать по вопросам процесса", { k: "business_rule", in: ["checklist"], out: ["protocol"] }),
      ...INTERVIEW_TAIL,
      END("end", "Проведено первичное интервью"),
    ],
    flows: [["start", "card", "primary", "study", "collect", "assign", "timer", "interview", ...INTERVIEW_TAIL_KEYS, "end"]],
  },
  {
    op: "o13",
    items: [
      START("start", "Проведено первичное интервью"),
      T("idef0_0", "Составить диаграмму процесса в нотации IDEF0 (0 уровень)", { sys: ["visio", "bs"], out: ["idef0_0"] }),
      T("idef0_1", "Составить диаграмму процесса в нотации IDEF0 (1 уровень)", { sys: ["visio", "bs"], out: ["idef0_1"] }),
      T("idef0_attach", "Прикрепить файл к задаче по описанию IDEF0", elma({ in: ["idef0_0", "idef0_1"] })),
      T("idef0_comment", "Заполнить текстовый комментарий по описанию IDEF0", elma()),
      approve("approve1"),
      T("assign", "Назначить повторное интервью с владельцем процесса", { in: ["checklist"], out: ["protocol"] }),
      TIMER("timer", "Наступление интервью"),
      T("interview", "Интервьюировать по вопросам процесса", { k: "business_rule" }),
      T("comment_i", "Заполнить текстовый комментарий по проведению повторного интервью", elma()),
      T("finish_i", "Завершить задачу по проведению повторного интервью", elma()),
      T("notify", "Отправить уведомление руководителю отдела корпоративных технологий о выполненной задаче", elma({ k: "service" })),
      T("bpmn", "Составить диаграмму процесса в нотации BPMN 2.0", { sys: ["visio", "bs"], out: ["bpmn"] }),
      T("bpmn_attach", "Прикрепить файл к задаче по описанию BPMN", elma({ in: ["bpmn"] })),
      T("bpmn_comment", "Заполнить текстовый комментарий по описанию BPMN", elma()),
      T("atlas", "Создать атлас процессов", { sys: ["visio"], out: ["atlas"] }),
      T("wi", "Создать рабочую инструкцию", { sys: ["visio"], in: ["wiTpl"], out: ["wi"] }),
      T("wi_attach", "Прикрепить файл к задаче «Написать рабочие инструкции»", elma({ in: ["wi"] })),
      T("wi_comment", "Заполнить текстовый комментарий по описанию рабочей инструкции", elma()),
      approve("approve2"),
      T("reg", "Написать регламент по смоделированному процессу ООО «РУ КМЗ»", { sys: ["word"], in: ["regTpl"], out: ["reg"] }),
      T("reg_attach", "Прикрепить файл к задаче по описанию регламента процесса", elma({ in: ["reg"] })),
      T("reg_comment", "Заполнить текстовый комментарий по описанию регламента процесса", elma()),
      approve("approve3"),
      T("kb", "Сформировать свод знаний процесса", { k: "service", sys: ["word"], in: ["reg", "wi"], out: ["kbProject"] }),
      T("task_kk", "Создать задачу «Утвердить процесс на КК» на ответственного секретаря", elma({ k: "service" })),
      END("end", "Завершено моделирование текущего процесса"),
    ],
    flows: [
      ["start", "idef0_0", "idef0_1", "idef0_attach", "idef0_comment", "approve1", "assign", "timer", "interview", "comment_i", "finish_i", "notify", "bpmn", "bpmn_attach", "bpmn_comment", "atlas", "wi", "wi_attach", "wi_comment", "approve2", "reg", "reg_attach", "reg_comment", "approve3", "kb", "task_kk", "end"],
    ],
  },
  {
    op: "o21",
    items: [
      START("start", "Направлена информация об итогах реализации процессов"),
      T("get", "Получить информацию по процессу ООО «РУ КМЗ»", { k: "receive" }),
      XOR("enough", "Исходных данных достаточно для анализа процесса?"),
      T("ask", "Запросить недостающую информацию по процессу", { k: "send", sys: ["outlook"] }),
      T("recv", "Получить информацию по процессу", { k: "receive", sys: ["outlook"], out: ["procInfo"] }),
      XOR("m1"),
      T("study_reg", "Изучить регламент рассматриваемого процесса", { sys: ["word"], in: ["reg"] }),
      T("study_model", "Изучить утвержденную модель процесса", { sys: ["word"] }),
      T("compare", "Сопоставить фактическую реализацию процесса с утвержденной моделью", { sys: ["word"], in: ["atlas"] }),
      T("find", "Выявить отклонения по качеству брака"),
      XOR("found", "Отклонения выявлены?"),
      T("fix_ok", "Зафиксировать соответствие фактической реализации процесса с утвержденной моделью", { sys: ["word"], out: ["report"] }),
      approve("approve", "начальником отдела корпоративных технологий"),
      END("end_ok", "Составлена информация об эффективности реализации процесса"),
      T("by_object", "Классифицировать брак по объекту отклонения", { sys: ["word"] }),
      T("by_weight", "Классифицировать брак по значимости", { sys: ["word"] }),
      T("by_freq", "Классифицировать брак по частоте возникновения", { sys: ["word"] }),
      T("by_impact", "Классифицировать брак по влиянию на процесс", { sys: ["word"] }),
      T("register", "Сформировать реестр отклонений по полученной информации по браку процессной модели", { sys: ["word"], out: ["devReg"] }),
      END("end_dev", "Составлен перечень выявленных отклонений"),
    ],
    flows: [
      ["start", "get", "enough"],
      ["enough", "ask", "Нет"],
      ["enough", "m1", "Да"],
      ["ask", "recv", "m1", "study_reg", "study_model", "compare", "find", "found"],
      ["found", "fix_ok", "Нет"],
      ["fix_ok", "approve", "end_ok"],
      ["found", "by_object", "Да"],
      ["by_object", "by_weight", "by_freq", "by_impact", "register", "end_dev"],
    ],
  },
  {
    op: "o22",
    items: [
      START("start", "Составлен перечень выявленных отклонений"),
      T("factors", "Анализировать факторы, обеспечивающие неэффективную реализацию процесса", { sys: ["word"], in: ["devReg"] }),
      XOR("split", "Какой метод анализа применить?"),
      T("model_ishikawa", "Моделировать диаграмму Исикавы", { sys: ["visio"] }),
      T("analyze_ishikawa", "Анализировать с помощью диаграммы Исикавы"),
      T("model_5why", "Моделировать с помощью метода «5 Почему»", { sys: ["visio"] }),
      T("analyze_5why", "Анализировать с помощью метода «5 Почему»"),
      XOR("join"),
      T("causes", "Определить возможные причины выявленных отклонений"),
      T("prepare", "Подготовить информацию о неэффективности реализации процесса", { sys: ["word"], out: ["report"] }),
      approve("approve1", "начальником отдела корпоративных технологий"),
      approve("approve2", "директором по персоналу и операционной эффективности"),
      END("end", "Составлена информация о неэффективности реализации процесса"),
    ],
    flows: [
      ["start", "factors", "split"],
      ["split", "model_ishikawa", "Метод Исикавы"],
      ["model_ishikawa", "analyze_ishikawa", "join"],
      ["split", "model_5why", "Метод «5 Почему»"],
      ["model_5why", "analyze_5why", "join"],
      ["join", "causes", "prepare", "approve1", "approve2", "end"],
    ],
  },
  {
    op: "o31",
    items: [
      START("start", "Завершено моделирование текущего процесса"),
      T("card", "Создать карточку процесса", elma()),
      T("data", "Заполнить данные по процессу", elma()),
      T("study", "Изучить нормативную документацию по процессу", { sys: ["intranet"] }),
      T("collect", "Собрать данные по процессу из нормативной документации", { sys: ["word"], out: ["protocol"] }),
      T("assign", "Назначить интервью с владельцем процесса", { sys: ["outlook"] }),
      TIMER("timer", "Наступление интервью"),
      T("interview", "Интервьюировать по вопросам процесса", { k: "business_rule", in: ["checklist"], out: ["protocol"] }),
      ...INTERVIEW_TAIL,
      END("end", "Проведено интервью"),
    ],
    flows: [["start", "card", "data", "study", "collect", "assign", "timer", "interview", ...INTERVIEW_TAIL_KEYS, "end"]],
  },
  {
    op: "o32",
    items: [
      START("start1", "Проведено интервью"),
      START("start2", "Завершено моделирование текущего процесса"),
      AND("join"),
      T("go", "Выехать на место работы сотрудника", { k: "manual" }),
      TIMER("shift_start", "Начало смены"),
      T("greet", "Приветствовать сотрудника", { k: "manual" }),
      T("introduce", "Представить себя сотруднику", { k: "manual" }),
      T("open", "Открыть программу ELMA365 на планшете", elma()),
      T("add", "Добавить сотрудника", elma()),
      T("fill", "Заполнить данные сотрудника", elma()),
      T("create", "Нажать «Создать»", elma()),
      T("fix_start", "Фиксировать время начала операции сотрудника", elma()),
      T("work_kind", "Фиксировать Вид работ", elma({ in: ["catWork"] })),
      T("work_sub", "Фиксировать подвид работ", elma({ in: ["catSub"] })),
      T("software", "Заполнить ПО, которым пользуется сотрудник", elma({ in: ["catSw"] })),
      T("comment", "Заполнить поле с комментарием по работе сотрудника", elma()),
      TIMER("shift_end", "Конец смены"),
      T("report", "Оформить результаты ФРД в презентацию", { sys: ["ppt"], out: ["frd"] }),
      END("end", "ФРД проведено"),
    ],
    flows: [["start1", "join"], ["start2", "join"], ["join", "go", "shift_start", "greet", "introduce", "open", "add", "fill", "create", "fix_start", "work_kind", "work_sub", "software", "comment", "shift_end", "report", "end"]],
  },
  {
    op: "o33",
    items: [
      START("start1", "ФРД проведено"),
      START("start2", "Завершено моделирование текущего процесса"),
      AND("join"),
      T("goal", "Определить цель картирования"),
      T("docs", "Собрать исходные документы по процессу"),
      T("plan", "Составить план проведения картирования", { sys: ["word"] }),
      XOR("m1"),
      T("agree1", "Согласовать план с владельцем процесса"),
      XOR("ok1", "План согласован?"),
      T("fix1", "Скорректировать план проведения картирования"),
      TIMER("day", "День выезда"),
      T("watch", "Наблюдать за ходом процесса"),
      T("state", "Фиксировать текущее состояние потока", { out: ["loss"] }),
      T("measure", "Выполнить замер ключевых временных параметров", { out: ["loss"] }),
      T("map_cur", "Моделировать текущую карту потока создания ценности", { sys: ["visio"], out: ["mapCur"] }),
      T("map_an", "Анализировать карту потока создания ценности"),
      T("loss_an", "Анализировать потери", { sys: ["word"], out: ["loss"] }),
      T("improve", "Сформировать точки улучшения"),
      T("map_ideal", "Моделировать идеальное состояние карты потока создания ценности", { sys: ["visio"], out: ["mapIdeal"] }),
      T("feasible", "Анализировать возможности реализации"),
      T("map_target", "Моделировать целевое состояние карты потока создания ценности", { sys: ["visio"], out: ["mapTarget"] }),
      XOR("m2"),
      T("agree2", "Согласовать план с владельцем процесса"),
      XOR("ok2", "План согласован?"),
      T("fix2", "Скорректировать план проведения картирования"),
      END("end", "Картирование проведено"),
    ],
    flows: [
      ["start1", "join"],
      ["start2", "join"],
      ["join", "goal", "docs", "plan", "m1", "agree1", "ok1"],
      ["ok1", "fix1", "Нет"],
      ["fix1", "m1"],
      ["ok1", "day", "Да"],
      ["day", "watch", "state", "measure", "map_cur", "map_an", "loss_an", "improve", "map_ideal", "feasible", "map_target", "m2", "agree2", "ok2"],
      ["ok2", "fix2", "Нет"],
      ["fix2", "m2"],
      ["ok2", "end", "Да"],
    ],
  },
  {
    op: "o34",
    items: [
      START("start", "Картирование проведено"),
      T("idef0_0", "Составить диаграмму процесса в нотации IDEF0 (0 уровень)", { sys: ["visio", "bs"], out: ["idef0_0"] }),
      T("idef0_1", "Составить диаграмму процесса в нотации IDEF0 (1 уровень)", { sys: ["visio", "bs"], out: ["idef0_1"] }),
      T("idef0_attach", "Прикрепить файл к задаче по описанию IDEF0", elma({ in: ["idef0_0", "idef0_1"] })),
      T("idef0_comment", "Заполнить текстовый комментарий по описанию IDEF0", elma()),
      approve("approve1", "начальником отдела корпоративных технологий"),
      T("bpmn", "Составить диаграмму процесса в нотации BPMN 2.0", { sys: ["visio", "bs"], out: ["bpmn"] }),
      T("atlas", "Создать атлас процессов", { sys: ["visio"], out: ["atlas"] }),
      T("wi", "Создать рабочую инструкцию", { sys: ["visio"], in: ["wiTpl"], out: ["wi"] }),
      T("wi_attach", "Прикрепить файл к задаче «Написать рабочие инструкции»", elma({ in: ["wi"] })),
      T("wi_comment", "Заполнить текстовый комментарий по описанию рабочей инструкции", elma()),
      approve("approve2", "начальником отдела корпоративных технологий"),
      END("end", "Завершено моделирование целевого процесса"),
    ],
    flows: [["start", "idef0_0", "idef0_1", "idef0_attach", "idef0_comment", "approve1", "bpmn", "atlas", "wi", "wi_attach", "wi_comment", "approve2", "end"]],
  },
];

// --- сборка модели ---

const dataId = (k: string) => `d_${k}`;
const stepId = (op: string, key: string) => `${op}_${key}`;

export function b002Model(): ProcessLogicModel {
  const nodes: Record<string, unknown>[] = [];
  const flows: Record<string, unknown>[] = [];

  for (const f of FUNCTIONS) {
    nodes.push({
      id: f.id,
      type: "task",
      name: f.name,
      idef0_parent: f.parent ?? null,
      role_id: f.parent ? "r_spec" : null,
      inputs: f.in.map(dataId),
      outputs: f.out.map(dataId),
      controls: f.controls.map((c) => `c_${c}`),
      control_data_ids: (f.ctrlData ?? []).map(dataId),
      status: "confirmed",
      confidence: 1,
    });
  }

  for (const d of DIAGRAMS) {
    const base = { bpmn_scope: d.op, role_id: "r_spec", status: "confirmed", confidence: 1 };
    for (const it of d.items) {
      const id = stepId(d.op, it.key);
      if (it.kind === "task") {
        nodes.push({ ...base, id, type: "task", subtype: it.k ?? "user", name: it.name, inputs: (it.in ?? []).map(dataId), outputs: (it.out ?? []).map(dataId), system_ids: (it.sys ?? []).map((s) => `s_${s}`) });
      } else if (it.kind === "sub") {
        nodes.push({ ...base, id, type: "subprocess", name: it.name });
      } else if (it.kind === "event") {
        nodes.push({ ...base, id, type: "event", subtype: it.k === "timer" ? "timer" : it.k, name: it.name });
      } else {
        nodes.push({ ...base, id, type: "gateway", subtype: it.k, name: it.name });
      }
    }
    let n = 0;
    const link = (from: string, to: string, condition?: string) => flows.push({ id: `${d.op}_f${++n}`, from: stepId(d.op, from), to: stepId(d.op, to), condition: condition ?? null });
    for (const chain of d.flows) {
      const isConditional = chain.length === 3 && ["Да", "Нет"].concat(["Метод Исикавы", "Метод «5 Почему»"]).includes(chain[2]);
      if (isConditional) link(chain[0], chain[1], chain[2]);
      else for (let i = 0; i + 1 < chain.length; i++) link(chain[i], chain[i + 1]);
    }
  }

  const assignments: Record<string, unknown>[] = [{ node_id: null, role_id: "r_head", kind: "owner", functions: ["Отвечает за результат и актуальность процесса управления процессами"] }];
  for (const f of FUNCTIONS) {
    if (!f.parent) assignments.push({ node_id: f.id, role_id: "r_head", kind: "owner", functions: [] });
    else assignments.push({ node_id: f.id, role_id: "r_spec", kind: "executor", functions: [] });
    for (const c of f.controllers) if (!(f.parent === undefined && c === "head")) assignments.push({ node_id: f.id, role_id: `r_${c}`, kind: "controller", functions: [] });
  }

  return ProcessLogicModel.parse({
    process: {
      id: "b002",
      name: "Управление процессами ООО «РУ КМЗ»",
      code: "B002.00.00",
      owner: ROLES.head,
      department: "Отдел корпоративных технологий",
      type: "AS-IS",
      goal: "Описать, проанализировать и оптимизировать процессы ООО «РУ КМЗ» по единому Соглашению о моделировании",
    },
    roles: Object.entries(ROLES).map(([k, name]) => ({ id: `r_${k}`, name })),
    systems: Object.entries(SYSTEMS).map(([k, name]) => ({ id: `s_${k}`, name })),
    controls: Object.entries(CONTROLS).map(([k, name]) => ({ id: `c_${k}`, name, kind: "regulation" })),
    data: Object.entries(DATA).map(([k, [name, ext]]) => ({ id: dataId(k), name, kind: "document", ...ext })),
    nodes,
    flows,
    assignments,
  });
}
