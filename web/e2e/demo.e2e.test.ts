import { mkdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "playwright";
import { c025Model } from "../../server/src/reference/c025";
import { WEB, api, launch, openContext } from "./env";

let browser: Browser;
beforeAll(async () => {
  browser = await launch();
});
afterAll(async () => {
  await browser?.close();
});

describe("процесс C025 по документу «ДПО от 05.10» в студии", () => {
  it("дерево по кодам в порядке документа; диаграммы с дорожками ELMA365, уведомлениями и свёрнутым пулом", async () => {
    const created = await api<{ id: string; updatedAt: string }>("POST", "/sessions/blank", { meta: { processName: "C025" } });
    const id = created.body.id;
    expect((await api("PUT", `/sessions/${id}/model`, c025Model(), { "X-Base-Updated-At": created.body.updatedAt })).status).toBe(200);

    const { ctx, page, errors } = await openContext(browser);
    await page.goto(`${WEB}/s/${id}`);
    await page.locator(".studio").waitFor();

    // дерево: группа → процесс → подпроцессы → операции → диаграммы, в порядке документа
    expect(await page.locator("[data-nav-group] .nav-name").innerText()).toContain("Организация дополнительного профессионального обучения");
    expect(await page.locator("[data-nav-process] .nav-code").innerText()).toBe("C025.00.00");
    expect(await page.locator("[data-nav-fn] .nav-code").allTextContents()).toEqual(["C025.01.00", "C025.01.01", "C025.01.02", "C025.01.03", "C025.02.00", "C025.02.01", "C025.02.02"]);
    expect(await page.locator("[data-nav-bpmn]").count()).toBe(5);
    expect(await page.locator(".nav-num, [data-nav-a0]").count()).toBe(0);
    // проверки показывают только настоящие пробелы документа: ошибок нет
    expect(await page.locator(".statusbar").innerText()).toMatch(/ошибок: 0/);

    const shot = process.env.E2E_SHOTS;
    if (shot) {
      mkdirSync(shot, { recursive: true });
      await page.locator(".nav").screenshot({ path: `${shot}/c025-nav.png` });
    }

    // C025.01.02: четыре дорожки (ELMA365 и три согласующих), уведомления о согласовании
    await page.locator('[data-nav-bpmn="o12"]').click();
    await page.locator('.studio g[data-node-id="o12_dec3"]').waitFor();
    expect(await page.locator(".studio [data-lane-id]").count()).toBeGreaterThanOrEqual(4);
    if (shot) await page.locator(".bpe-canvas").first().screenshot({ path: `${shot}/c025-o12.png` });

    // C025.01.03: свёрнутый пул «Поиск программы и внесение в список» и четыре потока сообщений
    await page.locator('[data-nav-bpmn="o13"]').click();
    await page.locator('.studio g[data-node-id="o13_search"]').waitFor();
    expect(await page.locator("[data-pool-id]").textContent()).toContain("Поиск программы и внесение в список");
    if (shot) await page.locator(".bpe-canvas").first().screenshot({ path: `${shot}/c025-o13.png` });

    // C025.01.01: два начала, слияние, ELMA365 выдаёт список направлений
    await page.locator('[data-nav-bpmn="o11"]').click();
    await page.locator('.studio g[data-node-id="o11_list"]').waitFor();
    if (shot) await page.locator(".bpe-canvas").first().screenshot({ path: `${shot}/c025-o11.png` });
    expect(errors).toEqual([]);
    await ctx.close();
  });
});