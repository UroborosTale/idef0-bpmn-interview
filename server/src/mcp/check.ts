import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createAgentServer, httpApi } from "./server.js";

/**
 * Проверка готовности к подключению агента (Cline): приложение отвечает, токен принимается, MCP-сервер запускается
 * и отдаёт инструменты. Каждая проверка — строка отчёта с подсказкой, что исправить.
 */

export interface CheckLine {
  ok: boolean;
  /** Что проверено и что получилось. */
  text: string;
  /** Что сделать, если не получилось. */
  hint?: string;
}

export const EXPECTED_TOOLS = ["get_conventions", "list_sessions", "get_model", "get_fragments", "propose_patch", "list_proposals", "get_proposal", "get_tasks", "create_task", "take_task", "complete_task", "add_questions", "list_questions", "add_report", "list_reports", "get_report"];

export interface CheckOptions {
  baseUrl: string;
  token: string;
  /** Путь к собранному MCP-серверу (server/dist/mcp/index.js): если задан, проверяется и запуск как в Cline — отдельным процессом. */
  stdioEntry?: string;
  /** Для тестов: подмена запросов. */
  fetchImpl?: typeof fetch;
}

async function tryFetch(f: typeof fetch, url: string, init?: RequestInit): Promise<{ status: number; body: any } | { error: string }> {
  try {
    const res = await f(url, { ...init, signal: AbortSignal.timeout(8000) });
    const text = await res.text();
    let body: any = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* не JSON */
    }
    return { status: res.status, body };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export async function checkAgentSetup(opts: CheckOptions): Promise<CheckLine[]> {
  const f = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl.replace(/\/$/, "");
  const lines: CheckLine[] = [];

  // 1. приложение отвечает
  const health = await tryFetch(f, `${base}/api/health`);
  if ("error" in health || health.status !== 200) {
    lines.push({ ok: false, text: `Приложение не отвечает по адресу ${base}`, hint: "Запустите приложение (npm run dev:server) и проверьте PM_API_URL. Дальнейшие проверки невозможны." });
    return lines;
  }
  lines.push({ ok: true, text: `Приложение отвечает (${base})` });

  // 2. токен
  const auth = await tryFetch(f, `${base}/api/auth/me`);
  const authRequired = !("error" in auth) && auth.status === 200 && !!auth.body?.authRequired;
  const headers: Record<string, string> = opts.token ? { Authorization: `Bearer ${opts.token}` } : {};
  const sessions = await tryFetch(f, `${base}/api/agent/sessions`, { headers });
  if ("error" in sessions) {
    lines.push({ ok: false, text: `Запрос к API агента не удался: ${sessions.error}` });
    return lines;
  }
  if (sessions.status === 401) {
    lines.push({
      ok: false,
      text: opts.token ? "Токен агента не принят" : "Токен агента не задан, а в приложении включён вход",
      hint: opts.token
        ? "PM_AGENT_TOKEN должен совпадать с AGENT_API_TOKEN в .env приложения; после изменения .env перезапустите приложение."
        : "Задайте AGENT_API_TOKEN в .env приложения, перезапустите его и передайте тот же токен в PM_AGENT_TOKEN.",
    });
    return lines;
  }
  if (sessions.status !== 200) {
    lines.push({ ok: false, text: `API агента ответило ${sessions.status}`, hint: "Проверьте версию приложения: ручки /api/agent/* появились в версии с MCP-сервером." });
    return lines;
  }
  lines.push({ ok: true, text: authRequired ? "Токен агента принят (вход в приложении включён)" : "API агента доступно (вход в приложении отключён — токен не требуется)" });
  const rows = sessions.body as { id: string; hasModel: boolean }[];
  lines.push({
    ok: rows.some((s) => s.hasModel),
    text: rows.length === 0 ? "Сессий пока нет" : `Сессий: ${rows.length}, с моделью: ${rows.filter((s) => s.hasModel).length}`,
    hint: rows.some((s) => s.hasModel) ? undefined : "Создайте сессию (можно пустую — режим «Г») и откройте студию: агенту будет с чем работать.",
  });

  // 3. инструменты MCP: в процессе (логика сервера)
  const memory = await listTools(async () => {
    const server = createAgentServer(httpApi(base, opts.token));
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "agent-check", version: "1" });
    await Promise.all([server.connect(a), client.connect(b)]);
    return client;
  });
  lines.push(toolLine("Инструменты MCP-сервера", memory));

  // 4. запуск отдельным процессом — так его запускает Cline
  if (opts.stdioEntry && !fs.existsSync(opts.stdioEntry)) {
    lines.push({ ok: false, text: `Файл MCP-сервера не найден: ${opts.stdioEntry}`, hint: "Соберите сервер: npm run build -w server — Cline запускает MCP-сервер из server/dist/mcp/index.js." });
  } else if (opts.stdioEntry) {
    const stdio = await listTools(async () => {
      const client = new Client({ name: "agent-check", version: "1" });
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [opts.stdioEntry!], env: { ...(process.env as Record<string, string>), PM_API_URL: base, PM_AGENT_TOKEN: opts.token } }));
      return client;
    });
    lines.push(toolLine("Запуск MCP-сервера отдельным процессом (как в Cline)", stdio));
  }
  return lines;
}

async function listTools(connect: () => Promise<Client>): Promise<{ tools: string[] } | { error: string }> {
  let client: Client | undefined;
  try {
    client = await connect();
    return { tools: (await client.listTools()).tools.map((t) => t.name) };
  } catch (e) {
    return { error: (e as Error).message };
  } finally {
    await client?.close().catch(() => undefined);
  }
}

function toolLine(title: string, r: { tools: string[] } | { error: string }): CheckLine {
  if ("error" in r) return { ok: false, text: `${title}: не запустился (${r.error.split("\n")[0].slice(0, 160)})` };
  const missing = EXPECTED_TOOLS.filter((t) => !r.tools.includes(t));
  return missing.length === 0
    ? { ok: true, text: `${title}: ${r.tools.length} инструментов` }
    : { ok: false, text: `${title}: не хватает ${missing.join(", ")}`, hint: "Пересоберите сервер (npm run build -w server): запущена старая версия MCP-сервера." };
}

export function formatCheck(lines: CheckLine[]): string {
  const out = lines.map((l) => `${l.ok ? "✓" : "✗"} ${l.text}${!l.ok && l.hint ? `\n    → ${l.hint}` : ""}`);
  const failed = lines.filter((l) => !l.ok).length;
  out.push("", failed === 0 ? "Всё готово: добавьте MCP-сервер в Cline (docs/agents/README.md)." : `Не пройдено проверок: ${failed}.`);
  return out.join("\n");
}
