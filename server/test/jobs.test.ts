import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApp } from "./api.js";

delete process.env.AUTH_USERS;

let app: Awaited<ReturnType<typeof startApp>>;
beforeAll(async () => {
  app = await startApp();
});
afterAll(() => app.close());

const TEXT = `Владелец: Менеджер получает заявку от клиента и регистрирует её в CRM.
Владелец: Юрист проверяет договор. Если есть замечания, юрист возвращает договор менеджеру.
Владелец: Бухгалтер регистрирует договор в 1С.`;

async function waitDone(jobId: string) {
  for (let i = 0; i < 100; i++) {
    const j = await app.call("GET", `/jobs/${jobId}`);
    if (j.body.status !== "running") return j.body;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("задача не завершилась");
}

describe("обработка — фоновая задача", () => {
  it("запуск возвращает задачу сразу, по завершении у сессии есть модель и версия", async () => {
    const s = await app.call("POST", "/sessions", { meta: { processName: "Договор" } });
    expect(s.status).toBe(201);
    await app.call("POST", `/sessions/${s.body.id}/ingest-text`, { text: TEXT });

    const run = await app.call("POST", `/sessions/${s.body.id}/run`);
    expect(run.status).toBe(202);
    expect(run.body.status).toBe("running");

    const job = await waitDone(run.body.id);
    expect(job.status).toBe("done");
    expect(job.result.nodes).toBeGreaterThan(0);

    const after = await app.call("GET", `/sessions/${s.body.id}`);
    expect(after.body.status).toBe("ready");
    expect(after.body.model.nodes.length).toBeGreaterThan(0);
    expect((await app.call("GET", `/sessions/${s.body.id}/job`)).body).toBeNull();
  });

  it("без текста обработка не запускается", async () => {
    const s = await app.call("POST", "/sessions", { meta: { processName: "Пусто" } });
    expect((await app.call("POST", `/sessions/${s.body.id}/run`)).status).toBe(400);
  });
});
