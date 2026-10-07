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
