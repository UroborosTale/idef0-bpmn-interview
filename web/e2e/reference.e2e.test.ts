import { mkdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "playwright";
import { b002Model } from "../../server/src/reference/b002";
import { WEB, api, launch, openContext } from "./env";

let browser: Browser;
beforeAll(async () => {
  browser = await launch();
});
afterAll(async () => {
  await browser?.close();
});

describe("эталон B002 в студии", () => {
  it("открывается без замечаний: навигатор с кодами B002, диаграммы операций, IDEF0 уровня 1", async () => {
    const created = await api<{ id: string; updatedAt: string }>("POST", "/sessions/blank", { meta: { processName: "Эталон B002" } });
    const id = created.body.id;
    const model = b002Model();
    model.process.group = "Управление корпоративными процессами"; // папка верхнего уровня в навигаторе
    expect((await api("PUT", `/sessions/${id}/model`, model, { "X-Base-Updated-At": created.body.updatedAt })).status).toBe(200);

    const { ctx, page, errors } = await openContext(browser);
    await page.goto(`${WEB}/s/${id}`);
    await page.locator(".studio").waitFor();

    // навигатор: подпроцессы и операции с кодами по Соглашению
    const codes = await page.locator("[data-nav-fn] .nav-code").allTextContents();
    expect(codes).toEqual(["B002.01.00", "B002.01.01", "B002.01.02", "B002.01.03", "B002.02.00", "B002.02.01", "B002.02.02", "B002.03.00", "B002.03.01", "B002.03.02", "B002.03.03", "B002.03.04"]);
    // дерево как в Business Studio 6: папка, процесс, A0, подпроцессы, операции, диаграммы BPMN
    expect(await page.locator("[data-nav-group] .nav-name").innerText()).toBe("Управление корпоративными процессами");
    expect(await page.locator("[data-nav-process] .nav-code").innerText()).toBe("B002.00.00");
    expect(await page.locator("[data-nav-a0]").count()).toBe(0); // строки A0 нет, а номера блоков (A1, A1.1…) стоят рядом с кодами, как в Business Studio
    expect(await page.locator("[data-nav-bpmn]").count()).toBe(9);
    const shotDir = process.env.E2E_SHOTS;
    if (shotDir) {
      mkdirSync(shotDir, { recursive: true });
      await page.locator(".nav").screenshot({ path: `${shotDir}/nav-tree.png` });
    }
    // проверки: ни ошибок, ни предупреждений
    expect(await page.locator(".statusbar").innerText()).toMatch(/ошибок: 0[\s\S]*предупреждений: 0/);

    const shot = process.env.E2E_SHOTS;
    if (shot) mkdirSync(shot, { recursive: true });

    // диаграмма операции с развилкой и циклом: B002.01.01
    await page.locator('[data-nav-bpmn="o11"]').click();
    await page.locator('.studio g[data-node-id="o11_open"]').waitFor();
    expect(await page.locator(".studio g[data-node-id]").count()).toBe(13);
    expect(await page.locator("[data-artifact]").count()).toBeGreaterThan(2);
    if (shot) await page.locator(".bpe-canvas").first().screenshot({ path: `${shot}/ref-o11.png` });

    // самая насыщенная: B002.01.03
    await page.locator('[data-nav-bpmn="o13"]').click();
    await page.locator('.studio g[data-node-id="o13_kb"]').waitFor();
    if (shot) await page.locator(".bpe-canvas").first().screenshot({ path: `${shot}/ref-o13.png` });

    // IDEF0 уровня 1 подпроцесса B002.03.00
    await page.locator('[data-nav-fn="s3"]').dblclick();
    await page.locator('.studio g[data-fn-id="o34"]').waitFor();
    expect(await page.locator(".studio g[data-fn-id]").count()).toBe(4);
    if (shot) await page.locator(".bpe-canvas, .idef0-canvas, .doc-area").first().screenshot({ path: `${shot}/ref-idef0-s3.png` });
    expect(errors).toEqual([]);
    await ctx.close();
  });
});
