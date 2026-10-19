import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApp } from "./api.js";
import { b002Model } from "../src/reference/b002.js";

delete process.env.AUTH_USERS;

let app: Awaited<ReturnType<typeof startApp>>;
beforeAll(async () => {
  app = await startApp();
});
afterAll(() => app.close());

/**
 * Загрузка эталона (scripts/seed-process.ts) идёт в три шага: сессия «с нуля» → модель эталона → пересборка
 * диаграмм. Без третьего шага сессия открывается с «Пересобрать диаграммы (модель изменена)», а диаграммы
 * остаются от пустой модели — так и выглядели свежие эталоны при осмотре.
 */
describe("эталон, загруженный в сессию", () => {
  it("после пересборки диаграммы собраны из эталона и не помечены устаревшими", async () => {
    const model = b002Model();
    const created = await app.call("POST", "/sessions/blank", { meta: { processName: model.process.name } });
    expect(created.status).toBe(201);

    const put = await app.call("PUT", `/sessions/${created.body.id}/model`, model, { "X-Base-Updated-At": created.body.updatedAt });
    expect(put.status).toBe(200);
    expect(put.body.diagramsStale).toBe(true); // PUT модели всегда помечает диаграммы устаревшими — пересборка обязательна

    const rebuilt = await app.call("POST", `/sessions/${created.body.id}/rebuild-diagrams`);
    expect(rebuilt.status).toBe(200);
    expect(rebuilt.body.diagramsStale).toBe(false);
    expect(rebuilt.body.bpmnXml).toContain("<bpmn:definitions");
    expect(rebuilt.body.idef0.contextSvg).toContain("<svg");
    expect(rebuilt.body.idef0.decompositionSvg).toContain("<svg");
  });
});
