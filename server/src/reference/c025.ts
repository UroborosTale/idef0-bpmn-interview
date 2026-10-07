import { ProcessLogicModel } from "../types/model.js";
import { AND, BOUNDARY, END, IF, START, SUB, T, TIMER, XOR, buildDiagram, type Diagram } from "./builder.js";

/**
 * Демонстрационный процесс C025 «Организация обучения и аттестации персонала ООО «РУ КМЗ»» — один процесс, в котором
 * использованы все возможности редактора по Соглашению о моделировании:
 *  • структура по кодам: процесс C025.00.00 → подпроцессы C025.01.00… → операции C025.01.01…, группа процессов (папка);
 *  • отдельная диаграмма BPMN у каждой операции, несколько дорожек (должностей), события — факты, развилки после задач;
 *  • задача «Бизнес-правила», отправка и получение сообщений, таймеры, шлюзы XOR и AND, подпроцесс-согласование;
 *  • граничные события: прерывающее (срок утверждения) и непрерывающее (срок заполнения заявки);
 *  • документы на ассоциациях, хранилища данных (ELMA365, Outlook, Excel, 1С), регламенты-аннотации;
 *  • внешний пул «Учебный центр» и потоки сообщений к нему и от него;
 *  • ролевая модель: владелец, исполнитель, соисполнитель, контролёр, наблюдатель; квалификация должности;
 *  • карточки продуктов: внешний поставщик и потребитель, ценность, стандарт качества; схема перехода статусов.
 *
 * ВАЖНО: структура (подпроцессы и операции первых двух подпроцессов, их коды) взята из дерева процессов в Business Studio;
 * шаги, роли, продукты и сроки — черновик для демонстрации и сверки с владельцем процесса, поэтому элементы помечены как
 * гипотезы (пунктирная рамка) и процесс имеет статус «черновик».
 */

const ROLES: Record<string, { name: string; qualification?: string }> = {
  emp: { name: "Сотрудник (инициатор обучения)" },
  mgr: { name: "Непосредственный руководитель сотрудника" },
  hr: { name: "Специалист по обучению персонала", qualification: "Опыт организации обучения персонала от 1 года, знание Положения об обучении и аттестации" },
  hrhead: { name: "Начальник отдела обучения и развития персонала" },
  dir: { name: "Директор по персоналу и операционной эффективности" },
};

const SYSTEMS: Record<string, string> = { elma: "ELMA365", outlook: "Outlook", excel: "Excel", zup: "1С:ЗУП" };

const CONTROLS: Record<string, string> = {
  policy: "Положение об обучении и аттестации персонала",
  plan: "План обучения персонала на год",
};

type Ext = { supplier?: string; consumer?: string; value?: string; quality_standard?: string };
const DATA: Record<string, [name: string, ext?: Ext]> = {
  need: ["Потребность в обучении", { supplier: "Руководители подразделений", value: "Основание для планирования расходов на обучение", quality_standard: "Указаны сотрудник, тема обучения и желаемый срок" }],
  note: ["Служебная записка о потребности в обучении"],
  program: ["Программа обучения"],
  application: ["Заявка на обучение", { value: "Основание для согласования расходов на обучение", quality_standard: "Заполнены все обязательные поля, приложена программа обучения" }],
  approved: ["Согласованная заявка на обучение", { value: "Разрешение на расходы", quality_standard: "Есть решение руководителя и утверждение расходов" }],
  confirmed: ["Подтверждённая программа обучения", { value: "Гарантия, что учебный центр проведёт обучение", quality_standard: "Тема, сроки и стоимость программы совпадают с заявкой" }],
  card: ["Карточка обучения"],
  attendance: ["Журнал посещаемости"],
  completion: ["Сведения о завершении обучения"],
  cert: ["Документ об обучении", { supplier: "Учебный центр" }],
  result: ["Результат обучения сотрудника", { value: "Подтверждает прохождение обучения", quality_standard: "Документ проверен, результат внесён в личное дело" }],
  attestation: ["Результат аттестации сотрудника", { consumer: "Отдел кадров (личное дело сотрудника)", value: "Основание для решения о квалификации сотрудника", quality_standard: "Оценка выставлена по критериям Положения" }],
};

