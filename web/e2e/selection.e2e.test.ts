import { mkdirSync } from "node:fs";
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
  const base = created.body.model;
  const model = {
    ...base,
    process: { ...base.process, code: "B002.00.00", name: "Управление процессами" },
    roles: [{ id: "r2", name: "Специалист отдела" }],
    nodes: [
      node("s1", { name: "Моделирование процесса" }),
      node("o1", { name: "Актуализация реестра", idef0_parent: "s1", role_id: "r2" }),
      node("o2", { name: "Проведение интервью", idef0_parent: "s1", role_id: "r2" }),
      node("b0", { type: "event", subtype: "start", name: "Информация получена", bpmn_scope: "o1", role_id: "r2", layout: { x: 160, y: 120 } }),
      node("b1", { name: "Открыть реестр", bpmn_scope: "o1", role_id: "r2", layout: { x: 280, y: 100 } }),
      node("b2", { name: "Внести код процесса", bpmn_scope: "o1", role_id: "r2", layout: { x: 460, y: 100 } }),
      node("b9", { type: "event", subtype: "end", name: "Реестр актуализирован", bpmn_scope: "o1", role_id: "r2", layout: { x: 640, y: 120 } }),
      node("c0", { type: "event", subtype: "start", name: "Интервью назначено", bpmn_scope: "o2", role_id: "r2", layout: { x: 160, y: 120 } }),
      node("c1", { name: "Провести интервью", bpmn_scope: "o2", role_id: "r2", layout: { x: 280, y: 100 } }),
      node("c9", { type: "event", subtype: "end", name: "Интервью проведено", bpmn_scope: "o2", role_id: "r2", layout: { x: 460, y: 120 } }),
    ],
    flows: [
      { id: "f1", from: "b0", to: "b1" },
      { id: "f2", from: "b1", to: "b2" },
      { id: "f3", from: "b2", to: "b9" },
      { id: "f4", from: "c0", to: "c1" },
      { id: "f5", from: "c1", to: "c9" },
    ],
    assignments: [
      { node_id: "o1", role_id: "r2", kind: "executor", functions: [] },
      { node_id: "o2", role_id: "r2", kind: "executor", functions: [] },
    ],
  };
  const put = await api("PUT", `/sessions/${created.body.id}/model`, model, { "X-Base-Updated-At": created.body.updatedAt });
  expect(put.status).toBe(200);
  return created.body.id;
}

const box = async (page: Page, id: string) => (await page.locator(`.studio g[data-node-id="${id}"] rect:not([fill="transparent"])`).first().boundingBox())!;
const names = (page: Page) => page.locator(".studio g[data-node-id] text").evaluateAll((els) => els.map((e) => e.textContent ?? ""));

