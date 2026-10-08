import { z } from "zod";

/** Предложение правок модели от агента: проверка присланного JSON (описание формата — shared/patch.ts). */

const Collection = z.enum(["roles", "systems", "data", "controls", "nodes", "flows", "pools", "messages"]);
const Fields = z.record(z.string(), z.unknown());

const Op = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add"), collection: Collection, value: Fields }),
  z.object({ op: z.literal("update"), collection: Collection, id: z.string().min(1), patch: Fields }),
  z.object({ op: z.literal("remove"), collection: Collection, id: z.string().min(1) }),
  z.object({
    op: z.literal("set_assignments"),
    node_id: z.string().min(1).nullable(),
    items: z.array(z.object({ role_id: z.string().min(1), kind: z.enum(["owner", "executor", "coexecutor", "controller", "observer"]), functions: z.array(z.string()).optional() })),
  }),
  z.object({ op: z.literal("set_process"), patch: z.record(z.string(), z.string()) }),
]);

export const ProposalInput = z.object({
  /** Кто предложил: роль агента (методолог, моделист, нормоконтролёр, интервьюер, аналитик). */
  agent: z.string().trim().min(1).max(60),
  title: z.string().trim().min(1).max(200),
  /** Почему агент это предлагает: ссылки на цитаты интервью, правила Соглашения, замечания проверок. */
  rationale: z.string().max(6000).default(""),
  ops: z.array(Op).min(1).max(300),
  /** Задание аналитика, по которому подготовлено предложение (get_tasks). */
  task_id: z.string().min(1).optional(),
});
export type ProposalInput = z.infer<typeof ProposalInput>;

export const TaskInput = z.object({
  text: z.string().trim().min(1).max(2000),
  /** Функция модели (id узла), к которой относится задание; без неё — процесс в целом. */
  scope: z.string().min(1).nullable().optional(),
  /** Роль агента, которой адресовано задание. */
  agent: z.string().trim().min(1).max(60).optional(),
});

/** Задание от одного агента другому (обратная связь Нормоконтролёр → Моделист): создаёт агент, видит и может отменить аналитик. */
export const AgentTaskInput = TaskInput.extend({
  /** Кому адресовано (обязательно): роль агента. */
  agent: z.string().trim().min(1).max(60),
  /** От кого: роль агента-автора. */
  from: z.string().trim().min(1).max(60),
});

export const TakeInput = z.object({ agent: z.string().trim().min(1).max(60) });
export const CompleteInput = z.object({ note: z.string().max(4000).default("") });

export const ResolveInput = z.object({
  status: z.enum(["applied", "rejected"]),
  /** Причина отказа — агент увидит её и учтёт в следующем предложении. */
  reason: z.string().max(2000).optional(),
});

const Role = z.string().trim().min(1).max(60);
const Level = z.enum(["high", "medium", "low"]);

/** Один вопрос к интервью (агент-интервьюер). scope — id или код функции (B002.01.02). */
export const QuestionItem = z.object({
  text: z.string().trim().min(5).max(600),
  /** Кому адресовать на интервью: должность, которая знает ответ. */
  addressee: z.string().trim().min(1).max(120).optional(),
  scope: z.string().trim().min(1).max(80).optional(),
  /** Зачем: какое замечание или пробел снимет ответ. */
  reason: z.string().trim().max(600).optional(),
  priority: z.enum(["critical", "important", "desirable"]).default("important"),
});
/** Пакет вопросов за один вызов: интервью держит около 15 вопросов, больше 20 за раз не нужно. */
export const QuestionsInput = z.object({
  agent: Role,
  questions: z.array(QuestionItem).min(1).max(20),
  task_id: z.string().min(1).optional(),
});

/** Вывод отчёта: что, где, основание, влияние, уверенность, что сделать. */
export const FindingInput = z.object({
  what: z.string().trim().min(3).max(500),
  where: z.string().trim().max(120).optional(),
  basis: z.string().trim().max(800).optional(),
  impact: Level,
  confidence: Level,
  recommendation: z.string().trim().max(800).optional(),
});
export const ReportInput = z.object({
  agent: Role,
  kind: z.enum(["analysis", "review", "methodology", "other"]).default("analysis"),
  title: z.string().trim().min(3).max(200),
  summary: z.string().trim().max(2000).optional(),
  /** Полный текст отчёта (markdown). */
  body: z.string().max(30000).optional(),
  findings: z.array(FindingInput).max(50).default([]),
  scope: z.string().trim().min(1).max(80).optional(),
  task_id: z.string().min(1).optional(),
});

/** Решение аналитика по вопросу. */
export const QuestionStatusInput = z.object({
  status: z.enum(["open", "asked", "answered", "dismissed"]),
  answer: z.string().max(4000).optional(),
  fragment_id: z.string().min(1).optional(),
});
export const ReportStatusInput = z.object({ status: z.enum(["new", "read", "archived"]) });