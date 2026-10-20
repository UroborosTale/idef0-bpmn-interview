import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApp } from "./api.js";

delete process.env.AUTH_USERS;

let app: Awaited<ReturnType<typeof startApp>>;
beforeAll(async () => {
  app = await startApp();
});
afterAll(() => app.close());

/**
 * B10 из отчёта 19.10: три сохранения за секунду давали v0.3, v0.4, v0.5.
 * Повторное сохранение без изменений не должно добавлять снимок.
 */
describe("версии при повторном сохранении", () => {
  it("одинаковая модель не создаёт новую версию, изменённая — создаёт", async () => {
    const created = await app.call("POST", "/sessions/blank", { meta: { processName: "Версии" } });
    const id = created.body.id;
    const count = async () => (await app.call("GET", `/sessions/${id}/versions`)).body.length;

    // первое сохранение пересчитывает пробелы — это законная новая версия
    await app.call("PUT", `/sessions/${id}/model`, created.body.model);
    const afterFirst = await count();

    const same = (await app.call("GET", `/sessions/${id}`)).body.model;
    await app.call("PUT", `/sessions/${id}/model`, same);
    await app.call("PUT", `/sessions/${id}/model`, (await app.call("GET", `/sessions/${id}`)).body.model);
    expect(await count()).toBe(afterFirst);

    const changed = (await app.call("GET", `/sessions/${id}`)).body.model;
    changed.process.goal = "Проверить версии";
    await app.call("PUT", `/sessions/${id}/model`, changed);
    expect(await count()).toBe(afterFirst + 1);
  });
});