interface Fn {
  id: string;
  name: string;
  parent?: string;
  in: string[];
  controls: string[];
  out: string[];
  /** Роли функции: ключ роли → вид назначения. */
  roles: Record<string, "owner" | "executor" | "coexecutor" | "controller" | "observer">[];
  functions?: Record<string, string[]>;
}

const FUNCTIONS: Fn[] = [
  { id: "s1", name: "Оформление заявки на обучение сотрудника", in: ["need"], controls: ["policy", "plan"], out: ["confirmed"], roles: [{ hrhead: "owner" }] },
  { id: "o11", parent: "s1", name: "Формирование заявки на обучение", in: ["need"], controls: ["policy", "plan"], out: ["application"], roles: [{ hr: "executor" }, { emp: "coexecutor" }], functions: { hr: ["Проверяет потребность на соответствие плану", "Заполняет заявку и прикладывает программу"], emp: ["Подаёт служебную записку о потребности"] } },
  { id: "o12", parent: "s1", name: "Согласование заявки на обучение", in: ["application"], controls: ["policy"], out: ["approved"], roles: [{ hr: "executor" }, { mgr: "coexecutor" }, { dir: "controller" }], functions: { mgr: ["Принимает решение по заявке"], dir: ["Утверждает расходы на обучение"] } },
  { id: "o13", parent: "s1", name: "Подтверждение программы обучения", in: ["approved"], controls: ["policy"], out: ["confirmed"], roles: [{ hr: "executor" }, { mgr: "observer" }] },
  { id: "s2", name: "Проведение обучения", in: ["confirmed"], controls: ["policy"], out: ["result"], roles: [{ hrhead: "owner" }] },
  { id: "o21", parent: "s2", name: "Сопровождение обучения сотрудника", in: ["confirmed"], controls: ["policy"], out: ["completion"], roles: [{ hr: "executor" }, { emp: "coexecutor" }] },
  { id: "o22", parent: "s2", name: "Учет результата обучения", in: ["completion"], controls: ["policy"], out: ["result"], roles: [{ hr: "executor" }, { hrhead: "controller" }] },
  { id: "s3", name: "Аттестация сотрудника по итогам обучения", in: ["result"], controls: ["policy"], out: ["attestation"], roles: [{ hrhead: "owner" }] },
  { id: "o31", parent: "s3", name: "Проведение аттестации сотрудника", in: ["result"], controls: ["policy"], out: ["attestation"], roles: [{ hr: "executor" }, { dir: "controller" }, { emp: "observer" }] },
];

