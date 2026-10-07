import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ProposalInput } from "../types/patch.js";
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

const statusLabel = { pending: "ожидает решения", applied: "применено", rejected: "отклонено" } as Record<string, string>;

function describeProposal(p: any): string {
  const lines = [`${p.id} — «${p.title}» (${p.agent}), ${statusLabel[p.status] ?? p.status}${p.stale && p.status === "pending" ? ", МОДЕЛЬ С ТЕХ ПОР ИЗМЕНИЛАСЬ" : ""}`];
  if (p.status === "rejected") lines.push(`  Причина отказа: ${p.reason || "не указана"}`);
  for (const l of p.lines ?? []) lines.push(`  • ${l}`);
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
      },
    },
    async ({ session_id, agent, title, rationale, ops }) => {
      const r = await api.post(`/agent/sessions/${encodeURIComponent(session_id)}/proposals`, { agent, title, rationale: rationale ?? "", ops });
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

  return server;
}
