import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApp } from "./api.js";

delete process.env.AUTH_USERS;

let app: Awaited<ReturnType<typeof startApp>>;
beforeAll(async () => {
  app = await startApp();
});
afterAll(() => app.close());

describe("сессия «рисовать с нуля»", () => {
  it("создаётся сразу готовой: пустая модель, диаграммы, первая версия, без LLM", async () => {
    const r = await app.call("POST", "/sessions/blank", { meta: { processName: "Найм сотрудника", owner: "HR", modelType: "TO-BE" } });
    expect(r.status).toBe(201);
    const s = r.body;
    expect(s.status).toBe("ready");
    expect(s.provider).toBeNull();
    expect(s.mode).toBe("blank"); // режим Г — не «обработка текста»: в списке у сессии своя отметка, вкладки «Текст» нет
    expect(s.model.process).toMatchObject({ name: "Найм сотрудника", owner: "HR", type: "TO-BE" });
    expect(s.model.nodes).toEqual([]);
    expect(s.bpmnXml).toContain("<bpmn:definitions");
    expect(s.diagramsStale).toBe(false);
    expect(s.versions.map((v: { note: string }) => v.note)).toEqual(["Пустая модель"]);
  });

  it("модель можно сразу править и сохранять как обычную", async () => {
    const s = (await app.call("POST", "/sessions/blank", { meta: { processName: "Найм" } })).body;
    const model = s.model;
    model.nodes.push({ id: "n1", type: "task", name: "Опубликовать вакансию", status: "confirmed", confidence: 1 });
    const put = await app.call("PUT", `/sessions/${s.id}/model`, model, { "X-Base-Updated-At": s.updatedAt });
    expect(put.status).toBe(200);
    expect(put.body.model.nodes).toHaveLength(1);
    expect((await app.call("POST", `/sessions/${s.id}/rebuild-diagrams`)).status).toBe(200);
  });

  it("код процесса из формы попадает в модель: по нему нумеруются функции и шаги", async () => {
    const s = (await app.call("POST", "/sessions/blank", { meta: { processName: "Найм сотрудника", code: "B002.00.00" } })).body;
    expect(s.model.process.code).toBe("B002.00.00");
    // без кода поле пустое — модель без номера процесса
    const t = (await app.call("POST", "/sessions/blank", { meta: { processName: "Найм без кода" } })).body;
    expect(t.model.process.code ?? null).toBeNull();
  });

  it("без названия — 400", async () => {
    expect((await app.call("POST", "/sessions/blank", { meta: { processName: "  " } })).status).toBe(400);
    expect((await app.call("POST", "/sessions/blank", {})).status).toBe(400);
  });
});