import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright";
import { USER, WEB, api, expectPanel, field, launch, openContext, seedSession, statusText } from "./env";

let browser: Browser;
beforeAll(async () => {
  browser = await launch();
});
afterAll(async () => {
  await browser?.close();
});

/** Открыть сессию в студии и дождаться холста BPMN. */
async function openStudio(page: Page, id: string) {
  await page.goto(`${WEB}/s/${id}`);
  await page.locator(".studio g[data-node-id]").first().waitFor();
}

/** Центр элемента на экране. */
async function center(page: Page, selector: string) {
  const b = (await page.locator(selector).first().boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2, box: b };
}

describe("вход", () => {
  it("неверный пароль — сообщение об ошибке; верный — список сессий", async () => {
    await seedSession("Сессия для входа");
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(WEB);
    await page.getByLabel("Логин").fill(USER.login);
    await page.getByLabel("Пароль").fill("неверный");
    await page.getByRole("button", { name: "Войти" }).click();
    await page.locator(".login-card .validation-item.error").waitFor();
    await page.getByLabel("Пароль").fill(USER.password);
    await page.getByRole("button", { name: "Войти" }).click();
    await page.getByText("Сессия для входа").first().waitFor();
    await ctx.close();
  });
});

describe("студия в браузере", () => {
  it("сессия открывается в студии: вкладки, навигатор, свойства процесса, без ошибок", async () => {
    const id = await seedSession();
    const { ctx, page, errors } = await openContext(browser);
    await page.goto(`${WEB}/s/${id}`);
    await page.locator(".studio").waitFor();
    expect((await page.locator(".doc-tab").allInnerTexts()).map((t) => t.replace(/×/g, "").trim())).toEqual(["BPMN", "IDEF0 A0"]);
    expect(await page.locator("[data-nav-fn]").count()).toBeGreaterThan(2);
    await expectPanel(page, "Свойства процесса");
    expect(await statusText(page)).toMatch(/сохранено/);
    expect(errors).toEqual([]);
    await ctx.close();
  });

  it("BPMN: щелчок по фигуре, правка в панели, перенос в другую дорожку, отмена (в т. ч. в русской раскладке)", async () => {
    const id = await seedSession();
    const { ctx, page, errors } = await openContext(browser);
    await openStudio(page, id);
    const task = page.locator('.studio g[data-node-id]').filter({ has: page.locator("rect") }).first();
    const nodeId = (await task.getAttribute("data-node-id"))!;
    await task.click();
    await expectPanel(page, "Свойства элемента");
    await field(page, "Длительность").fill("3 дня");
    await field(page, "Длительность").press("Enter");
    expect(await statusText(page)).toMatch(/несохранённые/);

    // перетаскивание в дорожку другого исполнителя
    const roleBefore = await field(page, "Исполнитель (дорожка BPMN, механизм IDEF0)").inputValue();
    const lanes = page.locator(".studio [data-lane-id]");
    const laneIds = await lanes.evaluateAll((els) => els.map((e) => e.getAttribute("data-lane-id")!));
    const targetLane = laneIds.find((l) => l !== roleBefore && l !== "__unassigned__" && !l.startsWith("_"))!;
    const from = await center(page, `.studio g[data-node-id="${nodeId}"]`);
    const lane = await center(page, `.studio [data-lane-id="${targetLane}"]`);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 20, lane.y, { steps: 8 });
    await page.mouse.up();
    await page.locator(`.studio g[data-node-id="${nodeId}"]`).click();
    expect(await field(page, "Исполнитель (дорожка BPMN, механизм IDEF0)").inputValue()).toBe(targetLane);

    // Ctrl+Z на холсте (латиница), затем Ctrl+Я — русская раскладка
    await page.locator(".bpe").first().focus();
    await page.keyboard.press("Control+KeyZ");
    await page.locator(`.studio g[data-node-id="${nodeId}"]`).click();
    expect(await field(page, "Исполнитель (дорожка BPMN, механизм IDEF0)").inputValue()).toBe(roleBefore);
    await page.locator(".bpe").first().evaluate((el) => el.dispatchEvent(new KeyboardEvent("keydown", { key: "я", code: "KeyZ", ctrlKey: true, bubbles: true })));
    // синтетическое нажатие обрабатывается асинхронно: ждём перерисовки панели
    await expect.poll(() => field(page, "Длительность").inputValue()).toBe("");
    expect(errors).toEqual([]);
    await ctx.close();
  });

  it("IDEF0: протягивание связи между функциями создаёт стрелку, её можно разорвать из панели", async () => {
    const id = await seedSession();
    const { ctx, page, errors } = await openContext(browser);
    await openStudio(page, id);
    await page.locator(".doc-tab", { hasText: "IDEF0 A0" }).click();
    const blocks = page.locator(".studio g[data-fn-id]");
    await blocks.first().waitFor();
    const arrowsBefore = await page.locator(".studio [data-arrow-key]").count();
    const lastId = (await blocks.last().getAttribute("data-fn-id"))!;
    await blocks.first().click();
    const handle = await center(page, ".studio [data-connect]");
    const target = await center(page, `.studio g[data-fn-id="${lastId}"]`);
    await page.mouse.move(handle.x, handle.y);
    await page.mouse.down();
    await page.mouse.move(target.x, target.box.y + target.box.height * 0.75, { steps: 10 });
    await page.mouse.up();
    await expectPanel(page, "Свойства стрелки");
    expect(await page.locator(".props-body .prop-kind").first().innerText()).toMatch(/выход → вход/);
    expect(await page.locator(".studio [data-arrow-key]").count()).toBeGreaterThan(arrowsBefore);
    await page.getByRole("button", { name: "Разорвать связь" }).click();
    await expectPanel(page, "Свойства процесса");
    expect(errors).toEqual([]);
    await ctx.close();
  });

  it("справочник: карточка записи сохраняется на сервере и попадает в историю версий", async () => {
    const id = await seedSession();
    const { ctx, page, errors } = await openContext(browser);
    await openStudio(page, id);
    await page.locator(".nav-row", { hasText: "Информационные системы" }).click();
    await page.locator(".dict-add input").fill("СЭД «Дело»");
    await page.locator(".dict-add input").press("Enter");
    await page.locator(".dict-table tbody tr").last().click();
    await expectPanel(page, "Карточка записи");
    await field(page, "Описание").fill("Электронный документооборот");
    await field(page, "Ответственный").fill("ИТ-отдел");
    await field(page, "Ответственный").press("Enter");
    await page.getByRole("button", { name: "Сохранить" }).first().click();
    await page.locator(".statusbar", { hasText: "✓ сохранено" }).waitFor();

    const s = await api("GET", `/sessions/${id}`);
    const sys = s.body.model.systems.find((x: { name: string }) => x.name === "СЭД «Дело»");
    expect(sys).toMatchObject({ description: "Электронный документооборот", owner: "ИТ-отдел" });

    await page.locator(".props-body summary", { hasText: "История" }).click();
    await page.locator(".prop-history li").first().waitFor();
    expect(await page.locator(".prop-history").innerText()).toMatch(/Появилась/);
    expect(errors).toEqual([]);
    await ctx.close();
  });

  it("несохранённые правки переживают перезагрузку страницы", async () => {
    const id = await seedSession();
    const { ctx, page } = await openContext(browser);
    await openStudio(page, id);
    await page.locator("[data-nav-fn]").first().click();
    await field(page, "Заметка").fill("правка до перезагрузки");
    await field(page, "Длительность").click(); // потеря фокуса фиксирует правку
    await page.waitForTimeout(600);
    await page.reload();
    await page.locator(".bpe-banner", { hasText: "Восстановлены несохранённые правки" }).waitFor();
    expect(await statusText(page)).toMatch(/несохранённые/);
    await page.locator("[data-nav-fn]").first().click();
    expect(await field(page, "Заметка").inputValue()).toBe("правка до перезагрузки");
    await ctx.close();
  });

  it("конфликт версий: модель изменили в другом месте — сохранение отклоняется, правки не теряются", async () => {
    const id = await seedSession();
    const { ctx, page } = await openContext(browser);
    await openStudio(page, id);
    // страница при открытии дважды запрашивает сессию; ждём, пока оба ответа придут, иначе поздний ответ подхватит и «чужую» правку
    await page.waitForLoadState("networkidle");
    // другая вкладка сохранила модель
    const s = await api("GET", `/sessions/${id}`);
    const m = s.body.model;
    m.process.owner = "изменено в другой вкладке";
    expect((await api("PUT", `/sessions/${id}/model`, m, { "X-Base-Updated-At": s.body.updatedAt })).status).toBe(200);

    await page.locator("[data-nav-fn]").first().click();
    await field(page, "Заметка").fill("моя правка");
    await field(page, "Длительность").click();
    await page.getByRole("button", { name: "Сохранить" }).first().click();
    await page.getByText(/Модель изменилась после того, как вы начали правку/).waitFor();
    expect(await statusText(page)).toMatch(/несохранённые/);
    const after = await api("GET", `/sessions/${id}`);
    expect(after.body.model.process.owner).toBe("изменено в другой вкладке");
    await ctx.close();
  });

  it("с нуля: пустая модель → фигуры из палитры → стрелки → сохранение → выгрузка SVG и PNG", async () => {
    const { ctx, page, errors } = await openContext(browser);
    await page.goto(`${WEB}/new`);
    await page.getByLabel(/Режим Г/).check();
    await page.getByPlaceholder(/например, Согласование/).fill("Найм сотрудника");
    await page.getByRole("button", { name: "Создать пустую модель и открыть студию" }).click();
    await page.locator(".bpe-empty").waitFor();
    expect(await page.locator(".studio g[data-node-id]").count()).toBe(0);

    // «Начало» → «Задача» (быстрое продолжение: новая фигура сразу соединяется с выбранной) → «Конец»
    const palette = (name: string) => page.locator(".bpe-palette button", { hasText: new RegExp(`^${name}$`) });
    const rename = async (text: string) => {
      await page.locator(".bpe-rename").fill(text);
      await page.locator(".bpe-rename").press("Enter");
    };
    await palette("Начало").click();
    await rename("Вакансия открыта");
    await palette("Задача").click();
    await rename("Провести собеседование");
    await palette("Конец").click();
    await rename("Сотрудник принят");
    await expect.poll(() => page.locator(".studio g[data-node-id]").count()).toBe(3);
    expect(await page.locator(".studio [data-flow-id]").count()).toBe(2);
    expect(await page.locator(".bpe-empty").count()).toBe(0);

    // дубликат (Ctrl+D) и удаление копии
    await page.locator(".studio g[data-node-id]").nth(1).click();
    await page.locator(".bpe").first().focus();
    await page.keyboard.press("Control+KeyD");
    await expect.poll(() => page.locator(".studio g[data-node-id]").count()).toBe(4);
    await expect.poll(() => field(page, "Название").inputValue()).toBe("Провести собеседование (копия)");
    await page.keyboard.press("Delete");
    await expect.poll(() => page.locator(".studio g[data-node-id]").count()).toBe(3);

    // выгрузка с экрана — до сохранения
    await page.getByRole("tab", { name: "Выгрузка и печать" }).click();
    const svgDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: "SVG", exact: true }).click();
    const svgFile = await (await svgDownload).createReadStream();
    const chunks: Buffer[] = [];
    for await (const c of svgFile!) chunks.push(c as Buffer);
    const svg = Buffer.concat(chunks).toString("utf8");
    expect(svg).toMatch(/^<svg[^>]+xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    expect(svg).toContain("Провести");
    expect(svg).not.toContain("data-connect");
    const pngDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: "PNG", exact: true }).click();
    const pngChunks: Buffer[] = [];
    for await (const c of (await (await pngDownload).createReadStream())!) pngChunks.push(c as Buffer);
    const png = Buffer.concat(pngChunks);
    expect([...png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(png.length).toBeGreaterThan(2000);

    // сохранение и проверка на сервере (кнопка — на вкладке ленты «Главная»)
    await page.getByRole("tab", { name: "Главная" }).click();
    await page.getByRole("button", { name: "Сохранить" }).first().click();
    await page.locator(".statusbar", { hasText: "✓ сохранено" }).waitFor();
    const id = new URL(page.url()).pathname.split("/").pop()!;
    const s = await api("GET", `/sessions/${id}`);
    expect(s.body.model.nodes.map((n: { name: string }) => n.name)).toEqual(["Вакансия открыта", "Провести собеседование", "Сотрудник принят"]);
    expect(s.body.model.flows).toHaveLength(2);
    expect(errors).toEqual([]);
    await ctx.close();
  });

  it("весь экран, поиск в навигаторе, масштаб 100%", async () => {
    const id = await seedSession();
    const { ctx, page } = await openContext(browser);
    await openStudio(page, id);
    const before = (await page.locator(".studio").boundingBox())!;
    await page.getByRole("button", { name: "На весь экран" }).click();
    const full = (await page.locator(".studio").boundingBox())!;
    expect(full.height).toBeGreaterThan(before.height);
    expect(Math.round(full.y)).toBe(0);
    // запись справочника открывается карточкой, функция — свойствами и остаётся на диаграмме
    await page.getByLabel("Поиск в навигаторе").fill("юрист");
    await page.locator("[data-nav-hit^=roles]").first().click();
    await expectPanel(page, "Карточка записи");
    await page.locator(".doc-tab", { hasText: "BPMN" }).click();
    await page.getByLabel("Поиск в навигаторе").fill("проверить");
    await page.locator("[data-nav-hit]:not([data-nav-hit*=\":\"])").first().click();
    await expectPanel(page, "Свойства элемента");
    await page.getByRole("button", { name: "100%", exact: true }).click();
    expect(await page.locator(".bpe-toolbar .muted").first().innerText()).toBe("100%");
    await page.getByRole("button", { name: "Свернуть окно" }).click();
    await ctx.close();
  });
});