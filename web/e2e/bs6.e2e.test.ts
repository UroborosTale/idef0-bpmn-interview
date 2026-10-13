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

/** Модель с кодом процесса: два подпроцесса, три операции, у первой — диаграмма BPMN из четырёх шагов. */
async function seeded(status?: string) {
  const created = await api<{ id: string; updatedAt: string; model: any }>("POST", "/sessions/blank", { meta: { processName: "Управление процессами" } });
  const model = {
    ...created.body.model,
    process: { ...created.body.model.process, code: "B002.00.00", name: "Управление процессами", ...(status ? { status } : {}) },
    nodes: [
      node("s1", { name: "Моделирование процесса" }),
      node("s2", { name: "Анализ эффективности" }),
      node("o1", { name: "Актуализация реестра", idef0_parent: "s1" }),
      node("o2", { name: "Проведение интервью", idef0_parent: "s1" }),
      node("o3", { name: "Анализ соответствия", idef0_parent: "s2" }),
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
  const put = await api("PUT", `/sessions/${created.body.id}/model`, model, { "X-Base-Updated-At": created.body.updatedAt });
  expect(put.status).toBe(200);
  return created.body.id;
}

async function open(id: string) {
  const c = await openContext(browser);
  c.page.on("dialog", (d) => d.accept());
  await c.page.goto(`${WEB}/s/${id}`);
  await c.page.locator(".studio").waitFor();
  await c.page.waitForLoadState("networkidle");
  return c;
}

const names = (page: import("playwright").Page) => page.locator("[data-nav-fn] .nav-name").allTextContents();

describe("студия: навигатор по образцу Business Studio, в браузере", () => {
  it("двойной щелчок по подпроцессу открывает декомпозицию, а выбор на диаграмме не двигает дерево под курсором", async () => {
    const id = await seeded();
    const { ctx, page, errors } = await open(id);
    await page.locator('[data-nav-fn="s2"]').dblclick();
    await page.locator('.studio g[data-fn-id="o3"]').waitFor();
    expect(await page.locator(".doc-tab.active").innerText()).toMatch(/IDEF0 B002\.02\.00/);
    expect(errors).toEqual([]);
    await ctx.close();
  });

  it("F2 переименовывает, Ctrl+C и Ctrl+V копируют вместе с вложенным, Ctrl+Z возвращает; сохранение доходит до сервера", async () => {
    const id = await seeded();
    const { ctx, page, errors } = await open(id);
    await page.locator('[data-nav-fn="o2"]').click();
    await page.keyboard.press("F2");
    await page.locator('input[aria-label="Название функции"]').fill("Первичное интервью");
    await page.keyboard.press("Enter");
    expect(await names(page)).toContain("Первичное интервью");

    // копия операции с диаграммой BPMN в другой подпроцесс
    await page.locator('[data-nav-fn="o1"]').click();
    await page.keyboard.press("Control+c");
    await page.locator('[data-nav-fn="s2"]').click();
    await page.keyboard.press("Control+v");
    await page.waitForFunction(() => document.querySelectorAll('[data-nav-fn] .nav-name').length === 6);
    await page.getByTitle("Сохранить (Ctrl+S)").click();
    await page.getByText(/сохранено/).first().waitFor();
    const saved = (await api<any>("GET", `/sessions/${id}`)).body.model;
    const copy = saved.nodes.find((n: any) => n.name === "Актуализация реестра" && n.id !== "o1");
    expect(copy).toMatchObject({ idef0_parent: "s2" });
    expect(saved.nodes.filter((n: any) => n.bpmn_scope === copy.id)).toHaveLength(4); // шаги диаграммы скопированы
    expect(saved.nodes.find((n: any) => n.id === "o2").name).toBe("Первичное интервью");

    // после сохранения фокус уходит на страницу: клавиши студии работают, когда фокус внутри неё
    await page.locator('[data-nav-fn="s2"]').click();
    await page.keyboard.press("Control+z");
    await page.waitForFunction(() => document.querySelectorAll('[data-nav-fn] .nav-name').length === 5);
    expect(errors).toEqual([]);
    await ctx.close();
  });

  it("набор объектов: создаётся из выбранной функции, фильтрует дерево, переживает перезагрузку и сохранение", async () => {
    const id = await seeded();
    const { ctx, page, errors } = await open(id);
    await page.locator('[data-nav-fn="o3"]').click();
    await page.getByTitle("Новый набор (с выбранной функцией)").click();
    await page.locator('input[aria-label="Название нового набора"]').fill("Анализ");
    await page.keyboard.press("Enter");
    await page.locator("[data-nav-filter]").waitFor();
    expect(await names(page)).toEqual(["Анализ эффективности", "Анализ соответствия"]); // член набора и путь к нему
    await page.getByTitle("Сохранить (Ctrl+S)").click();
    await page.getByText(/сохранено/).first().waitFor();
    expect((await api<any>("GET", `/sessions/${id}`)).body.model.object_sets).toEqual([{ id: "set1", name: "Анализ", members: ["o3"] }]);

    await page.reload();
    await page.locator(".studio").waitFor();
    await page.locator("[data-nav-filter]").waitFor(); // фильтр запомнен
    expect(await names(page)).toHaveLength(2);
    await page.getByText("Снять", { exact: true }).click();
    expect(await names(page)).toHaveLength(5);
    expect(errors).toEqual([]);
    await ctx.close();
  });

  it("набор: запись справочника входит в набор, фильтр сужает справочник и матрицу RACI, сохранение доходит до сервера", async () => {
    const id = await seeded();
    const { ctx, page, errors } = await open(id);
    await page.locator('[data-nav-fn="o3"]').click();
    await page.getByTitle("Новый набор (с выбранной функцией)").click();
    await page.locator('input[aria-label="Название нового набора"]').fill("Анализ");
    await page.keyboard.press("Enter");
    await page.locator("[data-nav-filter]").waitFor();

    // запись справочника: создаём исполнителя и кладём в набор (фильтр набора включён, поэтому снимаем его на время)
    await page.getByText("Снять", { exact: true }).click();
    await page.locator(".nav-row", { hasText: "Исполнители" }).click();
    await page.locator(".dict-add input").fill("Аналитик");
    await page.locator(".dict-add input").press("Enter");
    await page.locator(".dict-add input").fill("Менеджер");
    await page.locator(".dict-add input").press("Enter");
    await page.getByLabel("Набор для записи «Аналитик»").selectOption({ label: "В набор «Анализ»" });
    await page.locator('[data-nav-set="set1"]').click(); // фильтр по набору
    await page.locator("[data-dict-filter]").waitFor();
    expect(await page.locator(".dict-table tbody tr td:nth-child(2) input").evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value))).toEqual(["Аналитик"]);

    // матрица RACI — только функции набора
    await page.locator(".nav-row", { hasText: "Матрица RACI" }).click();
    expect(await page.locator(".raci-table tbody tr").count()).toBe(1); // в наборе одна функция — o3
    await page.getByTitle("Сохранить (Ctrl+S)").click();
    await page.getByText(/сохранено/).first().waitFor();
    const saved = (await api<any>("GET", `/sessions/${id}`)).body.model;
    expect(saved.object_sets[0].entries).toHaveLength(1);
    expect(saved.object_sets[0].entries[0]).toMatch(/^roles:/);
    expect(errors).toEqual([]);
    await ctx.close();
  });

  it("оформление вида фигур: цвет задач меняется у всех задач диаграммы, попадает в модель", async () => {
    const id = await seeded();
    const { ctx, page, errors } = await open(id);
    await page.locator('[data-nav-bpmn="o1"]').click();
    await page.locator('.studio g[data-node-id="t1"]').click();
    const fills = () => page.locator('.studio g[data-node-id] rect[rx="10"]').evaluateAll((els) => els.map((e) => e.getAttribute("fill")));
    expect(await fills()).toEqual(["#ffffff", "#ffffff"]);
    await page.getByText("Оформление", { exact: true }).click();
    await page.getByLabel("Заливка").fill("#ffeecc");
    await page.getByLabel("Заливка").blur();
    await page.waitForFunction(() => [...document.querySelectorAll('.studio g[data-node-id] rect[rx="10"]')].every((e) => e.getAttribute("fill") === "#ffeecc"));
    await page.getByTitle("Сохранить (Ctrl+S)").click();
    await page.getByText(/сохранено/).first().waitFor();
    expect((await api<any>("GET", `/sessions/${id}`)).body.model.shape_styles).toEqual({ task: { fill: "#ffeecc" } });
    expect(errors).toEqual([]);
    await ctx.close();
  });

  it("подписи и номера: слой подписей скрывает названия событий, номера показывают коды шагов", async () => {
    const id = await seeded();
    const { ctx, page, errors } = await open(id);
    await page.locator('[data-nav-bpmn="o1"]').click();
    await page.locator('.studio g[data-node-id="t1"]').waitFor();
    const eventTexts = () => page.locator("[data-event-position] text").allTextContents();
    expect(await eventTexts()).toContain("Заявка получена");
    await page.getByRole("button", { name: "Подписи" }).click();
    expect(await eventTexts()).not.toContain("Заявка получена");
    await page.getByRole("button", { name: "Номера" }).click();
    expect(await page.locator("[data-step-code]").allTextContents()).toEqual(["B002.01.01/001", "B002.01.01/002"]);
    expect(errors).toEqual([]);
    await ctx.close();
  });

  it("утверждённая версия открывается только для чтения: баннер, поля отключены, «новый цикл» возвращает правку", async () => {
    const id = await seeded("approved");
    const { ctx, page, errors } = await open(id);
    await page.locator(".studio-lock").waitFor();
    await page.locator('[data-nav-fn="o1"]').click();
    expect(await page.getByLabel("Название").first().isDisabled()).toBe(true);
    await page.getByRole("button", { name: "Открыть новый цикл правок" }).click();
    await page.locator(".studio-lock").waitFor({ state: "detached" });
    await page.locator('[data-nav-fn="o1"]').click();
    expect(await page.getByLabel("Название").first().isDisabled()).toBe(false);
    expect(errors).toEqual([]);
    await ctx.close();
  });

  it("переходы по диаграммам: предыдущая, следующая, вверх и вниз", async () => {
    const id = await seeded();
    const { ctx, page, errors } = await open(id);
    const active = () => page.locator(".doc-tab.active").innerText();
    await page.locator('[data-nav-fn="o1"]').click(); // диаграмма подпроцесса B002.01.00
    expect(await active()).toMatch(/IDEF0 B002\.01\.00/);
    await page.getByRole("button", { name: "Вверх: диаграмма выше" }).click();
    expect(await active()).toMatch(/IDEF0 B002\.00\.00/);
    await page.getByRole("button", { name: "Предыдущая диаграмма" }).click();
    expect(await active()).toMatch(/IDEF0 B002\.01\.00/);
    await page.getByRole("button", { name: "Следующая диаграмма" }).click();
    expect(await active()).toMatch(/IDEF0 B002\.00\.00/);
    await page.locator('[data-nav-fn="s1"]').click();
    await page.getByRole("button", { name: "Вниз: диаграмма ниже" }).click();
    expect(await active()).toMatch(/IDEF0 B002\.01\.00/);
    expect(errors).toEqual([]);
    await ctx.close();
  });
});
