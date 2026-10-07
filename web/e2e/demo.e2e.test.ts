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

describe("демонстрационный процесс C025 в студии", () => {
  it("открывается без замечаний; дерево по кодам; диаграммы с дорожками, граничными событиями, внешним пулом", async () => {
    const created = await api<{ id: string; updatedAt: string }>("POST", "/sessions/blank", { meta: { processName: "C025" } });
    const id = created.body.id;
    expect((await api("PUT", `/sessions/${id}/model`, c025Model(), { "X-Base-Updated-At": created.body.updatedAt })).status).toBe(200);

    const { ctx, page, errors } = await openContext(browser);
    await page.goto(`${WEB}/s/${id}`);
    await page.locator(".studio").waitFor();

    // дерево: группа → процесс → подпроцессы → операции → диаграммы
    expect(await page.locator("[data-nav-group] .nav-name").innerText()).toContain("Организация дополнительного профессионального обучения");
    expect(await page.locator("[data-nav-process] .nav-code").innerText()).toBe("C025.00.00");
    expect(await page.locator("[data-nav-fn] .nav-code").allTextContents()).toEqual(["C025.01.00", "C025.01.01", "C025.01.02", "C025.01.03", "C025.02.00", "C025.02.01", "C025.02.02", "C025.03.00", "C025.03.01"]);
    expect(await page.locator("[data-nav-bpmn]").count()).toBe(6);
    expect(await page.locator(".statusbar").innerText()).toMatch(/ошибок: 0[\s\S]*предупреждений: 0/);

    const shot = process.env.E2E_SHOTS;
    if (shot) {
      mkdirSync(shot, { recursive: true });
      await page.locator(".nav").screenshot({ path: `${shot}/c025-nav.png` });
    }

    // согласование: три дорожки, прерывающее граничное событие
    await page.locator('[data-nav-bpmn="o12"]').click();
    await page.locator('.studio g[data-node-id="o12_budget"]').waitFor();
    expect(await page.locator(".studio [data-lane-id]").count()).toBeGreaterThanOrEqual(3);
    expect(await page.locator('.studio g[data-node-id="o12_late"]').count()).toBe(1);
    if (shot) await page.locator(".bpe-canvas").first().screenshot({ path: `${shot}/c025-o12.png` });

    // подтверждение программы: внешний пул и потоки сообщений
    await page.locator('[data-nav-bpmn="o13"]').click();
    await page.locator('.studio g[data-node-id="o13_send"]').waitFor();
    expect(await page.locator("[data-pool-id]").textContent()).toContain("Учебный центр");
    if (shot) await page.locator(".bpe-canvas").first().screenshot({ path: `${shot}/c025-o13.png` });

    // формирование заявки: бизнес-правила, непрерывающее граничное событие, документы и хранилища
    await page.locator('[data-nav-bpmn="o11"]').click();
    await page.locator('.studio g[data-node-id="o11_fill"]').waitFor();
    expect(await page.locator("[data-artifact]").count()).toBeGreaterThan(5);
    if (shot) await page.locator(".bpe-canvas").first().screenshot({ path: `${shot}/c025-o11.png` });
    expect(errors).toEqual([]);
    await ctx.close();
  });
});
