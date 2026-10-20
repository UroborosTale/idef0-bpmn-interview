import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApp } from "./api.js";

delete process.env.AUTH_USERS;

let app: Awaited<ReturnType<typeof startApp>>;
beforeAll(async () => {
  app = await startApp();
});
afterAll(() => app.close());

/** C из отчёта 19.10: неизвестный путь API отвечал HTML-страницей Express «Cannot GET …», а не JSON. */
describe("неизвестный путь API", () => {
  it("отвечает JSON 404, а не HTML", async () => {
    const r = await app.call("GET", "/no-such-route");
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({ error: "Неизвестный метод API" });
  });
});
