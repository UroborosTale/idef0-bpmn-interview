import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApp } from "./api.js";

delete process.env.AUTH_USERS;

let app: Awaited<ReturnType<typeof startApp>>;
beforeAll(async () => {
  app = await startApp();
});
afterAll(() => app.close());

describe("слишком большой запрос", () => {
  it("отвечает 413 и понятным сообщением по-русски, а не 500 «request entity too large»", async () => {
    const huge = "A".repeat(26 * 1024 * 1024); // больше предела тела запроса (25 МБ)
    const r = await app.call("POST", "/diagram-import/new", { format: "vsdx", content: huge, meta: { processName: "Большой" } });
    expect(r.status).toBe(413);
    expect(r.body.error).toMatch(/слишком большой/i);
    expect(r.body.error).toMatch(/МБ/);
  });

  it("повреждённый JSON — 400, а не 500", async () => {
    const res = await fetch(`${app.url}/api/diagram-import/new`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{не json" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBeTruthy();
  });

  it("обычные ошибки по-прежнему 500 с текстом ошибки", async () => {
    expect((await app.call("GET", "/health")).status).toBe(200);
  });
});
