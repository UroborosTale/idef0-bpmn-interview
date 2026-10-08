import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApp } from "./api.js";
import { createAgentServer, type AgentApi } from "../src/mcp/server.js";

delete process.env.AUTH_USERS;

/** Агент глазами Cline: вызывает инструменты MCP-сервера, который ходит в то же приложение, что и студия. */
async function agent(api: AgentApi) {
  const server = createAgentServer(api);
  const client = new Client({ name: "rehearsal", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { text: r.content.map((c) => c.text).join("\n"), isError: !!r.isError };
  };
  return { call, close: () => client.close() };
}

describe("репетиция: интервью → вопросы → ответы → моделист → отчёт аналитика", () => {
  let app: Awaited<ReturnType<typeof startApp>>;
  let id: string;
  beforeAll(async () => {
    app = await startApp();
    id = (await app.call("POST", "/sessions", { mode: "B", meta: { processName: "Согласование договора", modelType: "AS-IS", decompositionDepth: 2, notations: ["BPMN"] } })).body.id;
    await app.call("POST", `/sessions/${id}/interview/start`);
    // владелец рассказывает процесс — модель появляется, и у агентов есть с чем работать
    expect((await app.call("POST", `/sessions/${id}/interview/turn`, { text: "Юрист проверяет договор, затем директор подписывает его." })).status).toBe(200);
  });
  afterAll(() => app.close());

  it("цепочка ролей проходит целиком, и каждый шаг виден тому, кому он адресован", async () => {
    const api: AgentApi = { get: (p) => app.call("GET", p), post: (p, b) => app.call("POST", p, b) };
    const cline = await agent(api);

    // 1. аналитик ставит задание интервьюеру
    const task = (await app.call("POST", `/sessions/${id}/tasks`, { text: "Подготовь вопросы к следующему интервью", agent: "интервьюер" })).body;
    const open = await cline.call("get_tasks", { session_id: id });
    expect(open.text).toContain(task.id);
    expect((await cline.call("take_task", { task_id: task.id, agent: "интервьюер" })).isError).toBe(false);

    // 2. интервьюер сохраняет вопросы; повтор отбрасывается
    const asked = await cline.call("add_questions", {
      session_id: id,
      agent: "интервьюер",
      task_id: task.id,
      questions: [
        { text: "Кто заменяет директора, если он в отпуске?", addressee: "Секретарь", reason: "нет заместителя в модели", priority: "critical" },
        { text: "Сколько дней занимает проверка договора?", addressee: "Юрист", priority: "important" },
      ],
    });
    expect(asked.text).toContain("Сохранено вопросов: 2");
    expect((await cline.call("add_questions", { session_id: id, agent: "интервьюер", questions: [{ text: "сколько дней занимает проверка договора" }] })).text).toContain("Уже были");
    expect((await cline.call("complete_task", { task_id: task.id, note: "2 вопроса сохранены" })).isError).toBe(false);

    // 3. аналитик ведёт интервью: задаёт свой вопрос, владелец отвечает, один из вопросов агента отмечен отвеченным вручную
    const own = await app.call("POST", `/sessions/${id}/interview/ask`, { text: "Кто готовит договор до проверки юристом?" });
    expect(own.status).toBe(200);
    expect((await app.call("POST", `/sessions/${id}/interview/turn`, { text: "Договор готовит менеджер по продажам." })).status).toBe(200);
    const list = (await app.call("GET", `/sessions/${id}/agent-questions`)).body as { id: string; text: string; status: string; answer: string | null }[];
    expect(list.find((q) => q.text.startsWith("Кто готовит договор"))).toMatchObject({ status: "answered", answer: "Договор готовит менеджер по продажам." });
    const vacation = list.find((q) => q.text.startsWith("Кто заменяет директора"))!;
    expect((await app.call("POST", `/agent-questions/${vacation.id}/status`, { status: "answered", answer: "Заместитель директора" })).status).toBe(200);

    // 4. завершение интервью само ставит моделисту задание с обоими ответами
    expect((await app.call("POST", `/sessions/${id}/interview/finish`)).status).toBe(200);
    const handoff = (await cline.call("get_tasks", { session_id: id })).text;
    const tid = /task_[a-z0-9]+/.exec(handoff)![0];
    expect(handoff).toContain("адресовано: моделист");
    expect(handoff).toContain("Договор готовит менеджер по продажам.");
    expect(handoff).toContain("Заместитель директора");
    expect((await cline.call("list_questions", { session_id: id, status: "answered" })).text).toContain(`Передано моделисту: ${tid}`);
    // второй раз передавать нечего
    expect((await app.call("POST", `/sessions/${id}/agent-questions/handoff`, {})).status).toBe(409);

    // 5. моделист берёт задание и отвечает предложением по задаче
    expect((await cline.call("take_task", { task_id: tid, agent: "моделист" })).isError).toBe(false);
    const proposal = await cline.call("propose_patch", { session_id: id, agent: "моделист", task_id: tid, title: "Цель процесса по интервью", rationale: "Ответы владельца", ops: [{ op: "set_process", patch: { goal: "Согласовать договор до подписания" } }] });
    expect(proposal.isError).toBe(false);
    expect((await cline.call("complete_task", { task_id: tid, note: "Предложена цель процесса" })).isError).toBe(false);

    // 6. аналитик-агент сохраняет отчёт; студия превращает вывод в задание моделисту
    const report = await cline.call("add_report", {
      session_id: id,
      agent: "аналитик",
      title: "Узкие места согласования",
      summary: "Основное время уходит на ожидание подписи директора",
      findings: [{ what: "Договор ждёт подписи директора", basis: "в интервью: «директор подписывает»", impact: "high", confidence: "low", recommendation: "Назначить заместителя" }],
    });
    expect(report.isError).toBe(false);
    const rid = /rep_[a-z0-9]+/.exec(report.text)![0];
    expect((await cline.call("get_report", { report_id: rid })).text).toContain("Назначить заместителя");
    const assigned = await app.call("POST", `/sessions/${id}/tasks`, { text: `По отчёту «Узкие места согласования» (${rid}) доработай модель: договор ждёт подписи директора`, agent: "моделист" });
    expect(assigned.status).toBe(201);
    expect((await cline.call("get_tasks", { session_id: id })).text).toContain(rid);

    // итоговое состояние: задания закрыты, предложение ждёт решения, отчёт новый
    expect((await cline.call("get_tasks", { session_id: id, status: "done" })).text).toContain("Подготовь вопросы к следующему интервью");
    expect((await cline.call("list_proposals", { session_id: id, status: "pending" })).text).toContain("Цель процесса по интервью");
    expect((await cline.call("list_reports", { session_id: id, status: "new" })).text).toContain(rid);
    await cline.close();
  });
});