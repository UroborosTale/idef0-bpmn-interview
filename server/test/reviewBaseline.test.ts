import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApp } from "./api.js";
import { analyzeImpact } from "../src/pipeline/impactAnalysis.js";
import { emptyModel } from "../src/types/model.js";

delete process.env.AUTH_USERS;

let app: Awaited<ReturnType<typeof startApp>>;
beforeAll(async () => {
  app = await startApp();
});
afterAll(() => app.close());

/**
 * B13 из отчёта 19.10: при согласовании первой версии базой сравнения была пустая версия 0.1 —
 * «изменёнными» оказывались все шаги, а регламент «устаревал» целиком.
 */
describe("база сравнения при согласовании (B13)", () => {
  it("без утверждённых версий база — текущий снимок, изменений нет", async () => {
    const s = await app.call("POST", "/sessions/blank", { meta: { processName: "Первый процесс" } });
    const model = (await app.call("GET", `/sessions/${s.body.id}`)).body.model;
    model.nodes.push({ id: "n1", type: "task", name: "Согласовать заявку", role_id: null, source: [], inputs: [], outputs: [], controls: [], system_ids: [] });
    expect((await app.call("PUT", `/sessions/${s.body.id}/model`, model)).status).toBe(200);

    const review = await app.call("POST", `/sessions/${s.body.id}/review/start`, {});
    expect(review.status).toBe(200);
    expect(review.body.impactReport.changedNodeNames).toEqual([]);
    expect(review.body.impactReport.changedElementIds).toEqual([]);
    expect(review.body.impactReport.affectedRoles).toEqual([]);
  });

  it("система, заведённая ролью, не попадает в затронутые роли", () => {
    const before = emptyModel({ id: "p", name: "Закупки" });
    const after = emptyModel({ id: "p", name: "Закупки" });
    after.roles.push({ id: "r2", name: "ERP «Закупки»", kind: "internal", source: [] } as never);
    after.systems.push({ id: "s1", name: "ERP «Закупки»", source: [] } as never);
    after.nodes.push({ id: "n1", type: "task", name: "Проверить", role_id: "r2", source: [], inputs: [], outputs: [], controls: [], system_ids: [] } as never);
    const report = analyzeImpact(before, after, []);
    expect(report.affectedRoles).toEqual([]);
  });
});
