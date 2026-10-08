import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApp } from "./api.js";
import { createAgentServer } from "../src/mcp/server.js";
import { structuredModel } from "./fixtures.js";

delete process.env.AUTH_USERS;

describe("конфиденциальные сессии: доступ агентов решает аналитик", () => {
  let app: Awaited<ReturnType<typeof startApp>>;
  let secret: string;
  let open: string;
  beforeAll(async () => {
    app = await startApp();
    secret = (await app.call("POST", "/sessions/blank", { meta: { processName: "Секретный процесс", confidential: true } })).body.id;
    open = (await app.call("POST", "/sessions/blank", { meta: { processName: "Обычный процесс" } })).body.id;
    for (const id of [secret, open]) await app.call("PUT", `/sessions/${id}/model`, structuredModel());
  });
  afterAll(() => app.close());

  it("в списке для агентов закрытая сессия есть, но без названия и кода; обычная видна полностью", async () => {
    const list = (await app.call("GET", "/agent/sessions")).body as { id: string; processName: string; code: string | null; blocked: boolean; confidential: boolean }[];
    const s = list.find((x) => x.id === secret)!;
    expect(s).toMatchObject({ blocked: true, confidential: true, processName: "", code: null });
    expect(JSON.stringify(s)).not.toContain("Секретный");
    expect(list.find((x) => x.id === open)).toMatchObject({ blocked: false, processName: "Обычный процесс" });
  });

  it("все ручки агента к закрытой сессии отвечают 403: модель, фрагменты, предложения, задания, вопросы, отчёты", async () => {
    const task = (await app.call("POST", `/sessions/${secret}/tasks`, { text: "Проверь названия" })).body; // аналитик работает со своей сессией как обычно
    expect(task.id).toMatch(/^task_/);
    const calls: [string, string, unknown?][] = [
      ["GET", `/agent/sessions/${secret}/model`],
      ["GET", `/agent/sessions/${secret}/fragments`],
      ["GET", `/agent/sessions/${secret}/proposals`],
      ["POST", `/agent/sessions/${secret}/proposals`, { agent: "моделист", title: "Цель", ops: [{ op: "set_process", patch: { goal: "Цель" } }] }],
      ["GET", `/agent/sessions/${secret}/tasks`],
      ["POST", `/agent/tasks/${task.id}/take`, { agent: "моделист" }],
      ["POST", `/agent/tasks/${task.id}/complete`, { note: "готово" }],
      ["GET", `/agent/sessions/${secret}/questions`],
      ["POST", `/agent/sessions/${secret}/questions`, { agent: "интервьюер", questions: [{ text: "Кто согласует заявку?" }] }],
      ["GET", `/agent/sessions/${secret}/reports`],
      ["POST", `/agent/sessions/${secret}/reports`, { agent: "аналитик", title: "Отчёт", summary: "текст" }],
    ];
    for (const [method, path, body] of calls) {
      const r = await app.call(method, path, body);
      expect(r.status, `${method} ${path}`).toBe(403);
      expect(r.body.code).toBe("confidential");
    }
    // ничего не создалось
    expect((await app.call("GET", `/sessions/${secret}/agent-questions`)).body).toEqual([]);
    expect((await app.call("GET", `/sessions/${secret}/tasks`)).body[0].status).toBe("open");
    // обычная сессия работает
    expect((await app.call("GET", `/agent/sessions/${open}/model`)).status).toBe(200);
  });

  it("инструмент list_sessions честно говорит агенту, что сессия закрыта, и не показывает её названия", async () => {
    const api = { get: (p: string) => app.call("GET", p), post: (p: string, b: unknown) => app.call("POST", p, b) };
    const server = createAgentServer(api);
    const client = new Client({ name: "t", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const text = ((await client.callTool({ name: "list_sessions", arguments: {} })) as { content: { text: string }[] }).content[0].text;
    expect(text).toContain(`${secret} — КОНФИДЕНЦИАЛЬНАЯ`);
    expect(text).not.toContain("Секретный");
    expect(text).toContain("Обычный процесс");
    const model = (await client.callTool({ name: "get_model", arguments: { session_id: secret } })) as { isError?: boolean; content: { text: string }[] };
    expect(model.isError).toBe(true);
    expect(model.content[0].text).toContain("аналитик не разрешил");
    await client.close();
  });

  it("аналитик разрешает доступ — агент работает; запретил снова — ручки закрываются", async () => {
    const meta = (await app.call("GET", `/sessions/${secret}`)).body.meta;
    expect((await app.call("PATCH", `/sessions/${secret}`, { meta: { ...meta, agentAccess: true } })).status).toBe(200);
    expect((await app.call("GET", `/agent/sessions/${secret}/model`)).status).toBe(200);
    expect(((await app.call("GET", "/agent/sessions")).body as any[]).find((x) => x.id === secret)).toMatchObject({ blocked: false, processName: "Секретный процесс" });
    expect((await app.call("POST", `/agent/sessions/${secret}/reports`, { agent: "аналитик", title: "Отчёт", summary: "текст" })).status).toBe(201);
    expect((await app.call("PATCH", `/sessions/${secret}`, { meta: { ...meta, agentAccess: false } })).status).toBe(200);
    expect((await app.call("GET", `/agent/sessions/${secret}/model`)).status).toBe(403);
  });
});

describe("лимит ожидающих предложений", () => {
  it("больше 30 ждущих решения предложений на сессию агент отправить не может; после решения аналитика — снова может", async () => {
    const app = await startApp();
    const id = (await app.call("POST", "/sessions/blank", { meta: { processName: "Лимит предложений" } })).body.id;
    await app.call("PUT", `/sessions/${id}/model`, structuredModel());
    const send = (n: number) => app.call("POST", `/agent/sessions/${id}/proposals`, { agent: "моделист", title: `Цель ${n}`, ops: [{ op: "set_process", patch: { goal: `Цель ${n}` } }] });
    const ids: string[] = [];
    for (let i = 1; i <= 30; i++) {
      const r = await send(i);
      expect(r.status, `предложение ${i}`).toBe(201);
      ids.push(r.body.id);
    }
    const over = await send(31);
    expect(over.status).toBe(429);
    expect(over.body.error).toContain("30 предложений ждут решения");
    expect((await app.call("POST", `/proposals/${ids[0]}/resolve`, { status: "rejected", reason: "Не нужно" })).status).toBe(200);
    expect((await send(32)).status).toBe(201);
    await app.close();
  }, 60_000);
});

describe("статистика работы агентов по ролям", () => {
  it("предложения, причины отказа, замечания, задания, вопросы и отчёты — по ролям без учёта регистра; по сессии и по всем", async () => {
    const app = await startApp();
    const a = (await app.call("POST", "/sessions/blank", { meta: { processName: "Статистика A" } })).body.id;
    const b = (await app.call("POST", "/sessions/blank", { meta: { processName: "Статистика B" } })).body.id;
    for (const id of [a, b]) await app.call("PUT", `/sessions/${id}/model`, structuredModel());
    const propose = async (sid: string, agent: string, n: number) => (await app.call("POST", `/agent/sessions/${sid}/proposals`, { agent, title: `П${n}`, ops: [{ op: "set_process", patch: { goal: `Цель ${n}` } }] })).body.id as string;
    const p1 = await propose(a, "моделист", 1);
    const p2 = await propose(a, " Моделист ", 2);
    const p3 = await propose(a, "моделист", 3);
    await propose(a, "моделист", 4); // останется ждать решения
    const n1 = await propose(a, "нормоконтролёр", 5);
    await propose(b, "моделист", 6); // другая сессия
    await app.call("POST", `/proposals/${p1}/resolve`, { status: "applied" });
    await app.call("POST", `/proposals/${p2}/resolve`, { status: "rejected", reason: "Нет цитаты в интервью." });
    await app.call("POST", `/proposals/${p3}/resolve`, { status: "rejected", reason: "нет цитаты  в интервью" });
    await app.call("POST", `/proposals/${n1}/resolve`, { status: "applied" });

    const task = (await app.call("POST", `/sessions/${a}/tasks`, { text: "Построй модель", agent: "моделист" })).body;
    await app.call("POST", `/agent/tasks/${task.id}/take`, { agent: "моделист" });
    await app.call("POST", `/agent/tasks/${task.id}/complete`, { note: "ok" });
    await app.call("POST", `/agent/sessions/${a}/tasks`, { text: "Проверь результат моделиста", agent: "нормоконтролёр", from: "моделист" });
    const qs = (await app.call("POST", `/agent/sessions/${a}/questions`, { agent: "интервьюер", questions: [{ text: "Кто подписывает акт?" }, { text: "Сколько дней на приёмку?" }, { text: "Где хранятся оригиналы?" }] })).body.added;
    await app.call("POST", `/agent-questions/${qs[0].id}/status`, { status: "answered", answer: "Директор" });
    await app.call("POST", `/agent-questions/${qs[1].id}/status`, { status: "dismissed" });
    await app.call("POST", `/sessions/${a}/agent-questions`, { text: "Свой вопрос аналитика?" }); // не работа агента
    await app.call("POST", `/agent/sessions/${a}/reports`, { agent: "аналитик", title: "Отчёт", findings: [{ what: "Ожидание", impact: "high", confidence: "low" }, { what: "Дубли", impact: "low", confidence: "high" }] });

    const own = (await app.call("GET", `/sessions/${a}/agent-stats`)).body as { scope: string; roles: any[] };
    expect(own.scope).toBe("session");
    const role = (name: string) => own.roles.find((r) => r.role.toLowerCase() === name)!;
    expect(own.roles[0].role.toLowerCase()).toBe("моделист"); // больше всех предложений
    expect(role("моделист").proposals).toMatchObject({ total: 4, pending: 1, applied: 1, rejected: 2, acceptance: 1 / 3 });
    expect(role("моделист").proposals.topReasons).toEqual([{ reason: "Нет цитаты в интервью", count: 2 }]);
    expect(role("моделист").proposals.introduced + role("моделист").proposals.resolved).toBeGreaterThanOrEqual(0);
    expect(role("моделист").tasks).toMatchObject({ taken: 1, done: 1, created: 1 });
    expect(role("нормоконтролёр").proposals).toMatchObject({ total: 1, applied: 1, acceptance: 1 });
    expect(role("интервьюер").questions).toEqual({ added: 3, asked: 0, answered: 1, dismissed: 1 });
    expect(role("аналитик").reports).toEqual({ total: 1, unread: 1, findings: 2, highImpact: 1 });
    expect(own.roles.some((r) => r.role.startsWith("user:"))).toBe(false);

    const all = (await app.call("GET", `/sessions/${a}/agent-stats?all=1`)).body;
    expect(all.scope).toBe("all");
    // в базе есть и другие сессии (из соседних проверок): по всем сессиям не меньше, чем по этой плюс предложение из сессии B
    expect(all.roles.find((r: any) => r.role.toLowerCase() === "моделист").proposals.total).toBeGreaterThanOrEqual(5);
    expect((await app.call("GET", "/sessions/нет/agent-stats")).status).toBe(404);
    await app.close();
  }, 60_000);
});