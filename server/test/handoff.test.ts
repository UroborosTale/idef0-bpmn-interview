import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApp } from "./api.js";
import { structuredModel } from "./fixtures.js";

delete process.env.AUTH_USERS;

describe("передача ответов интервью моделисту", () => {
  let app: Awaited<ReturnType<typeof startApp>>;
  let id: string;
  let code: string;
  const add = async (text: string, scope?: string) => (await app.call("POST", `/agent/sessions/${id}/questions`, { agent: "интервьюер", questions: [{ text, ...(scope ? { scope } : {}) }] })).body.added[0].id as string;
  const answer = (qid: string, text: string, fragment_id?: string) => app.call("POST", `/agent-questions/${qid}/status`, { status: "answered", answer: text, ...(fragment_id ? { fragment_id } : {}) });
  const tasks = async () => (await app.call("GET", `/sessions/${id}/tasks`)).body as { id: string; text: string; agent: string; scopeNodeId: string | null; createdBy: string }[];

  beforeAll(async () => {
    app = await startApp();
    id = (await app.call("POST", "/sessions/blank", { meta: { processName: "Передача" } })).body.id;
    await app.call("PUT", `/sessions/${id}/model`, structuredModel());
    code = (await app.call("GET", `/agent/sessions/${id}/model`)).body.codes.o2;
  });
  afterAll(() => app.close());

  it("нет ответов — передавать нечего", async () => {
    expect((await app.call("POST", `/sessions/${id}/agent-questions/handoff`, {})).status).toBe(409);
    await add("Вопрос без ответа про сроки?");
    expect((await app.call("POST", `/sessions/${id}/agent-questions/handoff`, {})).status).toBe(409);
    expect((await app.call("POST", "/sessions/нет/agent-questions/handoff", {})).status).toBe(404);
  });

  it("задание моделисту: вопросы, ответы и коды; ответы про одну функцию привязывают задание к ней; повторно не передаётся", async () => {
    const q1 = await add("Кто подписывает акт приёмки?", code);
    const q2 = await add("Сколько дней на приёмку?", code);
    expect((await answer(q1, "Начальник склада")).status).toBe(200);
    expect((await answer(q2, "Три дня")).status).toBe(200);
    const r = await app.call("POST", `/sessions/${id}/agent-questions/handoff`, {});
    expect(r.status).toBe(201);
    expect(r.body.count).toBe(2);
    expect(r.body.task).toMatchObject({ agent: "моделист", scopeNodeId: "o2", status: "open" });
    expect(r.body.task.text).toContain(`[${code}] Кто подписывает акт приёмки? — «Начальник склада»`);
    expect(r.body.task.text).toContain("«Три дня»");
    const stored = (await app.call("GET", `/sessions/${id}/agent-questions`)).body as { id: string; handoffTaskId: string | null }[];
    expect(stored.filter((q) => q.id === q1 || q.id === q2).every((q) => q.handoffTaskId === r.body.task.id)).toBe(true);
    expect((await app.call("POST", `/sessions/${id}/agent-questions/handoff`, {})).status).toBe(409);
  });

  it("ответы по разным функциям — задание ко всему процессу; ответ устно без текста тоже передаётся", async () => {
    const a = await add("Кто ведёт реестр договоров?", code);
    const b = await add("Где хранятся оригиналы?");
    await answer(a, "Юрист");
    await app.call("POST", `/agent-questions/${b}/status`, { status: "answered" });
    const r = await app.call("POST", `/sessions/${id}/agent-questions/handoff`, {});
    expect(r.body.task.scopeNodeId).toBeNull();
    expect(r.body.task.text).toContain("процесс в целом");
    expect(r.body.task.text).toContain("ответ дан устно");
  });

  it("вопрос, возвращённый в работу, теряет отметку передачи и после нового ответа передаётся снова", async () => {
    const q = await add("Как часто обновляется реестр?");
    await answer(q, "Раз в месяц");
    const first = await app.call("POST", `/sessions/${id}/agent-questions/handoff`, {});
    expect(first.status).toBe(201);
    await app.call("POST", `/agent-questions/${q}/status`, { status: "open" });
    expect(((await app.call("GET", `/sessions/${id}/agent-questions`)).body as any[]).find((x) => x.id === q).handoffTaskId).toBeNull();
    await answer(q, "Раз в неделю");
    const second = await app.call("POST", `/sessions/${id}/agent-questions/handoff`, {});
    expect(second.body.task.text).toContain("Раз в неделю");
    expect(second.body.task.id).not.toBe(first.body.task.id);
  });

  it("длинный список не выходит за лимит текста задания и отсылает к list_questions", async () => {
    const s = (await app.call("POST", "/sessions/blank", { meta: { processName: "Длинный" } })).body.id;
    await app.call("PUT", `/sessions/${s}/model`, structuredModel());
    for (let i = 0; i < 20; i++) {
      const qid = (await app.call("POST", `/agent/sessions/${s}/questions`, { agent: "интервьюер", questions: [{ text: `Вопрос номер ${i + 1}: ${"подробно ".repeat(12)}?` }] })).body.added[0].id;
      await app.call("POST", `/agent-questions/${qid}/status`, { status: "answered", answer: "ответ ".repeat(40) });
    }
    const r = await app.call("POST", `/sessions/${s}/agent-questions/handoff`, {});
    expect(r.body.count).toBe(20);
    expect(r.body.task.text.length).toBeLessThanOrEqual(2000);
    expect(r.body.task.text).toMatch(/и ещё \d+ — list_questions/);
  });
});