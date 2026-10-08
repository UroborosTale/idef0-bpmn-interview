import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "playwright";
import { WEB, api, launch, openContext, seedSession, statusText } from "./env";

let browser: Browser;
beforeAll(async () => {
  browser = await launch();
});
afterAll(async () => {
  await browser?.close();
});

describe("предложения агентов в студии", () => {
  it("агент присылает правки: аналитик применяет одну (в черновик, затем сохраняет) и отклоняет другую с причиной", async () => {
    const id = await seedSession("Согласование договора (агент)");
    const session = await api<{ model: { nodes: { id: string; name: string; type: string }[] } }>("GET", `/sessions/${id}`);
    const task = session.body.model.nodes.find((n) => n.type === "task")!;

    // агент (по тому же API, что и MCP-сервер) отправляет два предложения
    const rename = await api<{ id: string }>("POST", `/agent/sessions/${id}/proposals`, {
      agent: "нормоконтролёр",
      title: "Уточнить название шага",
      rationale: "Название должно быть глаголом с объектом",
      ops: [{ op: "update", collection: "nodes", id: task.id, patch: { name: "Согласовать договор с юристом" } }],
    });
    expect(rename.status).toBe(201);
    const second = await api<{ id: string }>("POST", `/agent/sessions/${id}/proposals`, {
      agent: "моделист",
      title: "Удалить первый шаг",
      ops: [{ op: "remove", collection: "nodes", id: task.id }],
    });
    expect(second.status).toBe(201);

    const { ctx, page, errors } = await openContext(browser);
    await page.goto(`${WEB}/s/${id}`);
    await page.locator(".studio").waitFor();
    const button = page.locator(".ribbon-buttons button", { hasText: /^Предложения/ });
    await button.filter({ hasText: "(2)" }).waitFor();
    await button.click();
    await page.locator(".proposal").first().waitFor();
    expect(await page.locator(".proposal").count()).toBe(2);

    // применить переименование: правки в черновике, на сервере модель ещё прежняя
    await page.locator(".proposal", { hasText: "Уточнить название шага" }).getByRole("button", { name: "Применить" }).click();
    await page.locator(".proposal", { hasText: "Уточнить название шага" }).waitFor({ state: "detached" });
    expect(await statusText(page)).toMatch(/несохранённые/);
    expect((await api<any>("GET", `/sessions/${id}`)).body.model.nodes.find((n: any) => n.id === task.id).name).toBe(task.name);
    expect((await api<any>("GET", `/agent/proposals/${rename.body.id}`)).body.status).toBe("applied");

    await page.getByTitle("Сохранить (Ctrl+S)").click();
    await page.getByText(/сохранено/).first().waitFor();
    expect((await api<any>("GET", `/sessions/${id}`)).body.model.nodes.find((n: any) => n.id === task.id).name).toBe("Согласовать договор с юристом");

    // второе предложение теперь касается уже изменённой модели — отклоняем с причиной
    await page.locator(".proposal", { hasText: "Удалить первый шаг" }).getByRole("button", { name: "Отклонить…" }).click();
    await page.getByPlaceholder("Почему отклоняете — агент это увидит").fill("Шаг нужен: на нём держится согласование");
    await page.getByRole("button", { name: "Отклонить", exact: true }).click();
    await page.locator(".proposal").waitFor({ state: "detached" });
    const seen = await api<any>("GET", `/agent/proposals/${second.body.id}`);
    expect(seen.body).toMatchObject({ status: "rejected", reason: "Шаг нужен: на нём держится согласование" });
    expect(await page.locator(".ribbon-buttons button", { hasText: /^Предложения$/ }).count()).toBe(1);
    expect(errors).toEqual([]);
    await ctx.close();
  });
});

describe("задания агенту в студии", () => {
  it("аналитик ставит задание, агент берёт его и отвечает предложением, студия показывает статус и итог", async () => {
    const id = await seedSession("Согласование договора (задания)");
    const { ctx, page, errors } = await openContext(browser);
    await page.goto(`${WEB}/s/${id}`);
    await page.locator(".studio").waitFor();

    // поручение из студии
    await page.locator(".problems-head button", { hasText: "Задания агенту" }).click();
    await page.getByPlaceholder(/Что поручить агенту/).fill("Проверь названия шагов по Соглашению");
    await page.getByRole("button", { name: "Поручить" }).click();
    const card = page.locator(".task", { hasText: "Проверь названия шагов" });
    await card.waitFor();
    expect(await card.innerText()).toContain("ждёт агента");

    // агент: берёт задание, отправляет предложение, завершает
    const tasks = await api<{ id: string }[]>("GET", `/agent/sessions/${id}/tasks`);
    expect(tasks.body).toHaveLength(1);
    const tid = tasks.body[0].id;
    expect((await api("POST", `/agent/tasks/${tid}/take`, { agent: "нормоконтролёр" })).status).toBe(200);
    const model = (await api<any>("GET", `/sessions/${id}`)).body.model;
    const prop = await api("POST", `/agent/sessions/${id}/proposals`, {
      agent: "нормоконтролёр",
      title: "Уточнить цель процесса",
      task_id: tid,
      ops: [{ op: "set_process", patch: { goal: "Согласовать договор до подписания" } }],
    });
    expect(prop.status).toBe(201);
    expect((await api("POST", `/agent/tasks/${tid}/complete`, { note: "Названия в порядке; предложена цель процесса" })).status).toBe(200);
    void model;

    // студия подхватывает статус при следующем опросе — обновляем страницу, чтобы не ждать 8 секунд
    await page.reload();
    await page.locator(".studio").waitFor();
    await page.locator(".problems-head button", { hasText: "Задания агенту" }).click();
    const done = page.locator(".task", { hasText: "Проверь названия шагов" });
    await done.waitFor();
    const text = await done.innerText();
    expect(text).toContain("выполнено");
    expect(text).toContain("Итог агента: Названия в порядке; предложена цель процесса");
    expect(text).toContain("Уточнить цель процесса");
    expect(errors).toEqual([]);
    await ctx.close();
  });
});

