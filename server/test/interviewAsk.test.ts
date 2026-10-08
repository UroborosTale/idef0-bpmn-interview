import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApp } from "./api.js";

delete process.env.AUTH_USERS;

describe("интервью: свой вопрос интервьюера", () => {
  let app: Awaited<ReturnType<typeof startApp>>;
  let id: string;
  beforeAll(async () => {
    app = await startApp();
    id = (await app.call("POST", "/sessions", { mode: "B", meta: { processName: "Закупка", modelType: "AS-IS", decompositionDepth: 2, notations: ["BPMN"] } })).body.id;
  });
  afterAll(() => app.close());

  it("до начала интервью и после его завершения вопрос не принимается; короткий текст — ошибка", async () => {
    expect((await app.call("POST", `/sessions/${id}/interview/ask`, { text: "Кто согласует заявку?" })).status).toBe(409);
    await app.call("POST", `/sessions/${id}/interview/start`);
    expect((await app.call("POST", `/sessions/${id}/interview/ask`, { text: "к" })).status).toBe(400);
    expect((await app.call("POST", "/sessions/нет/interview/ask", { text: "Кто согласует заявку?" })).status).toBe(404);
  });

  it("вопрос появляется в чате от интервьюера, сохраняется в списке как «задан», а ответ владельца отмечает его полученным", async () => {
    const asked = await app.call("POST", `/sessions/${id}/interview/ask`, { text: "Кто заменяет директора в отпуске?", addressee: "Секретарь" });
    expect(asked.status).toBe(200);
    const last = asked.body.chat.at(-1);
    expect(last).toMatchObject({ role: "assistant", text: "Кто заменяет директора в отпуске?", author: "local" }); // без входа в систему логин — local
    expect(last.question_id).toMatch(/^q_/);
    const stored = (await app.call("GET", `/agent/sessions/${id}/questions`)).body;
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ id: last.question_id, status: "asked", addressee: "Секретарь", agent: "user:local" });

    // владелец отвечает: следующий вопрос системы не обязателен, главное — ответ привязан к вопросу и фрагменту
    const turn = await app.call("POST", `/sessions/${id}/interview/turn`, { text: "Заместитель директора" });
    expect(turn.status).toBe(200);
    const answered = (await app.call("GET", `/agent/sessions/${id}/questions`)).body[0];
    const fragment = turn.body.fragments.at(-1);
    expect(answered).toMatchObject({ status: "answered", answer: "Заместитель директора", fragmentId: fragment.id });
  });

  it("вопрос из списка (подготовлен агентом) при том же тексте становится заданным и не дублируется", async () => {
    const prepared = (await app.call("POST", `/agent/sessions/${id}/questions`, { agent: "интервьюер", questions: [{ text: "Сколько дней занимает согласование?" }] })).body.added[0];
    const asked = await app.call("POST", `/sessions/${id}/interview/ask`, { text: "сколько дней занимает согласование" });
    expect(asked.body.chat.at(-1).question_id).toBe(prepared.id);
    const list = (await app.call("GET", `/agent/sessions/${id}/questions`)).body;
    expect(list.filter((x: any) => x.text.startsWith("Сколько дней"))).toHaveLength(1);
    expect(list.find((x: any) => x.id === prepared.id).status).toBe("asked");
  });

  it("после завершения интервью вопрос не принимается", async () => {
    await app.call("POST", `/sessions/${id}/interview/finish`);
    expect((await app.call("POST", `/sessions/${id}/interview/ask`, { text: "Ещё один вопрос после конца?" })).status).toBe(409);
  });
});