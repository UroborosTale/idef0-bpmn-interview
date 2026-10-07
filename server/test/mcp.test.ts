import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApp } from "./api.js";
import { createAgentServer, type AgentApi } from "../src/mcp/server.js";
import { outline, type ModelView } from "../src/mcp/outline.js";
import { structuredModel } from "./fixtures.js";

delete process.env.AUTH_USERS;

async function connect(api: AgentApi) {
  const server = createAgentServer(api);
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { type: string; text: string }[]; isError?: boolean };
    return { text: r.content.map((c) => c.text).join("\n"), isError: !!r.isError };
  };
  return { client, call, close: () => client.close() };
}

describe("MCP-сервер для Cline", () => {
  let app: Awaited<ReturnType<typeof startApp>>;
  let sid: string;
  beforeAll(async () => {
    app = await startApp();
    const s = (await app.call("POST", "/sessions/blank", { meta: { processName: "Управление процессами" } })).body;
    await app.call("PUT", `/sessions/${s.id}/model`, structuredModel());
    sid = s.id;
  });
  afterAll(() => app.close());

  const api: AgentApi = { get: (p) => app.call("GET", p), post: (p, b) => app.call("POST", p, b) };

  it("инструменты: правила, сессии, модель, предложение, список и карточка предложений", async () => {
    const { client, close } = await connect(api);
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(["get_conventions", "get_model", "get_proposal", "list_proposals", "list_sessions", "propose_patch"]);
    await close();
  });

  it("get_conventions и list_sessions", async () => {
    const { call, close } = await connect(api);
    expect((await call("get_conventions")).text).toContain("Вы только предлагаете — применяет человек");
    const sessions = await call("list_sessions");
    expect(sessions.text).toContain(`${sid} — Управление процессами (B002.00.00)`);
    await close();
  });

  it("get_model: структура по кодам с id, роли, шаги BPMN, замечания; ветка по коду; полный JSON", async () => {
    const { call, close } = await connect(api);
    const t = (await call("get_model", { session_id: sid })).text;
    expect(t).toContain("код B002.00.00");
    expect(t).toContain("[r2] Специалист отдела корпоративных технологий — Опыт моделирования от 1 года");
    expect(t).toContain("B002.01.00 [s1] Моделирование процесса");
    expect(t).toContain("B002.01.01 [o1] Актуализация реестра процессов");
    expect(t).toContain("B002.01.01/001 [b1] задача user «Открыть реестр»".replace(" user", ""));
    expect(t).toContain("стрелки: b0→b1 [bf1], b1→b2 [bf2], b2→b9 [bf3]");
    expect(t).toMatch(/Замечания проверок: \d+/);
    expect(t).toContain("role_no_executor (o2)");

    const branch = (await call("get_model", { session_id: sid, scope: "B002.01.01" })).text;
    expect(branch).toContain("[o1]");
    expect(branch).toContain("[b1]");
    expect(branch).not.toContain("[o3]"); // другая ветка
    expect(branch).not.toContain("role_no_executor (o2)");
    expect((await call("get_model", { session_id: sid, scope: "нет" })).text).toContain("не найдена");

    const full = JSON.parse((await call("get_model", { session_id: sid, view: "full" })).text);
    expect(full.model.nodes.length).toBeGreaterThan(5);
    const missing = await call("get_model", { session_id: "нет" });
    expect(missing.isError).toBe(true);
    await close();
  });

  it("propose_patch: успех — описание и влияние на проверки; ошибка — понятные причины", async () => {
    const { call, close } = await connect(api);
    const ok = await call("propose_patch", {
      session_id: sid,
      agent: "нормоконтролёр",
      title: "Назначить исполнителя операции B002.01.02",
      rationale: "Замечание role_no_executor",
      ops: [{ op: "set_assignments", node_id: "o2", items: [{ role_id: "r2", kind: "executor", functions: ["Проведение интервью"] }] }],
    });
    expect(ok.isError).toBe(false);
    expect(ok.text).toMatch(/Предложение prop_\w+ отправлено аналитику/);
    expect(ok.text).toContain("• Роли B002.01.02");
    expect(ok.text).toMatch(/Снимает замечаний: 1 — .*B002\.01\.02/);
    expect(ok.text).toContain("Вносит новых замечаний: 0");

    const bad = await call("propose_patch", {
      session_id: sid,
      agent: "моделист",
      title: "Шаг с неверной ссылкой",
      ops: [{ op: "add", collection: "nodes", value: { id: "n1", type: "task", name: "Проверить", bpmn_scope: "o1", role_id: "нет" } }],
    });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("модель: у шага «Проверить» (n1) исполнитель «нет» не существует");
    expect(bad.text).toContain("Предложение не сохранено");

    const op = await call("propose_patch", { session_id: sid, agent: "моделист", title: "Плохая операция", ops: [{ op: "update", collection: "nodes", id: "нет", patch: { name: "Х" } }] });
    expect(op.text).toContain("операция 1: шаг «нет» не найден(а)");
    await close();
  });

  it("list_proposals и get_proposal: статус и причина отказа видны агенту", async () => {
    const { call, close } = await connect(api);
    const created = await call("propose_patch", {
      session_id: sid,
      agent: "моделист",
      title: "Добавить шаг проверки",
      ops: [{ op: "add", collection: "nodes", value: { id: "n7", type: "task", name: "Проверить реестр", bpmn_scope: "o1", role_id: "r2" } }],
    });
    const id = /prop_\w+/.exec(created.text)![0];
    const pending = await call("list_proposals", { session_id: sid, status: "pending" });
    expect(pending.text).toContain(`${id} — «Добавить шаг проверки» (моделист), ожидает решения`);

    await app.call("POST", `/proposals/${id}/resolve`, { status: "rejected", reason: "Такой шаг уже есть: B002.01.01/001" });
    const one = await call("get_proposal", { proposal_id: id });
    expect(one.text).toContain("отклонено");
    expect(one.text).toContain("Причина отказа: Такой шаг уже есть: B002.01.01/001");
    expect((await call("list_proposals", { session_id: sid, status: "rejected" })).text).toContain(id);
    expect((await call("get_proposal", { proposal_id: "нет" })).isError).toBe(true);
    await close();
  });

  it("нет доступа (401) — подсказка про токен", async () => {
    const denied: AgentApi = { get: async () => ({ status: 401, body: { error: "требуется вход" } }), post: async () => ({ status: 401, body: { error: "требуется вход" } }) };
    const { call, close } = await connect(denied);
    const r = await call("list_sessions");
    expect(r.isError).toBe(true);
    expect(r.text).toContain("PM_AGENT_TOKEN");
    await close();
  });
});

describe("конспект модели", () => {
  it("лишних замечаний не показывает, когда их нет, и показывает пулы и сообщения", () => {
    const m = structuredModel();
    const view: ModelView = {
      processCode: "B002.00.00",
      updatedAt: "t",
      codes: { o1: "B002.01.01" },
      issues: [],
      model: { ...(m as any), pools: [{ id: "x1", name: "Другой процесс", code: "B002.02.01" }], messages: [{ id: "m1", from: "b2", to: "x1", name: "Запрос" }] },
    };
    const t = outline(view);
    expect(t).toContain("Замечания проверок: 0");
    expect(t).toContain("[x1] B002.02.01 Другой процесс");
    expect(t).toContain("сообщение [m1] b2 → x1 «Запрос»");
  });
});
