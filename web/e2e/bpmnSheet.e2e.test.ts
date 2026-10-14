import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "playwright";
import { WEB, api, launch, openContext } from "./env";

let browser: Browser;
beforeAll(async () => {
  browser = await launch();
});
afterAll(async () => {
  await browser?.close();
});

const node = (id: string, extra: Record<string, unknown> = {}) => ({ id, type: "task", name: id, status: "confirmed", confidence: 1, ...extra });

/** Процесс с одной операцией и её диаграммой BPMN из четырёх шагов. */
async function seeded() {
  const created = await api<{ id: string; updatedAt: string; model: any }>("POST", "/sessions/blank", { meta: { processName: "Лист BPMN" } });
  const model = {
    ...created.body.model,
    process: { ...created.body.model.process, code: "B003.00.00", name: "Лист BPMN" },
    nodes: [
      node("s1", { name: "Ведение реестра" }),
      node("o1", { name: "Актуализация реестра", idef0_parent: "s1" }),
      node("e0", { type: "event", subtype: "start", name: "Заявка получена", bpmn_scope: "o1" }),
      node("t1", { name: "Открыть реестр", bpmn_scope: "o1" }),
      node("t2", { name: "Внести код", bpmn_scope: "o1" }),
      node("e1", { type: "event", subtype: "end", name: "Реестр обновлён", bpmn_scope: "o1" }),
    ],
    flows: [
      { id: "f1", from: "e0", to: "t1", source: [], confirmed_by: [] },
      { id: "f2", from: "t1", to: "t2", source: [], confirmed_by: [] },
      { id: "f3", from: "t2", to: "e1", source: [], confirmed_by: [] },
    ],
  };
  expect((await api("PUT", `/sessions/${created.body.id}/model`, model, { "X-Base-Updated-At": created.body.updatedAt })).status).toBe(200);
  return created.body.id;
}