describe("вопросы и отчёты агентов в студии", () => {
  it("интервьюер присылает вопросы, аналитик отмечает заданный и ответ; аналитик-агент присылает отчёт, студия показывает выводы и архив", async () => {
    const id = await seedSession("Согласование договора (вопросы)");
    const model = (await api<any>("GET", `/agent/sessions/${id}/model`)).body;
    const [fnId, fnCode] = Object.entries<string>(model.codes).find(([nid]) => model.model.nodes.some((n: any) => n.id === nid && n.type === "task"))!;

    // агенты (по тому же API, что и MCP-сервер) сохраняют вопросы и отчёт
    const qs = await api<any>("POST", `/agent/sessions/${id}/questions`, {
      agent: "интервьюер",
      questions: [
        { text: "Кто подписывает договор на стороне заказчика?", addressee: "Юрист", scope: fnCode, reason: "нет исполнителя", priority: "critical" },
        { text: "Сколько дней занимает согласование?", priority: "desirable" },
      ],
    });
    expect(qs.status).toBe(201);
    expect((await api<any>("POST", `/agent/sessions/${id}/reports`, {
      agent: "аналитик",
      title: "Узкие места согласования",
      summary: "Основное время — ожидание подписи",
      body: "Подробный разбор",
      findings: [{ what: "Ожидание подписи", where: fnCode, impact: "high", confidence: "medium", recommendation: "Ввести срок" }],
    })).status).toBe(201);

    const { ctx, page, errors } = await openContext(browser);
    await page.goto(`${WEB}/s/${id}`);
    await page.locator(".studio").waitFor();

    // вопросы: счётчик, порядок по важности, отметки
    const qTab = page.locator(".problems-head button", { hasText: "Вопросы" });
    await qTab.locator(".pill-count", { hasText: "2" }).waitFor(); // студия подтягивает записи сразу после открытия
    await qTab.click();
    const first = page.locator(".question").first();
    expect(await first.innerText()).toContain("Кто подписывает договор");
    expect(await first.innerText()).toContain("спросить: Юрист");
    await first.getByRole("button", { name: "Задан" }).click();
    await page.locator(".question", { hasText: "Кто подписывает" }).getByText("задан", { exact: true }).waitFor();
    await page.locator(".question", { hasText: "Сколько дней" }).getByRole("button", { name: "Получен ответ" }).click();
    await page.getByPlaceholder(/Ответ респондента/).fill("Три дня");
    await page.getByRole("button", { name: "Ответ получен" }).click();
    await page.getByLabel(/с отвеченными и снятыми/).check();
    await page.locator(".question", { hasText: "Сколько дней" }).getByText("Ответ: Три дня").waitFor();
    const stored = (await api<any[]>("GET", `/agent/sessions/${id}/questions`)).body;
    expect(stored.map((q) => q.status).sort()).toEqual(["answered", "asked"]);
    expect(stored.find((q) => q.status === "asked").scopeNodeId).toBe(fnId);

    // свой вопрос аналитика: форма, привязка к выделенной функции не нужна — вопрос к процессу в целом
    await page.getByPlaceholder(/Свой вопрос к интервью/).fill("Кто заменяет директора в отпуске?");
    await page.getByLabel("Кого спросить").fill("Секретарь");
    await page.getByRole("button", { name: "Добавить вопрос" }).click();
    const own = page.locator(".question", { hasText: "Кто заменяет директора" });
    await own.waitFor();
    expect(await own.innerText()).toContain("добавлен вручную");
    expect(await own.innerText()).toContain("спросить: Секретарь");
    expect((await api<any[]>("GET", `/agent/sessions/${id}/questions`)).body).toHaveLength(3);

    // отчёт: открытие отмечает прочитанным, архив убирает из списка
    const rTab = page.locator(".problems-head button", { hasText: "Отчёты" });
    await rTab.locator(".pill-count", { hasText: "1" }).waitFor();
    await rTab.click();
    await page.locator(".report-head", { hasText: "Узкие места согласования" }).click();
    await page.locator(".report-findings").waitFor();
    expect(await page.locator(".report-findings tbody").innerText()).toContain("Ввести срок");
    expect(await page.locator(".report-text").innerText()).toBe("Подробный разбор");
    await rTab.locator(".pill-count", { hasText: "0" }).waitFor();
    await page.getByRole("button", { name: "В архив" }).click();
    await page.locator(".report").waitFor({ state: "detached" });
    expect(((await api<any[]>("GET", `/agent/sessions/${id}/reports`)).body)[0].status).toBe("archived");
    expect(errors).toEqual([]);
    await ctx.close();
  });
});