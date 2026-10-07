import { mkdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "playwright";
import { WEB, api, expectPanel, launch, openContext } from "./env";

let browser: Browser;
beforeAll(async () => {
  browser = await launch();
});
afterAll(async () => {
  await browser?.close();
});

const node = (id: string, extra: Record<string, unknown> = {}) => ({ id, type: "task", name: id, status: "confirmed", confidence: 1, ...extra });

/** Процесс B002 по структуре Соглашения: у операции B002.01.01 — диаграмма BPMN с документами, хранилищем, граничным событием и внешним пулом. */
function structured(base: any) {
  return {
    ...base,
    process: { ...base.process, code: "B002.00.00", name: "Управление процессами" },
    roles: [
      { id: "r1", name: "Начальник отдела корпоративных технологий" },
      { id: "r2", name: "Специалист отдела корпоративных технологий" },
    ],
    systems: [{ id: "sys1", name: "ELMA365" }],
    data: [
      { id: "d1", name: "Информация о выявленном процессе" },
      { id: "d2", name: "Актуальный реестр процессов" },
    ],
    nodes: [
      node("s1", { name: "Моделирование процесса" }),
      node("o1", { name: "Актуализация реестра процессов", idef0_parent: "s1", role_id: "r2" }),
      node("b0", { type: "event", subtype: "start", name: "Информация получена", bpmn_scope: "o1", role_id: "r2" }),
      node("b1", { name: "Открыть реестр", subtype: "user", bpmn_scope: "o1", role_id: "r2", inputs: ["d1"], system_ids: ["sys1"] }),
      node("b2", { name: "Внести код процесса", subtype: "send", bpmn_scope: "o1", role_id: "r2", outputs: ["d2"] }),
      node("b3", { name: "Напомнить исполнителю", bpmn_scope: "o1", role_id: "r2" }),
      node("be", { type: "event", subtype: "timer", name: "Срок истёк", bpmn_scope: "o1", role_id: "r2", attached_to: "b1", interrupting: false }),
      node("b9", { type: "event", subtype: "end", name: "Реестр актуализирован", bpmn_scope: "o1", role_id: "r2" }),
    ],
    flows: [
      { id: "f1", from: "b0", to: "b1" },
      { id: "f2", from: "b1", to: "b2" },
      { id: "f3", from: "be", to: "b3" },
      { id: "f4", from: "b3", to: "b9" },
      { id: "f5", from: "b2", to: "b9" },
    ],
    assignments: [{ node_id: "o1", role_id: "r2", kind: "executor", functions: [] }],
    pools: [{ id: "pool1", name: "Анализ эффективности процессной модели", code: "B002.02.01" }],
    messages: [{ id: "msg1", from: "b2", to: "pool1", name: "Запрос на анализ" }],
  };
}

describe("элементы BPMN по Соглашению в браузере", () => {
  it("диаграмма операции: документы, хранилище, граничное событие, внешний пул; правка граничного события; выгрузка BPMN", async () => {
    const created = await api<{ id: string; updatedAt: string; model: any }>("POST", "/sessions/blank", { meta: { processName: "Управление процессами" } });
    const id = created.body.id;
    const put = await api("PUT", `/sessions/${id}/model`, structured(created.body.model), { "X-Base-Updated-At": created.body.updatedAt });
    expect(put.status).toBe(200);

    const { ctx, page, errors } = await openContext(browser);
    await page.goto(`${WEB}/s/${id}`);
    await page.locator(".studio").waitFor();
    await page.locator('[data-nav-bpmn="o1"]').click();
    await page.locator('.studio g[data-node-id="b1"]').waitFor();

    // шаги, значки документов и хранилища, пул и граничное событие на границе задачи
    expect(await page.locator(".studio g[data-node-id]").evaluateAll((els) => els.map((e) => e.getAttribute("data-node-id")).sort())).toEqual(["b0", "b1", "b2", "b3", "b9", "be"]);
    expect(await page.locator("[data-artifact]").evaluateAll((els) => els.map((e) => `${e.getAttribute("data-artifact")}:${e.getAttribute("data-artifact-kind")}`))).toEqual(["b1:input", "b1:store", "b2:output"]);
    expect(await page.locator("[data-pool-id]").textContent()).toContain("B002.02.01 Анализ эффективности процессной модели");
    const host = (await page.locator('.studio g[data-node-id="b1"] rect:not([fill="transparent"])').boundingBox())!;
    const boundary = (await page.locator('.studio g[data-node-id="be"] circle').first().boundingBox())!;
    expect(Math.abs(boundary.y + boundary.height / 2 - (host.y + host.height))).toBeLessThan(2);

    const shot = process.env.E2E_SHOTS;
    if (shot) {
      mkdirSync(shot, { recursive: true });
      await page.locator(".bpe-canvas").first().screenshot({ path: `${shot}/bpmn-o1.png` });
    }

    // граничное событие: выбор открывает панель, вид и прерывание меняются, граница остаётся у задачи
    await page.locator('.studio g[data-node-id="be"]').click();
    await expectPanel(page, "Свойства элемента");
    const interrupting = page.getByLabel(/Прерывает задачу/);
    expect(await interrupting.isChecked()).toBe(false);
    await interrupting.check();
    expect(await page.locator('.studio g[data-node-id="be"] circle').first().getAttribute("stroke-dasharray")).toBeNull();

    // проверки: в модели нет замечаний по граничному событию и достижимости
    expect(await page.locator(".problems, .validation-item").allInnerTexts().then((t) => t.join("\n"))).not.toMatch(/недостижим/);

    // сохранить и выгрузить BPMN операции: граничное событие, хранилище и свёрнутый пул в XML
    await page.getByTitle("Сохранить (Ctrl+S)").click();
    await page.getByText(/сохранено/).first().waitFor();
    const xml = await (await fetch(`${WEB.replace("localhost:15173", "127.0.0.1:18787")}/api/sessions/${id}/export/bpmn?scope=o1`, { headers: { Cookie: (await ctx.cookies()).map((c) => `${c.name}=${c.value}`).join("; ") } })).text();
    expect(xml).toMatch(/<bpmn:boundaryEvent id="Node_be"[^>]*attachedToRef="Node_b1" cancelActivity="true"/);
    expect(xml).toMatch(/<bpmn:dataStoreReference id="StoreRef_b1_sys1" name="ELMA365"/);
    expect(xml).toContain('<bpmn:participant id="Pool_pool1" name="B002.02.01 Анализ эффективности процессной модели" />');
    expect(xml).toMatch(/<bpmn:messageFlow id="Msg_msg1" name="Запрос на анализ" sourceRef="Node_b2" targetRef="Pool_pool1"/);
    expect(errors).toEqual([]);
    await ctx.close();
  });
});
