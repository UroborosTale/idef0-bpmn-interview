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

export const TakeInput = z.object({ agent: z.string().trim().min(1).max(60) });
export const CompleteInput = z.object({ note: z.string().max(4000).default("") });

export const ResolveInput = z.object({
  status: z.enum(["applied", "rejected"]),
  /** Причина отказа — агент увидит её и учтёт в следующем предложении. */
  reason: z.string().max(2000).optional(),
});
