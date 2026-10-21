import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApp } from "./api.js";

delete process.env.AUTH_USERS;

let app: Awaited<ReturnType<typeof startApp>>;
beforeAll(async () => {
  app = await startApp();
});
afterAll(() => app.close());

/** B15: реестр должен подхватывать уже созданные сессии и не плодить дубли при повторном импорте. */
describe("реестр из сессий", () => {
  it("добавляет процесс сессии, связывает его и обновляет без дубля", async () => {
    const s = (await app.call("POST", "/sessions/blank", { meta: { processName: "Процесс B15", code: "B915.00.00" } })).body;
    const first = await app.call("POST", "/registry/import-sessions", {});
    expect(first.status).toBe(200);
    expect(first.body.created).toBeGreaterThan(0);
    const rows = (await app.call("GET", "/registry")).body as { name: string; session_id: string | null }[];
    const linked = rows.find((r) => r.name === "Процесс B15");
    expect(linked).toMatchObject({ session_id: s.id });

    const second = await app.call("POST", "/registry/import-sessions", {});
    expect(second.status).toBe(200);
    expect(second.body.created).toBe(0);
    const again = (await app.call("GET", "/registry")).body.filter((r: { name: string }) => r.name === "Процесс B15");
    expect(again).toHaveLength(1);
  });
});
