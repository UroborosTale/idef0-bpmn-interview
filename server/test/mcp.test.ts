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
    expect(tools).toEqual(["add_questions", "add_report", "complete_task", "create_task", "get_conventions", "get_fragments", "get_model", "get_proposal", "get_report", "get_tasks", "list_proposals", "list_questions", "list_reports", "list_sessions", "propose_patch", "take_task"]);
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

  it("get_fragments: страницы текста интервью с id для цитат", async () => {
    const s = (await app.call("POST", "/sessions/blank", { meta: { processName: "Интервью" } })).body;
    await app.call("POST", `/sessions/${s.id}/ingest-text`, { text: "Специалист открывает реестр.\n\nПотом вносит код процесса." });
    const { call, close } = await connect(api);
    const first = await call("get_fragments", { session_id: s.id });
    expect(first.isError).toBe(false);
    expect(first.text).toMatch(/\[[^\]]+\] \([^)]+\): Специалист открывает реестр/);
    expect(first.text).toMatch(/Фрагменты 1–\d+ из \d+/);
    const empty = await call("get_fragments", { session_id: s.id, from: 50 });
    expect(empty.text).toContain("Фрагментов нет");
    expect((await call("get_fragments", { session_id: "нет" })).isError).toBe(true);
    await close();
  });

  it("задания: get_tasks → take_task → propose_patch с task_id → complete_task; аналитик видит итог", async () => {
    const t = (await app.call("POST", `/sessions/${sid}/tasks`, { text: "Назначь исполнителя операции B002.01.02", scope: "o2" })).body.id as string;
    const { call, close } = await connect(api);
    const open = await call("get_tasks", { session_id: sid });
    expect(open.text).toContain(`${t} — «Назначь исполнителя операции B002.01.02» (функция o2) — ждёт агента`);

    const taken = await call("take_task", { task_id: t, agent: "нормоконтролёр" });
    expect(taken.text).toContain("Задание взято в работу");
    expect((await call("take_task", { task_id: t, agent: "другой" })).isError).toBe(true);

    const prop = await call("propose_patch", {
      session_id: sid,
      agent: "нормоконтролёр",
      title: "Исполнитель B002.01.02",
      task_id: t,
      ops: [{ op: "set_assignments", node_id: "o2", items: [{ role_id: "r2", kind: "executor" }] }],
    });
    expect(prop.isError).toBe(false);
    const done = await call("complete_task", { task_id: t, note: "Назначен специалист; проверьте функции роли" });
    expect(done.text).toContain("Итог: Назначен специалист");
    expect(done.text).toMatch(/предложение prop_\w+: «Исполнитель B002\.01\.02» — ожидает решения/);
    expect((await call("get_tasks", { session_id: sid })).text).not.toContain(t);
    expect((await call("get_tasks", { session_id: sid, status: "done" })).text).toContain(t);
    // задание закрыто — новые предложения по нему не принимаются
    const late = await call("propose_patch", { session_id: sid, agent: "x", title: "Ещё", task_id: t, ops: [{ op: "set_process", patch: { owner: "Х" } }] });
    expect(late.isError).toBe(true);
    expect(late.text).toContain("уже выполнено");
    await close();
  });
  it("create_task: нормоконтролёр поручает моделисту; задание видно аналитику с автором", async () => {
    const { call, close } = await connect(api);
    const r = await call("create_task", { session_id: sid, text: "Доработать B002.01.01: события названы существительными", for_agent: "моделист", from_agent: "нормоконтролёр", scope: "o1" });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/task_\w+ — «Доработать B002\.01\.01.*» \(функция o1\), адресовано: моделист, от агента нормоконтролёр — ждёт агента/);
    const tid = /task_\w+/.exec(r.text)![0];
    const list = (await app.call("GET", `/sessions/${sid}/tasks`)).body.find((t: any) => t.id === tid);
    expect(list).toMatchObject({ createdBy: "agent:нормоконтролёр", agent: "моделист", status: "open" });
    expect((await call("create_task", { session_id: sid, text: "Х", for_agent: "моделист", from_agent: "нормоконтролёр", scope: "нет-такой" })).isError).toBe(true);
    expect((await call("get_tasks", { session_id: sid })).text).toContain("от агента нормоконтролёр");
    await app.call("POST", `/tasks/${tid}/cancel`);
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

  it("вопросы и отчёты: сохранить, увидеть повтор и статус, прочитать целиком; ошибки формата понятны", async () => {
    const { call, close } = await connect(api);
    const added = await call("add_questions", {
      session_id: sid,
      agent: "интервьюер",
      questions: [{ text: "Кто утверждает реестр процессов?", addressee: "Начальник отдела", reason: "нет владельца", priority: "critical" }, { text: "Как часто обновляется реестр?" }],
    });
    expect(added.isError).toBe(false);
    expect(added.text).toContain("Сохранено вопросов: 2");
    expect(added.text).toContain("[критично] «Кто утверждает реестр процессов?»");
    const repeat = await call("add_questions", { session_id: sid, agent: "интервьюер", questions: [{ text: "кто утверждает реестр процессов" }] });
    expect(repeat.text).toContain("Сохранено вопросов: 0");
    expect(repeat.text).toContain("Уже были");
    expect((await call("list_questions", { session_id: sid, status: "open" })).text).toContain("Как часто обновляется реестр?");
    expect((await call("list_questions", { session_id: sid, status: "answered" })).text).toBe("Вопросов нет.");
    const badScope = await call("add_questions", { session_id: sid, agent: "интервьюер", questions: [{ text: "Вопрос про чужую функцию?", scope: "B999.99.99" }] });
    expect(badScope.isError).toBe(true);
    expect(badScope.text).toContain("B999.99.99");

    const rep = await call("add_report", {
      session_id: sid,
      agent: "аналитик",
      title: "Узкие места реестра",
      summary: "Основное время уходит на ожидание",
      body: "# Подробности\nТекст",
      findings: [{ what: "Ожидание подписи", where: "B002.01.01", impact: "high", confidence: "medium", recommendation: "Ввести срок" }],
    });
    expect(rep.isError).toBe(false);
    const rid = /rep_[a-z0-9]+/.exec(rep.text)![0];
    expect(rep.text).toContain("выводов: 1");
    const listed = await call("list_reports", { session_id: sid });
    expect(listed.text).toContain(rid);
    expect(listed.text).toContain("get_report"); // подсказка, что есть полный текст
    expect(listed.text).not.toContain("Подробности");
    const full = await call("get_report", { report_id: rid });
    expect(full.text).toContain("1. [высокое] Ожидание подписи — где: B002.01.01 — уверенность: среднее — рекомендация: Ввести срок");
    expect(full.text).toContain("# Подробности");
    const empty = await call("add_report", { session_id: sid, agent: "аналитик", title: "Пустой отчёт" });
    expect(empty.isError).toBe(true);
    expect((await call("get_report", { report_id: "rep_нет" })).isError).toBe(true);
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
