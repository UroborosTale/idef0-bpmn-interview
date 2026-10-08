import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright";
import { WEB, api, launch, openContext } from "./env";

let browser: Browser;
beforeAll(async () => {
  browser = await launch();
});
afterAll(async () => {
  await browser?.close();
});

const node = (id: string, extra: Record<string, unknown> = {}) => ({ id, type: "task", name: id, status: "confirmed", confidence: 1, ...extra });

async function seeded() {
  const created = await api<{ id: string; updatedAt: string; model: any }>("POST", "/sessions/blank", { meta: { processName: "Управление процессами" } });
  const model = {
    ...created.body.model,
    process: { ...created.body.model.process, code: "B002.00.00", name: "Управление процессами" },
    nodes: [
      node("s1", { name: "Моделирование процесса" }),
      node("s2", { name: "Анализ эффективности" }),
      node("o1", { name: "Актуализация реестра", idef0_parent: "s1" }),
      node("o2", { name: "Проведение интервью", idef0_parent: "s1" }),
      node("o3", { name: "Анализ соответствия", idef0_parent: "s2" }),
    ],
    data: [{ id: "d1", name: "Реестр процессов", supplier: "B002.01.01", consumer: "B002.01.02" }],
  };
  const put = await api("PUT", `/sessions/${created.body.id}/model`, model, { "X-Base-Updated-At": created.body.updatedAt });
  expect(put.status).toBe(200);
  return created.body.id;
}

/** Перетаскивание мышью по шагам: Chromium начинает drag только после нескольких движений. Y — смещение от верха строки-цели. */
async function drag(page: Page, from: string, to: string, y: number) {
  const a = (await page.locator(`[data-nav-fn="${from}"]`).boundingBox())!;
  const b = (await page.locator(`[data-nav-fn="${to}"]`).boundingBox())!;
  await page.mouse.move(a.x + 60, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + 62, a.y + a.height / 2 + 3, { steps: 3 });
  await page.mouse.move(b.x + 60, b.y + y, { steps: 8 });
  await page.mouse.move(b.x + 61, b.y + y, { steps: 2 });
  await page.mouse.up();
}

describe("правка структуры в навигаторе и мастер", () => {
  it("перетаскивание переставляет операции, коды и ссылки на них обновляются, отмена возвращает; контекстное меню и мастер создают структуру", async () => {
    const id = await seeded();
    const { ctx, page, errors } = await openContext(browser);
    page.on("dialog", (d) => d.accept());
    await page.goto(`${WEB}/s/${id}`);
    await page.locator(".studio").waitFor();
    await page.waitForLoadState("networkidle");

    const code = (fn: string) => page.locator(`[data-nav-fn="${fn}"] .nav-code`).innerText();
    expect(await code("o1")).toBe("B002.01.01");

    // перетаскивание: o2 — перед o1 (верхняя треть строки)
    await drag(page, "o2", "o1", 2);
    await page.waitForFunction(() => document.querySelector('[data-nav-fn="o2"] .nav-code')?.textContent === "B002.01.01");
    expect(await code("o1")).toBe("B002.01.02");

    // ссылки на коды в поставщике/потребителе продукта последовали за функциями
    await page.getByTitle("Сохранить (Ctrl+S)").click();
    await page.getByText(/сохранено/).first().waitFor();
    let saved = await api<any>("GET", `/sessions/${id}`);
    expect(saved.body.model.data[0]).toMatchObject({ supplier: "B002.01.02", consumer: "B002.01.01" });

    // отмена возвращает прежний порядок
    await page.getByTitle("Отменить (Ctrl+Z)").click();
    await page.waitForFunction(() => document.querySelector('[data-nav-fn="o1"] .nav-code')?.textContent === "B002.01.01");

    // контекстное меню: операция в подпроцессе добавляется, подпроцесс сдвигается вверх
    await page.locator('[data-nav-fn="s1"]').click({ button: "right" });
    await page.getByRole("menuitem", { name: "Добавить операцию" }).click();
    await page.locator('[data-nav-fn]:has(.nav-code:text-is("B002.01.03"))').waitFor();
    await page.locator('[data-nav-fn="s2"]').click({ button: "right" });
    await page.getByRole("menuitem", { name: "Переместить вверх" }).click();
    await page.waitForFunction(() => document.querySelector('[data-nav-fn="s2"] .nav-code')?.textContent === "B002.01.00");

    // удаление с подтверждением (диалог принимается)
    await page.locator('[data-nav-fn="o3"]').click({ button: "right" });
    await page.getByRole("menuitem", { name: "Удалить…" }).click();
    await page.locator('[data-nav-fn="o3"]').waitFor({ state: "detached" });

    // мастер структуры из ленты
    await page.getByRole("button", { name: "Мастер структуры…" }).first().click();
    await page.getByLabel("Структура процесса").fill("Реинжиниринг\n  Интервью с владельцем\n  Картирование");
    await page.locator(".wizard-preview li", { hasText: "Картирование" }).waitFor();
    await page.getByRole("button", { name: "Создать структуру" }).click();
    await page.locator('[data-nav-fn]', { hasText: "Реинжиниринг" }).waitFor();
    await page.getByTitle("Сохранить (Ctrl+S)").click();
    await page.getByText(/сохранено/).first().waitFor();
    saved = await api<any>("GET", `/sessions/${id}`);
    const names = saved.body.model.nodes.map((n: any) => n.name);
    expect(names).toEqual(expect.arrayContaining(["Реинжиниринг", "Интервью с владельцем", "Картирование"]));
    expect(saved.body.model.nodes.filter((n: any) => n.bpmn_scope).length).toBe(6);
    expect(errors).toEqual([]);
    await ctx.close();
  });
});