describe("выделение группой, копирование и миникарта в редакторе BPMN", () => {
  it("рамка с Shift, перенос группой, копирование в другую диаграмму, выравнивание, миникарта", async () => {
    const id = await seeded();
    const { ctx, page, errors } = await openContext(browser);
    await page.goto(`${WEB}/s/${id}`);
    await page.locator(".studio").waitFor();
    await page.waitForLoadState("networkidle");
    await page.locator('[data-nav-bpmn="o1"]').click();
    await page.locator('.studio g[data-node-id="b1"]').waitFor();

    // рамка: Shift + перетаскивание по пустому месту дорожки охватывает две задачи
    const b1 = await box(page, "b1");
    const b2 = await box(page, "b2");
    await page.keyboard.down("Shift");
    await page.mouse.move(b1.x - 12, b1.y - 14);
    await page.mouse.down();
    await page.mouse.move(b1.x + 40, b1.y + 40, { steps: 4 });
    await page.mouse.move(b2.x + b2.width + 12, b2.y + b2.height + 14, { steps: 6 });
    await page.mouse.up();
    await page.keyboard.up("Shift");
    await page.getByRole("toolbar", { name: "Действия с выделением" }).waitFor();
    expect(await page.getByRole("toolbar", { name: "Действия с выделением" }).innerText()).toContain("Выделено: 2");
    await page.locator("[data-group-box]").waitFor({ state: "attached" });

    // перенос группой: обе задачи едут вместе на одно расстояние
    const before1 = (await box(page, "b1")).x;
    const before2 = (await box(page, "b2")).x;
    await page.mouse.move(b1.x + b1.width / 2, b1.y + b1.height / 2);
    await page.mouse.down();
    await page.mouse.move(b1.x + b1.width / 2 + 20, b1.y + b1.height / 2, { steps: 3 });
    await page.mouse.move(b1.x + b1.width / 2 + 60, b1.y + b1.height / 2, { steps: 6 });
    await page.mouse.up();
    const d1 = (await box(page, "b1")).x - before1;
    const d2 = (await box(page, "b2")).x - before2;
    expect(d1).toBeGreaterThan(30);
    expect(Math.abs(d1 - d2)).toBeLessThan(1);
    await page.getByTitle("Отменить (Ctrl+Z)").click(); // перенос — один шаг истории
    expect(Math.abs((await box(page, "b1")).x - before1)).toBeLessThan(1);

    // копирование Ctrl+C → вставка Ctrl+V в диаграмму другой операции
    await page.locator('.studio g[data-node-id="b1"]').click({ modifiers: ["Shift"] }); // выделение осталось? повторно соберём группу
    await page.keyboard.press("Control+a");
    expect(await page.getByRole("toolbar", { name: "Действия с выделением" }).innerText()).toContain("Выделено: 4");
    await page.keyboard.press("Control+c");
    await page.locator('[data-nav-bpmn="o2"]').click();
    await page.locator('.studio g[data-node-id="c1"]').waitFor();
    await page.locator(".bpe").first().focus();
    await page.getByRole("button", { name: "Вставить" }).click();
    await page.waitForFunction(() => document.querySelectorAll(".studio g[data-node-id]").length === 7);
    expect((await names(page)).filter((t) => t.includes("Открыть реестр")).length).toBe(1);
    expect(await page.getByRole("toolbar", { name: "Действия с выделением" }).innerText()).toContain("Выделено: 4");

    // выравнивание по левому краю действует на вставленную группу
    await page.getByRole("button", { name: /Влево/ }).click();

    const shot = process.env.E2E_SHOTS;
    if (shot) {
      mkdirSync(shot, { recursive: true });
      await page.locator(".bpe-canvas").first().screenshot({ path: `${shot}/bpmn-selection.png` });
    }

    // миникарта: видна, щелчок по ней сдвигает видимую часть
    const map = page.locator("[data-minimap]");
    await map.waitFor();
    const viewBefore = await page.locator("[data-minimap-view]").getAttribute("x");
    const mb = (await map.boundingBox())!;
    await page.mouse.click(mb.x + mb.width - 6, mb.y + mb.height - 6);
    expect(await page.locator("[data-minimap-view]").getAttribute("x")).not.toBe(viewBefore);
    await page.getByRole("button", { name: "Миникарта" }).click();
    expect(await page.locator("[data-minimap]").count()).toBe(0);

    // сохраняем: у o2 появились скопированные шаги, id уникальны, чужая диаграмма o1 не тронута
    await page.getByTitle("Сохранить (Ctrl+S)").click();
    await page.getByText(/сохранено/).first().waitFor();
    const saved = await api<any>("GET", `/sessions/${id}`);
    const ns: any[] = saved.body.model.nodes;
    expect(new Set(ns.map((n) => n.id)).size).toBe(ns.length);
    expect(ns.filter((n) => n.bpmn_scope === "o2").length).toBe(3 + 4);
    expect(ns.filter((n) => n.bpmn_scope === "o1").length).toBe(4);
    const copies = ns.filter((n) => n.bpmn_scope === "o2" && n.name === "Открыть реестр");
    expect(copies).toHaveLength(1);
    expect(copies[0].source ?? []).toEqual([]);
    const flows: any[] = saved.body.model.flows;
    expect(new Set(flows.map((f) => f.id)).size).toBe(flows.length);
    expect(errors).toEqual([]);
    await ctx.close();
  });
});


async function seededIdef0() {
  const created = await api<{ id: string; updatedAt: string; model: any }>("POST", "/sessions/blank", { meta: { processName: "Управление процессами" } });
  const base = created.body.model;
  const model = {
    ...base,
    process: { ...base.process, code: "B002.00.00", name: "Управление процессами" },
    nodes: [node("s1", { name: "Моделирование процесса" }), node("s2", { name: "Анализ эффективности" }), node("s3", { name: "Совершенствование процесса" })],
  };
  const put = await api("PUT", `/sessions/${created.body.id}/model`, model, { "X-Base-Updated-At": created.body.updatedAt });
  expect(put.status).toBe(200);
  return created.body.id;
}

const fnBox = async (page: Page, id: string) => (await page.locator(`.studio g[data-fn-id="${id}"]`).first().boundingBox())!;
const fnNames = (page: Page) => page.locator(".studio g[data-fn-id]").evaluateAll((els) => els.map((e) => e.textContent ?? ""));