describe("рамка листа BPMN и печать, в браузере", () => {
  it("рамка выключена по умолчанию; включается в «Лист», двигается и отменяется; печать и PDF — по листу с экрана; сохраняется по операции", async () => {
    const id = await seeded();
    const { ctx, page, errors } = await openContext(browser);
    await page.goto(`${WEB}/s/${id}`);
    await page.locator(".studio").waitFor();
    await page.waitForLoadState("networkidle");
    // операция → её диаграмма BPMN: выбор в навигаторе и «Вниз»
    await page.locator('[data-nav-fn="o1"]').click();
    await page.getByLabel("Вниз: диаграмма ниже").click();
    await page.locator('.studio svg.bpe-svg [data-node-id="t1"]').waitFor();

    expect(await page.locator(".studio [data-frame]").count()).toBe(0);
    await page.locator(".studio summary", { hasText: "Лист" }).click();
    await page.getByRole("button", { name: "Рамка" }).click();
    await page.locator(".studio [data-frame]").waitFor();
    // «Вписать» показывает лист целиком, вместе со штампом
    await page.locator(".studio summary", { hasText: "Лист" }).click();
    await page.getByRole("button", { name: "Вписать" }).click();
    const canvas = (await page.locator(".studio svg.bpe-svg").boundingBox())!;
    const footer = (await page.locator(".studio [data-frame-move]").boundingBox())!;
    expect(footer.y + footer.height).toBeLessThanOrEqual(canvas.y + canvas.height + 1);
    // и на низком окне: холст короткий, масштаб «Вписать» ниже 0,3 — лист всё равно целиком в холсте (с полем справа и снизу)
    await page.setViewportSize({ width: 1600, height: 640 });
    await page.getByRole("button", { name: "Вписать" }).click();
    const low = (await page.locator(".studio svg.bpe-svg").boundingBox())!;
    const lowFrame = (await page.locator(".studio [data-frame-back] > rect").boundingBox())!;
    const lowFooter = (await page.locator(".studio [data-frame-move]").boundingBox())!;
    expect(lowFooter.y + lowFooter.height).toBeLessThanOrEqual(low.y + low.height);
    expect(lowFrame.x + lowFrame.width).toBeLessThanOrEqual(low.x + low.width);
    await page.setViewportSize({ width: 1600, height: 950 });
    await page.getByRole("button", { name: "Вписать" }).click();
    // лист накрывает все фигуры диаграммы
    const sheet = (await page.locator(".studio [data-frame-back] > rect").boundingBox())!;
    for (const n of ["e0", "t1", "t2", "e1"]) {
      const b = (await page.locator(`.studio [data-node-id="${n}"]`).first().boundingBox())!;
      expect(b.x >= sheet.x && b.y >= sheet.y && b.x + b.width <= sheet.x + sheet.width && b.y + b.height <= sheet.y + sheet.height).toBe(true);
    }
    expect(await page.locator(".studio [data-frame-field='title']").textContent()).toContain("Актуализация реестра");

    // штамп двигает лист, Ctrl+Z возвращает
    const x0 = await page.locator(".studio [data-frame-back] > rect").evaluate((r) => Number(r.getAttribute("x")));
    const stamp = (await page.locator(".studio [data-frame-move]").boundingBox())!;
    await page.mouse.move(stamp.x + 40, stamp.y + stamp.height / 2);
    await page.mouse.down();
    await page.mouse.move(stamp.x + 120, stamp.y + stamp.height / 2 + 30, { steps: 5 });
    await page.mouse.up();
    // в координатах диаграммы: на экране вид может перестроиться
    const sheetX = () => page.locator(".studio [data-frame-back] > rect").evaluate((r) => Number(r.getAttribute("x")));
    expect(await sheetX()).toBeGreaterThan(x0 + 20);
    await page.keyboard.press("Control+z");
    expect(await sheetX()).toBe(x0);

    // печать — на вкладке ленты «Выгрузка и печать»; её высота — образец для проверок ниже
    await page.getByRole("tab", { name: "Выгрузка и печать" }).click();
    const ribbonH = (await page.locator(".ribbon").boundingBox())!.height;
    // печать: страница с листом в новой вкладке
    const [popup] = await Promise.all([ctx.waitForEvent("page"), page.getByRole("button", { name: "Печать…" }).click()]);
    await popup.waitForLoadState();
    const html = await popup.content();
    expect(html).toContain("@page { size: A4 landscape");
    expect(await popup.locator(".sheet svg [data-frame]").count()).toBe(1);
    expect(await popup.locator(".sheet svg [data-frame-resize]").count()).toBe(0); // ручки листа не печатаются
    await popup.close();

    // PDF листа с сервера
    await page.getByLabel("Бумага для печати").selectOption("A3");
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Лист в PDF" }).click()]);
    expect(download.suggestedFilename()).toMatch(/\.A3\.pdf$/);
    expect(readFileSync((await download.path())!).subarray(0, 5).toString()).toBe("%PDF-");

    // группа печати не растягивает ленту
    expect((await page.locator(".ribbon").boundingBox())!.height).toBe(ribbonH);
    // выбор бумаги не выше кнопок ленты
    const selectH = (await page.getByLabel("Бумага для печати").boundingBox())!.height;
    expect(selectH).toBeLessThanOrEqual((await page.getByRole("button", { name: "Печать…" }).boundingBox())!.height);
    // и лента не выше, чем на диаграмме IDEF0 с её группой печати
    await page.locator(".doc-tab", { hasText: "IDEF0 B003.01.00" }).click();
    await page.locator(".ribbon-caption", { hasText: "Печать листа IDEF0" }).waitFor();
    expect(ribbonH).toBeLessThanOrEqual((await page.locator(".ribbon").boundingBox())!.height);

    await page.getByRole("tab", { name: "Главная" }).click(); // «Сохранить» — на вкладке ленты «Главная»
    await page.getByTitle("Сохранить (Ctrl+S)").click();
    await page.waitForFunction(() => !document.querySelector(".studio .dirty-dot, .studio [data-dirty='true']"));
    await page.waitForTimeout(500);
    const saved = await api<any>("GET", `/sessions/${id}`);
    expect(saved.body.model.bpmn_frames).toEqual({ o1: { show: true } });
    expect(errors).toEqual([]);
    await ctx.close();
  }, 120_000);
});