const DIAGRAMS: Diagram[] = [
  {
    op: "o11",
    role: "hr",
    items: [
      START("start", "Потребность в обучении выявлена", "emp"),
      T("note", "Подать служебную записку о потребности в обучении", { r: "emp", sys: ["outlook"], out: ["note"] }),
      T("receive", "Получить служебную записку", { sys: ["outlook"], in: ["note"] }),
      T("check", "Проверить потребность на соответствие плану обучения", { k: "business_rule", ctl: ["plan"], in: ["note"] }),
      XOR("fit", "Потребность соответствует плану обучения?"),
      T("back", "Вернуть служебную записку инициатору на доработку", { sys: ["outlook"] }),
      END("end_back", "Служебная записка возвращена инициатору"),
      T("fill", "Заполнить заявку на обучение", { sys: ["elma"], out: ["application"] }),
      BOUNDARY("late", "fill", "timer", "Срок заполнения заявки истёк", false),
      T("remind", "Напомнить исполнителю о сроке заполнения", { k: "service", sys: ["elma"] }),
      END("end_remind", "Исполнитель уведомлён о сроке"),
      T("attach", "Прикрепить программу обучения к заявке", { sys: ["elma"], in: ["program"] }),
      END("end", "Заявка на обучение сформирована"),
    ],
    flows: [["start", "note", "receive", "check", "fit"], IF("fit", "back", "Нет"), ["back", "end_back"], IF("fit", "fill", "Да"), ["fill", "attach", "end"], ["late", "remind", "end_remind"]],
  },
  {
    op: "o12",
    role: "hr",
    items: [
      START("start", "Заявка на обучение сформирована"),
      T("send", "Направить заявку на согласование руководителю", { sys: ["elma"], in: ["application"] }),
      T("review", "Рассмотреть заявку на обучение", { r: "mgr", sys: ["elma"], in: ["application"] }),
      XOR("ok", "Руководитель согласовал заявку?", "mgr"),
      T("reason", "Зафиксировать причину отказа", { sys: ["elma"] }),
      END("end_no", "Заявка на обучение отклонена"),
      T("budget", "Утвердить расходы на обучение", { r: "dir", sys: ["elma"], out: ["approved"] }),
      BOUNDARY("late", "budget", "timer", "Срок утверждения расходов истёк", true),
      T("escalate", "Эскалировать согласование директору по персоналу", { k: "service", r: "dir", sys: ["elma"] }),
      END("end_esc", "Согласование эскалировано", "dir"),
      END("end", "Заявка на обучение согласована", "dir"),
    ],
    flows: [["start", "send", "review", "ok"], IF("ok", "reason", "Нет"), ["reason", "end_no"], IF("ok", "budget", "Да"), ["budget", "end"], ["late", "escalate", "end_esc"]],
  },
  {
    op: "o13",
    role: "hr",
    items: [
      START("start", "Заявка на обучение согласована"),
      XOR("m"),
      T("send", "Отправить заявку в учебный центр", { k: "send", sys: ["outlook"], in: ["approved"] }),
      T("recv", "Получить подтверждение программы обучения", { k: "receive", sys: ["outlook"], out: ["confirmed"] }),
      XOR("ok", "Программа обучения подтверждена?"),
      T("clarify", "Уточнить условия обучения с учебным центром", { sys: ["outlook"] }),
      T("card", "Внести данные о программе в карточку обучения", { sys: ["elma"], in: ["confirmed"], out: ["card"] }),
      END("end", "Программа обучения подтверждена"),
    ],
    flows: [["start", "m", "send", "recv", "ok"], IF("ok", "clarify", "Нет"), ["clarify", "m"], IF("ok", "card", "Да"), ["card", "end"]],
    messages: [
      { from: "send", to: "p_center", name: "Заявка на обучение" },
      { from: "p_center", to: "recv", name: "Подтверждение программы" },
    ],
  },
  {
    op: "o21",
    role: "hr",
    items: [
      START("start", "Программа обучения подтверждена"),
      T("notify", "Уведомить сотрудника о сроках и месте обучения", { sys: ["outlook"], in: ["confirmed"] }),
      TIMER("begin", "Начало обучения"),
      T("attend", "Пройти обучение", { k: "manual", r: "emp" }),
      T("control", "Контролировать посещаемость", { sys: ["excel"], out: ["attendance"] }),
      XOR("done", "Сотрудник завершил обучение?"),
      T("reason", "Выяснить причину прерывания обучения", { sys: ["outlook"] }),
      END("end_no", "Обучение прервано"),
      T("complete", "Подготовить сведения о завершении обучения", { sys: ["elma"], in: ["attendance"], out: ["completion"] }),
      END("end", "Обучение завершено"),
    ],
    flows: [["start", "notify", "begin", "attend", "control", "done"], IF("done", "reason", "Нет"), ["reason", "end_no"], IF("done", "complete", "Да"), ["complete", "end"]],
  },
  {
    op: "o22",
    role: "hr",
    items: [
      START("start", "Обучение завершено"),
      XOR("m"),
      T("recv", "Получить документ о результатах обучения", { k: "receive", sys: ["outlook"], out: ["cert"] }),
      T("check", "Проверить полноту документа об обучении", { k: "business_rule", ctl: ["policy"], in: ["cert"] }),
      XOR("ok", "Документ оформлен верно?"),
      T("ask", "Запросить исправление документа", { k: "send", sys: ["outlook"] }),
      AND("split", "Параллельные действия"),
      T("file", "Внести результат в личное дело", { sys: ["zup"], in: ["cert"], out: ["result"] }),
      T("registry", "Обновить реестр результатов обучения", { sys: ["excel"] }),
      AND("join"),
      END("end", "Результат обучения учтён"),
    ],
    flows: [["start", "m", "recv", "check", "ok"], IF("ok", "ask", "Нет"), ["ask", "m"], IF("ok", "split", "Да"), ["split", "file", "join"], ["split", "registry", "join"], ["join", "end"]],
    messages: [
      { from: "p_center", to: "recv", name: "Документ об обучении" },
      { from: "ask", to: "p_center", name: "Запрос исправления документа" },
    ],
  },
  {
    op: "o31",
    role: "hr",
    items: [
      START("start", "Результат обучения учтён"),
      T("date", "Назначить дату аттестации", { sys: ["outlook"] }),
      T("questions", "Подготовить аттестационные вопросы", { ctl: ["policy"], in: ["result"] }),
      TIMER("day", "Наступление даты аттестации"),
      T("run", "Провести аттестацию сотрудника"),
      T("score", "Оценить результаты аттестации по критериям Положения", { k: "business_rule", ctl: ["policy"] }),
      XOR("passed", "Аттестация пройдена?"),
      T("again", "Назначить повторную аттестацию", { sys: ["outlook"] }),
      END("end_again", "Повторная аттестация назначена"),
      T("file", "Внести результат аттестации в личное дело", { sys: ["zup"], out: ["attestation"] }),
      SUB("approve", "Согласовать результат аттестации с директором по персоналу", "dir"),
      END("end", "Аттестация сотрудника завершена", "dir"),
    ],
    flows: [["start", "date", "questions", "day", "run", "score", "passed"], IF("passed", "again", "Нет"), ["again", "end_again"], IF("passed", "file", "Да"), ["file", "approve", "end"]],
  },
];

