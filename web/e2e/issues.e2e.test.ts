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

describe("замечания проверок: исправить и принять с причиной", () => {
  it("владелец назначается из списка, замечание принимается с причиной, всё сохраняется и переживает перезагрузку", async () => {
    const created = await api<{ id: string; updatedAt: string }>("POST", "/sessions/blank", { meta: { processName: "C025" } });
    const id = created.body.id;
    expect((await api("PUT", `/sessions/${id}/model`, c025Model(), { "X-Base-Updated-At": created.body.updatedAt })).status).toBe(200);

    const { ctx, page, errors } = await openContext(browser);
    await page.goto(`${WEB}/s/${id}`);
    await page.locator(".studio").waitFor();
    await page.waitForLoadState("networkidle");
    expect(await page.locator(".statusbar").innerText()).toMatch(/предупреждений: 10/);

    // исправление: владелец подпроцесса из списка
    const ownerRow = page.locator('[data-issue-rule="role_no_owner"]').first();
    await ownerRow.getByLabel("Назначить владельца…").selectOption({ label: "Специалист отдела обучения и развития персонала" });
    await page.locator(".statusbar", { hasText: "предупреждений: 9" }).waitFor();

    // принятие: A0 из двух блоков — так в документе
    await page.locator('[data-issue-rule="idef0_block_count"]').getByRole("button", { name: "Принять…" }).click();
    await page.getByPlaceholder("Почему принимаем (запишем в модель)").fill("В документе два подпроцесса");
    await page.getByPlaceholder("Почему принимаем (запишем в модель)").press("Enter");
    await page.locator(".statusbar", { hasText: "принято: 1" }).waitFor();
    expect(await page.locator(".statusbar").innerText()).toMatch(/предупреждений: 8/);

    // сохранение и перезагрузка: принятое остаётся принятым
    await page.getByTitle("Сохранить (Ctrl+S)").click();
    await page.getByText(/сохранено/).first().waitFor();
    const saved = await api<any>("GET", `/sessions/${id}`);
    expect(saved.body.model.accepted_issues).toEqual([expect.objectContaining({ rule: "idef0_block_count", reason: "В документе два подпроцесса" })]);
    await page.reload();
    await page.locator(".studio").waitFor();
    await page.locator(".statusbar", { hasText: "принято: 1" }).waitFor();
    await page.getByLabel(/принятые \(1\)/).check();
    expect(await page.locator("[data-accepted-rule='idef0_block_count']").innerText()).toContain("В документе два подпроцесса");

    // агент видит принятое отдельно и не получает его как задачу
    const read = await api<any>("GET", `/agent/sessions/${id}/model`);
    expect(read.body.issues.some((i: any) => i.rule === "idef0_block_count")).toBe(false);
    expect(read.body.accepted.map((i: any) => i.rule)).toEqual(["idef0_block_count"]);
    expect(errors).toEqual([]);
    await ctx.close();
  });
});
