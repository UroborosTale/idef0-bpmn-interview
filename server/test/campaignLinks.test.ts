import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApp } from "./api.js";

delete process.env.AUTH_USERS;

let app: Awaited<ReturnType<typeof startApp>>;
beforeAll(async () => {
  app = await startApp();
});
afterAll(() => app.close());

/**
 * B16 из отчёта 19.10: ссылка респондента строилась от адреса аналитика (localhost). PUBLIC_URL задаёт внешний
 * адрес приложения, по которому ссылку откроют с другого компьютера.
 */
describe("ссылки респондентов", () => {
  it("учитывают PUBLIC_URL и в создании кампании, и в статусе", async () => {
    process.env.PUBLIC_URL = "http://10.0.0.5:8787/";
    try {
      const s = await app.call("POST", "/sessions", { meta: { processName: "Ссылки" } });
      const created = await app.call("POST", `/sessions/${s.body.id}/campaigns`, {
        name: "Кампания",
        respondents: [{ name: "Респондент" }],
      });
      expect(created.status).toBe(201);
      const link = created.body.respondents[0].link as string;
      expect(link).toMatch(/^http:\/\/10\.0\.0\.5:8787\/campaign\/camp_/);

      const status = await app.call("GET", `/campaigns/${created.body.campaign.id}`);
      expect(status.body.respondents[0].link).toBe(link);
    } finally {
      delete process.env.PUBLIC_URL;
    }
  });
});