describe("выделение группой, копирование и миникарта в редакторе IDEF0", () => {
  it("рамка с Shift, перенос группой, копирование на диаграмму, миникарта; всё сохраняется", async () => {
    const id = await seededIdef0();
    const { ctx, page, errors } = await openContext(browser);
    await page.goto(`${WEB}/s/${id}`);
    await page.locator(".studio").waitFor();
    await page.waitForLoadState("networkidle");
    await page.locator("[data-nav-process]").click(); // в структурированной модели это диаграмма A0
    await page.locator('.studio g[data-fn-id="s1"]').waitFor();

    // рамка с Shift охватывает два блока
    const s1 = await fnBox(page, "s1");
    const s2 = await fnBox(page, "s2");
    await page.keyboard.down("Shift");
    await page.mouse.move(s1.x - 14, s1.y - 14);
    await page.mouse.down();
    await page.mouse.move(s1.x + 40, s1.y + 40, { steps: 4 });
    await page.mouse.move(s2.x + s2.width + 10, s2.y + s2.height + 10, { steps: 6 });
    await page.mouse.up();
    await page.keyboard.up("Shift");
    const bar = page.getByRole("toolbar", { name: "Действия с выделением" });
    await bar.waitFor();
    expect(await bar.innerText()).toContain("Выделено: 2");
    await page.locator("[data-group-box]").waitFor({ state: "attached" });

    // перенос группой: оба блока едут на одно расстояние; перенос — один шаг истории
    const before1 = (await fnBox(page, "s1")).x;
    const before2 = (await fnBox(page, "s2")).x;
    await page.mouse.move(s1.x + s1.width / 2, s1.y + s1.height / 2);
    await page.mouse.down();
    await page.mouse.move(s1.x + s1.width / 2 + 20, s1.y + s1.height / 2, { steps: 3 });
    await page.mouse.move(s1.x + s1.width / 2 + 70, s1.y + s1.height / 2, { steps: 6 });
    await page.mouse.up();
    const d1 = (await fnBox(page, "s1")).x - before1;
    const d2 = (await fnBox(page, "s2")).x - before2;
    expect(d1).toBeGreaterThan(30);
    expect(Math.abs(d1 - d2)).toBeLessThan(1);
    await page.getByTitle("Отменить (Ctrl+Z)").click();
    expect(Math.abs((await fnBox(page, "s1")).x - before1)).toBeLessThan(1);

    // Ctrl+A выделяет все блоки; копирование и вставка добавляют копии с новыми названиями
    await page.locator(".bpe").first().focus();
    await page.keyboard.press("Control+a");
    expect(await bar.innerText()).toContain("Выделено: 3");
    await page.keyboard.press("Control+c");
    await page.getByRole("button", { name: "Вставить" }).click();
    await page.waitForFunction(() => document.querySelectorAll(".studio g[data-fn-id]").length === 6);
    expect((await fnNames(page)).filter((t) => t.includes("(копия)")).length).toBe(3);
    expect(await bar.innerText()).toContain("Выделено: 3");

    const shot = process.env.E2E_SHOTS;
    if (shot) {
      mkdirSync(shot, { recursive: true });
      await page.locator(".bpe-canvas").first().screenshot({ path: `${shot}/idef0-selection.png` });
    }

    // миникарта: видна, щелчок по ней сдвигает видимую часть, кнопка выключает
    const map = page.locator("[data-minimap]");
    await map.waitFor();
    const viewBefore = await page.locator("[data-minimap-view]").getAttribute("x");
    const mb = (await map.boundingBox())!;
    await page.mouse.click(mb.x + mb.width - 6, mb.y + mb.height - 6);
    expect(await page.locator("[data-minimap-view]").getAttribute("x")).not.toBe(viewBefore);
    await page.getByRole("button", { name: "Миникарта" }).click();
    expect(await page.locator("[data-minimap]").count()).toBe(0);

    // удаление группы клавишей и сохранение: остаются три исходных блока без копий
    await page.keyboard.press("Delete");
    await page.waitForFunction(() => document.querySelectorAll(".studio g[data-fn-id]").length === 3);
    await page.keyboard.press("Control+v"); // буфер хранит три блока — вставляем снова
    await page.waitForFunction(() => document.querySelectorAll(".studio g[data-fn-id]").length === 6);
    await page.getByTitle("Сохранить (Ctrl+S)").click();
    await page.getByText(/сохранено/).first().waitFor();
    const saved = await api<any>("GET", `/sessions/${id}`);
    const ns: any[] = saved.body.model.nodes;
    expect(ns).toHaveLength(6);
    expect(new Set(ns.map((n) => n.id)).size).toBe(6);
    expect(new Set(ns.map((n) => n.name)).size).toBe(6); // названия функций уникальны
    expect(ns.filter((n) => /\(копия\)/.test(n.name))).toHaveLength(3);
    expect(errors).toEqual([]);
    await ctx.close();
  });
});