import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { FindingInput, ProposalInput, QuestionItem } from "../types/patch.js";
import { outline, type ModelView } from "./outline.js";

/**
 * MCP-сервер процессной модели для Cline: главный агент и субагенты читают модель и отправляют предложения правок.
 * Сервер ходит в API приложения по токену AGENT_API_TOKEN (только ручки /agent/*) — применить предложение он не может,
 * это делает человек в студии.
 */

export interface AgentApi {
  get(path: string): Promise<{ status: number; body: any }>;
  post(path: string, body: unknown): Promise<{ status: number; body: any }>;
}

/** Клиент API по HTTP: baseUrl вида http://127.0.0.1:8787, токен — AGENT_API_TOKEN приложения. */
export function httpApi(baseUrl: string, token: string): AgentApi {
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed: any = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* не JSON — оставляем текст (например, правила работы) */
    }
    return { status: res.status, body: parsed };
  };
  return { get: (p) => call("GET", p), post: (p, b) => call("POST", p, b) };
}

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };
const ok = (text: string): Result => ({ content: [{ type: "text", text }] });
const fail = (text: string): Result => ({ content: [{ type: "text", text }], isError: true });
const apiError = (r: { status: number; body: any }): Result =>
  fail(r.status === 401 ? "Нет доступа: проверьте PM_AGENT_TOKEN (он должен совпадать с AGENT_API_TOKEN приложения)." : `Ошибка ${r.status}: ${typeof r.body === "string" ? r.body : r.body?.error ?? JSON.stringify(r.body)}`);

const taskLabel = { open: "ждёт агента", taken: "в работе", done: "выполнено", cancelled: "отменено" } as Record<string, string>;

function describeTask(t: any): string {
  const author = typeof t.createdBy === "string" && t.createdBy.startsWith("agent:") ? `, от агента ${t.createdBy.slice(6)}` : "";
  const head = `${t.id} — «${t.text}»${t.scopeNodeId ? ` (функция ${t.scopeNodeId})` : ""}${t.agent ? `, адресовано: ${t.agent}` : ""}${author} — ${taskLabel[t.status] ?? t.status}${t.takenBy ? ` (${t.takenBy})` : ""}`;
  const lines = [head];
  if (t.resultNote) lines.push(`  Итог: ${t.resultNote}`);
  for (const p of t.proposals ?? []) lines.push(`  • предложение ${p.id}: «${p.title}» — ${statusLabel[p.status] ?? p.status}`);
  return lines.join("\n");
}

const statusLabel = { pending: "ожидает решения", applied: "применено", rejected: "отклонено" } as Record<string, string>;

function describeProposal(p: any): string {
  const lines = [`${p.id} — «${p.title}» (${p.agent}), ${statusLabel[p.status] ?? p.status}${p.stale && p.status === "pending" ? ", МОДЕЛЬ С ТЕХ ПОР ИЗМЕНИЛАСЬ" : ""}`];
  if (p.status === "rejected") lines.push(`  Причина отказа: ${p.reason || "не указана"}`);
  for (const l of p.lines ?? []) lines.push(`  • ${l}`);
  return lines.join("\n");
}

const questionLabel = { open: "ждёт интервью", asked: "задан", answered: "получен ответ", dismissed: "снят" } as Record<string, string>;
const priorityLabel = { critical: "критично", important: "важно", desirable: "желательно" } as Record<string, string>;
const levelLabel = { high: "высокое", medium: "среднее", low: "низкое" } as Record<string, string>;
const reportLabel = { new: "новый", read: "прочитан", archived: "в архиве" } as Record<string, string>;
const kindLabel = { analysis: "анализ", review: "проверка", methodology: "методология", other: "прочее" } as Record<string, string>;

function describeQuestion(q: any): string {
  const lines = [`${q.id} — [${priorityLabel[q.priority] ?? q.priority}] «${q.text}»${q.scopeNodeId ? ` (функция ${q.scopeNodeId})` : ""}${q.addressee ? `, адресат: ${q.addressee}` : ""} — ${questionLabel[q.status] ?? q.status}`];
  if (q.reason) lines.push(`  Зачем: ${q.reason}`);
  if (q.status === "answered") lines.push(`  Ответ${q.fragmentId ? ` [${q.fragmentId}]` : ""}: ${q.answer ?? "дан на интервью"}`);
  return lines.join("\n");
}