export function c025Model(): ProcessLogicModel {
  const id = {
    role: (k: string) => `r_${k}`,
    data: (k: string) => `d_${k}`,
    system: (k: string) => `s_${k}`,
    control: (k: string) => `c_${k}`,
    status: "hypothesis" as const,
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
      role_id: f.parent ? id.role("hr") : null,
      inputs: f.in.map(id.data),
      outputs: f.out.map(id.data),
      controls: f.controls.map(id.control),
      status: "hypothesis",
      confidence: 0.5,
    });
  }
  for (const d of DIAGRAMS) {
    const built = buildDiagram(d, id);
    nodes.push(...built.nodes);
    flows.push(...built.flows);
    messages.push(...built.messages);
  }

  const assignments: Record<string, unknown>[] = [{ node_id: null, role_id: id.role("hrhead"), kind: "owner", functions: ["Отвечает за результат и актуальность процесса обучения и аттестации персонала"] }];
  for (const f of FUNCTIONS) {
    for (const entry of f.roles) {
      for (const [role, kind] of Object.entries(entry)) assignments.push({ node_id: f.id, role_id: id.role(role), kind, functions: f.functions?.[role] ?? [] });
    }
  }

  return ProcessLogicModel.parse({
    process: {
      id: "c025",
      name: "Организация обучения и аттестации персонала ООО «РУ КМЗ»",
      code: "C025.00.00",
      group: "Организация дополнительного профессионального обучения персонала ООО «РУ КМЗ»",
      owner: ROLES.hrhead.name,
      author: ROLES.hr.name,
      department: "Отдел обучения и развития персонала",
      type: "AS-IS",
      status: "draft",
      goal: "ЧЕРНОВИК. Структура взята из дерева процессов в Business Studio; шаги, роли, продукты и сроки — предположения для демонстрации возможностей редактора и сверки с владельцем процесса.",
    },
    roles: Object.entries(ROLES).map(([k, r]) => ({ id: id.role(k), name: r.name, qualification: r.qualification ?? null })),
    systems: Object.entries(SYSTEMS).map(([k, name]) => ({ id: id.system(k), name })),
    controls: Object.entries(CONTROLS).map(([k, name]) => ({ id: id.control(k), name, kind: "regulation" })),
    data: Object.entries(DATA).map(([k, [name, ext]]) => ({ id: id.data(k), name, kind: "document", ...ext })),
    nodes,
    flows,
    pools: [{ id: "p_center", name: "Учебный центр", code: null }],
    messages,
    assignments,
  });
}