function describeFinding(f: any, i: number): string {
  const parts = [`${i + 1}. [${levelLabel[f.impact] ?? f.impact}] ${f.what}`];
  if (f.where) parts.push(`где: ${f.where}`);
  if (f.basis) parts.push(`основание: ${f.basis}`);
  parts.push(`уверенность: ${levelLabel[f.confidence] ?? f.confidence}`);
  if (f.recommendation) parts.push(`рекомендация: ${f.recommendation}`);
  return parts.join(" — ");
}

function describeReport(r: any, full = false): string {
  const lines = [`${r.id} — «${r.title}» (${r.agent}, ${kindLabel[r.kind] ?? r.kind}), ${reportLabel[r.status] ?? r.status}${r.scopeNodeId ? `, функция ${r.scopeNodeId}` : ""}; выводов: ${r.findings?.length ?? 0}`];
  if (r.summary) lines.push(`  ${r.summary}`);
  if (full) {
    (r.findings ?? []).forEach((f: any, i: number) => lines.push(`  ${describeFinding(f, i)}`));
    if (r.body) lines.push("", r.body);
  } else if (r.hasBody) lines.push("  (есть полный текст — get_report)");
  return lines.join("\n");
}
export function createAgentServer(api: AgentApi): McpServer {
  const server = new McpServer({ name: "process-modeling", version: "1.0.0" });

  server.registerTool(
    "get_conventions",
    { title: "Правила работы", description: "Правила моделирования по Соглашению и формат предложений правок. Прочитайте до первого предложения." },
    async () => {
      const r = await api.get("/agent/conventions");
      return r.status === 200 ? ok(String(r.body)) : apiError(r);
    }
  );

  server.registerTool(
    "list_sessions",
    { title: "Список сессий", description: "Сессии моделирования: id, название процесса, код, есть ли модель." },
    async () => {
      const r = await api.get("/agent/sessions");
      if (r.status !== 200) return apiError(r);
      const rows = r.body as { id: string; title: string; processName: string; code: string | null; hasModel: boolean; updatedAt: string }[];
      return ok(rows.length ? rows.map((s) => `${s.id} — ${s.processName}${s.code ? ` (${s.code})` : ""}${s.hasModel ? "" : " — модели ещё нет"}; обновлено ${s.updatedAt}`).join("\n") : "Сессий нет.");
    }
  );

  server.registerTool(
    "get_model",
    {
      title: "Модель процесса",
      description:
        "Модель сессии: структура по кодам (id в квадратных скобках — для ссылок в предложениях), должности, продукты, шаги BPMN операций и замечания проверок. scope — id или код функции (B002.01.01): только её ветка. view=full — полный JSON модели.",
      inputSchema: { session_id: z.string(), scope: z.string().optional(), view: z.enum(["outline", "full"]).default("outline") },
    },
    async ({ session_id, scope, view }) => {
      const r = await api.get(`/agent/sessions/${encodeURIComponent(session_id)}/model`);
      if (r.status !== 200) return apiError(r);
      return ok(view === "full" ? JSON.stringify(r.body, null, 1) : outline(r.body as ModelView, scope));
    }
  );

  server.registerTool(
    "get_fragments",
    {
      title: "Текст интервью",
      description: "Фрагменты интервью с id: по ним даются цитаты в source новых записей (приложение проверяет, что цитата есть во фрагменте). from и limit — страница списка.",
      inputSchema: { session_id: z.string(), from: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(200).default(60) },
    },
    async ({ session_id, from, limit }) => {
      const r = await api.get(`/agent/sessions/${encodeURIComponent(session_id)}/fragments?from=${from}&limit=${limit}`);
      if (r.status !== 200) return apiError(r);
      const lines = (r.body.fragments as { id: string; index: number; speaker: string; text: string }[]).map((f) => `[${f.id}] (${f.speaker}): ${f.text}`);
      const end = r.body.from + lines.length;
      return ok(lines.length ? `${lines.join("\n")}\n\nФрагменты ${r.body.from + 1}–${end} из ${r.body.total}${end < r.body.total ? `; следующая страница: from=${end}` : ""}` : `Фрагментов нет (всего ${r.body.total}).`);
    }
  );

  server.registerTool(
    "propose_patch",
    {
      title: "Предложить правки",
      description:
        "Отправить аналитику предложение правок модели (список операций; формат — в get_conventions). Модель не меняется: аналитик применит или отклонит предложение в студии. Ответ содержит описание правок и то, какие замечания проверок они вносят и снимают, либо ошибки, если предложение нельзя применить.",
      inputSchema: {
        session_id: z.string(),
        agent: ProposalInput.shape.agent,
        title: ProposalInput.shape.title,
        rationale: z.string().max(6000).optional().describe("Почему: цитаты интервью, правило Соглашения, замечание проверки"),
        ops: ProposalInput.shape.ops,
        task_id: z.string().optional().describe("Задание аналитика, по которому подготовлено предложение (get_tasks)"),
      },
    },
    async ({ session_id, agent, title, rationale, ops, task_id }) => {
      const r = await api.post(`/agent/sessions/${encodeURIComponent(session_id)}/proposals`, { agent, title, rationale: rationale ?? "", ops, ...(task_id ? { task_id } : {}) });
      if (r.status === 201) {
        const d = r.body.delta as { introduced: { severity: string; message: string }[]; resolved: { severity: string; message: string }[] };
        const lines = [`Предложение ${r.body.id} отправлено аналитику (ожидает решения).`, ...r.body.lines.map((l: string) => `• ${l}`)];
        lines.push(`Снимает замечаний: ${d.resolved.length}${d.resolved.length ? ` — ${d.resolved.map((i) => i.message).join(" | ")}` : ""}`);
        lines.push(`Вносит новых замечаний: ${d.introduced.length}${d.introduced.length ? ` — ${d.introduced.map((i) => i.message).join(" | ")}. Если можно, доработайте предложение.` : ""}`);
        return ok(lines.join("\n"));
      }
      if (r.status === 422 || r.status === 400) {
        const errors = (r.body.errors ?? r.body.details ?? []) as ({ index: number | null; message: string } | string)[];
        const text = errors.map((e) => (typeof e === "string" ? `• ${e}` : `• ${e.index === null ? "модель" : `операция ${e.index + 1}`}: ${e.message}`)).join("\n");
        return fail(`${r.body.error}:\n${text}\nПредложение не сохранено — исправьте и отправьте снова.`);
      }
      return apiError(r);
    }
  );

  server.registerTool(
    "get_tasks",
    {
      title: "Задания аналитика",
      description: "Задания, которые аналитик поставил агенту в студии. По умолчанию — ожидающие (open); status=taken — взятые в работу, done — выполненные.",
      inputSchema: { session_id: z.string(), status: z.enum(["open", "taken", "done", "cancelled"]).default("open") },
    },
    async ({ session_id, status }) => {
      const r = await api.get(`/agent/sessions/${encodeURIComponent(session_id)}/tasks?status=${status}`);
      if (r.status !== 200) return apiError(r);
      return ok(r.body.length ? r.body.map(describeTask).join("\n\n") : "Заданий нет.");
    }
  );

  server.registerTool(
    "create_task",
    {
      title: "Поручить другому агенту",
      description:
        "Задание другому агенту — обратная связь внутри команды: например, нормоконтролёр поручает моделисту доработать операцию по замечаниям. Задание увидит и сможет отменить аналитик; модель оно не меняет. На сессию — не больше 20 незавершённых заданий от агентов.",
      inputSchema: {
        session_id: z.string(),
        text: z.string().min(1).max(2000),
        for_agent: z.string().describe("Роль агента-исполнителя: моделист, нормоконтролёр, интервьюер, аналитик"),
        from_agent: z.string().describe("Ваша роль"),
        scope: z.string().optional().describe("Функция модели (id), к которой относится задание"),
      },
    },
    async ({ session_id, text, for_agent, from_agent, scope }) => {
      const r = await api.post(`/agent/sessions/${encodeURIComponent(session_id)}/tasks`, { text, agent: for_agent, from: from_agent, ...(scope ? { scope } : {}) });
      return r.status === 201 ? ok(`Задание создано.\n${describeTask(r.body)}`) : apiError(r);
    }
  );

  server.registerTool(
    "take_task",
    { title: "Взять задание", description: "Взять ожидающее задание в работу: другой агент его уже не возьмёт. Затем готовьте предложения (propose_patch с task_id) и завершите задание (complete_task).", inputSchema: { task_id: z.string(), agent: z.string() } },
    async ({ task_id, agent }) => {
      const r = await api.post(`/agent/tasks/${encodeURIComponent(task_id)}/take`, { agent });
      return r.status === 200 ? ok(`Задание взято в работу.\n${describeTask(r.body)}`) : apiError(r);
    }
  );

  server.registerTool(
    "complete_task",
    {
      title: "Завершить задание",
      description: "Отметить задание выполненным и кратко написать итог: что предложено, что осталось неясным и какие вопросы к аналитику. Применяет предложения человек — завершение задания не значит, что правки приняты.",
      inputSchema: { task_id: z.string(), note: z.string().max(4000).default("") },
    },
    async ({ task_id, note }) => {
      const r = await api.post(`/agent/tasks/${encodeURIComponent(task_id)}/complete`, { note });
      return r.status === 200 ? ok(`Задание завершено.\n${describeTask(r.body)}`) : apiError(r);
    }
  );

  server.registerTool(
    "list_proposals",
    {
      title: "Предложения сессии",
      description: "Предложения по сессии со статусом и решением аналитика. У отклонённых — причина: учитывайте её в следующих предложениях.",
      inputSchema: { session_id: z.string(), status: z.enum(["pending", "applied", "rejected"]).optional() },
    },
    async ({ session_id, status }) => {
      const r = await api.get(`/agent/sessions/${encodeURIComponent(session_id)}/proposals${status ? `?status=${status}` : ""}`);
      if (r.status !== 200) return apiError(r);
      return ok(r.body.length ? r.body.map(describeProposal).join("\n\n") : "Предложений нет.");
    }
  );

  server.registerTool(
    "get_proposal",
    { title: "Предложение", description: "Одно предложение: статус, причина отказа и описание правок.", inputSchema: { proposal_id: z.string() } },
    async ({ proposal_id }) => {
      const r = await api.get(`/agent/proposals/${encodeURIComponent(proposal_id)}`);
      return r.status === 200 ? ok(describeProposal(r.body)) : apiError(r);
    }
  );

  server.registerTool(
    "add_questions",
    {
      title: "Сохранить вопросы к интервью",
      description:
        "Сохранить в приложении вопросы к следующему интервью (роль «интервьюер»): они появятся у аналитика во вкладке «Вопросы» с адресатом и приоритетом, он отметит заданные и полученные ответы. Повторы существующих вопросов не создаются. Не больше 20 вопросов за вызов, около 5 на одну функцию. Модель вопросы не меняют.",
      inputSchema: {
        session_id: z.string(),
        agent: z.string().describe("Ваша роль"),
        questions: z.array(QuestionItem).min(1).max(20).describe("text, addressee (должность), scope (код функции B002.01.02), reason (зачем), priority (critical | important | desirable)"),
        task_id: z.string().optional().describe("Задание аналитика, по которому подготовлены вопросы"),
      },
    },
    async ({ session_id, agent, questions, task_id }) => {
      const r = await api.post(`/agent/sessions/${encodeURIComponent(session_id)}/questions`, { agent, questions, ...(task_id ? { task_id } : {}) });
      if (r.status === 400 && r.body?.details) return fail(`${r.body.error}:\n${(r.body.details as string[]).map((d) => `• ${d}`).join("\n")}\nВопросы не сохранены — исправьте и отправьте снова.`);
      if (r.status !== 201) return apiError(r);
      const lines = [`Сохранено вопросов: ${r.body.added.length}.`, ...r.body.added.map(describeQuestion)];
      if (r.body.duplicates.length) lines.push(`Уже были (не добавлены): ${r.body.duplicates.map((d: any) => `${d.id} «${d.text}» — ${questionLabel[d.status] ?? d.status}`).join("; ")}`);
      if (r.body.skipped.length) lines.push(`Не добавлены: ${r.body.skipped.map((s: any) => `«${s.text}» — ${s.reason}`).join("; ")}`);
      return ok(lines.join("\n"));
    }
  );

  server.registerTool(
    "list_questions",
    {
      title: "Вопросы к интервью",
      description: "Вопросы сессии со статусами: что уже задано и на что получен ответ (с id фрагмента). Смотрите до составления нового списка, чтобы не повторяться. Без status — все.",
      inputSchema: { session_id: z.string(), status: z.enum(["open", "asked", "answered", "dismissed"]).optional() },
    },
    async ({ session_id, status }) => {
      const r = await api.get(`/agent/sessions/${encodeURIComponent(session_id)}/questions${status ? `?status=${status}` : ""}`);
      if (r.status !== 200) return apiError(r);
      return ok(r.body.length ? r.body.map(describeQuestion).join("\n\n") : "Вопросов нет.");
    }
  );

  server.registerTool(
    "add_report",
    {
      title: "Сохранить отчёт",
      description:
        "Сохранить в приложении отчёт (роли «аналитик», «нормоконтролёр», «методолог»): аналитик увидит его во вкладке «Отчёты». Выводы — структурой (что, где, основание, влияние, уверенность, рекомендация); полный текст — в body (markdown). Модель отчёт не меняет — правки предлагаются отдельно через propose_patch.",
      inputSchema: {
        session_id: z.string(),
        agent: z.string().describe("Ваша роль"),
        kind: z.enum(["analysis", "review", "methodology", "other"]).default("analysis"),
        title: z.string().min(3).max(200),
        summary: z.string().max(2000).optional().describe("Главное в 2–3 предложениях"),
        findings: z.array(FindingInput).max(50).default([]).describe("Выводы по влиянию, не больше 10 важных"),
        body: z.string().max(30000).optional().describe("Полный текст отчёта, markdown"),
        scope: z.string().optional().describe("Функция (код B002.01.02), к которой относится отчёт"),
        task_id: z.string().optional(),
      },
    },
    async ({ session_id, agent, kind, title, summary, findings, body, scope, task_id }) => {
      const r = await api.post(`/agent/sessions/${encodeURIComponent(session_id)}/reports`, { agent, kind, title, findings, ...(summary ? { summary } : {}), ...(body ? { body } : {}), ...(scope ? { scope } : {}), ...(task_id ? { task_id } : {}) });
      if (r.status === 400 && r.body?.details) return fail(`${r.body.error}:\n${(r.body.details as string[]).map((d) => `• ${d}`).join("\n")}\nОтчёт не сохранён — исправьте и отправьте снова.`);
      return r.status === 201 ? ok(`Отчёт сохранён и ждёт аналитика.\n${describeReport(r.body)}`) : apiError(r);
    }
  );

  server.registerTool(
    "list_reports",
    {
      title: "Отчёты сессии",
      description: "Отчёты агентов по сессии: заголовок, роль, статус (новый, прочитан, в архиве) и краткое содержание. Полный текст — get_report.",
      inputSchema: { session_id: z.string(), status: z.enum(["new", "read", "archived"]).optional() },
    },
    async ({ session_id, status }) => {
      const r = await api.get(`/agent/sessions/${encodeURIComponent(session_id)}/reports${status ? `?status=${status}` : ""}`);
      if (r.status !== 200) return apiError(r);
      return ok(r.body.length ? r.body.map((x: any) => describeReport(x)).join("\n\n") : "Отчётов нет.");
    }
  );

  server.registerTool(
    "get_report",
    { title: "Отчёт", description: "Один отчёт целиком: выводы и полный текст.", inputSchema: { report_id: z.string() } },
    async ({ report_id }) => {
      const r = await api.get(`/agent/reports/${encodeURIComponent(report_id)}`);
      return r.status === 200 ? ok(describeReport(r.body, true)) : apiError(r);
    }
  );
  return server;
}
