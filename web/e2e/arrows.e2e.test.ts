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
  const step = (id: string, name: string, role: string, x: number, y: number, extra: Record<string, unknown> = {}) => node(id, { name, bpmn_scope: "o1", role_id: role, layout: { x, y }, ...extra });
  const model = {
    ...base,
    process: { ...base.process, code: "B002.00.00", name: "Управление процессами" },
    roles: [{ id: "r1", name: "Начальник отдела" }, { id: "r2", name: "Специалист отдела" }],
    nodes: [
      node("s1", { name: "Моделирование процесса" }),
      node("o1", { name: "Актуализация реестра", idef0_parent: "s1", role_id: "r1" }),
      step("t1", "Открыть реестр", "r1", 200, 100),
      step("t2", "Внести код процесса", "r2", 480, 250),
      step("t3", "Проверить реестр", "r2", 760, 250),
    ],
    flows: [
      { id: "f1", from: "t1", to: "t2" },
      { id: "f2", from: "t2", to: "t3" },
    ],
    assignments: [{ node_id: "o1", role_id: "r1", kind: "executor", functions: [] }, { node_id: "o1", role_id: "r2", kind: "coexecutor", functions: [] }],
  };
  expect((await api("PUT", `/sessions/${created.body.id}/model`, model, { "X-Base-Updated-At": created.body.updatedAt })).status).toBe(200);
  return created.body.id;
}

const box = async (page: Page, selector: string) => (await page.locator(selector).first().boundingBox())!;
const nodeBox = (page: Page, id: string) => box(page, `.studio g[data-node-id="${id}"] rect:not([fill="transparent"])`);
async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + (to.x > from.x ? 4 : -4), from.y + (to.y > from.y ? 4 : -4), { steps: 2 });
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
}
/** Щелчок ровно по линии стрелки: точка на середине пути, пересчитанная в координаты экрана. */
async function clickFlow(page: Page, id: string) {
  const p = await page.locator(`.studio [data-flow-id="${id}"] path`).nth(1).evaluate((el) => {
    const path = el as unknown as SVGPathElement;
    const pt = path.getPointAtLength(path.getTotalLength() * 0.3);
    const m = path.getScreenCTM()!;
    return { x: pt.x * m.a + pt.y * m.c + m.e, y: pt.x * m.b + pt.y * m.d + m.f };
  });
  await page.mouse.click(p.x, p.y);
}
/** Диаграмма крупно: на 100 % ручки и стороны фигур различимы. */
async function actualSize(page: Page) {
  await page.setViewportSize({ width: 2000, height: 1100 });
  await page.getByRole("button", { name: "100%" }).first().click();
  await page.waitForTimeout(200);
}
const center = (b: { x: number; y: number; width: number; height: number }) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

describe("правка стрелок и триггеры блока в браузере", () => {
  it("сдвиг среднего участка, перенос конца на другую сторону, сброс маршрута; всё сохраняется", async () => {
    const id = await seeded();
    const { ctx, page, errors } = await openContext(browser);
    await page.goto(`${WEB}/s/${id}`);
    await page.locator(".studio").waitFor();
    await page.waitForLoadState("networkidle");
    await page.locator('[data-nav-bpmn="o1"]').click();
    await page.locator('.studio g[data-node-id="t2"]').waitFor();
    await actualSize(page);

    // выбор стрелки: появляются ручки обоих концов и отрезков
    const flowPath = '.studio [data-flow-id="f1"] path[marker-end]';
    await clickFlow(page, "f1");
    await page.locator('[data-flow-handle^="seg:"]').first().waitFor();
    expect(await page.locator('[data-flow-handle="from"]').count()).toBe(1);
    expect(await page.locator('[data-flow-handle="to"]').count()).toBe(1);
    await page.getByRole("toolbar", { name: "Действия со стрелкой" }).getByText("Маршрут автоматический").waitFor();

    // сдвиг отрезка поперёк: у стрелки появляется ручной маршрут, линия смещается
    const seg = page.locator('[data-flow-handle^="seg:"]').first();
    const vertical = (await seg.evaluate((el) => getComputedStyle(el).cursor)) === "ew-resize";
    const dBefore = await page.locator(flowPath).getAttribute("d");
    const before = center((await seg.boundingBox())!);
    await drag(page, before, vertical ? { x: before.x + 60, y: before.y } : { x: before.x, y: before.y + 60 });
    await page.getByRole("toolbar", { name: "Действия со стрелкой" }).getByText("Маршрут задан вручную").waitFor();
    expect(await page.locator(flowPath).getAttribute("d")).not.toBe(dBefore);

    // перенос конца-входа на верхнюю сторону той же фигуры: стрелка входит в блок сверху
    const t2 = await nodeBox(page, "t2");
    await drag(page, center(await box(page, '[data-flow-handle="to"]')), { x: t2.x + t2.width / 2, y: t2.y + 3 });
    await page.locator("[data-flow-ghost]").waitFor({ state: "detached" });
    const end = await page.locator(flowPath).evaluate((el) => {
      const pts = el.getAttribute("d")!.split(/[ML]/).filter(Boolean).map((p) => p.trim().split(" ").map(Number));
      return pts[pts.length - 1];
    });
    expect(Math.abs(end[1] - 0)).toBeGreaterThan(0);
    await page.getByTitle("Сохранить (Ctrl+S)").click();
    await page.getByText(/сохранено/).first().waitFor();
    let saved = await api<any>("GET", `/sessions/${id}`);
    const route = saved.body.model.flows.find((f: any) => f.id === "f1").route;
    expect(route.to_side).toBe("T");
    expect(route.channel === undefined || typeof route.channel === "number").toBe(true);

    // перенос начала стрелки на другую фигуру
    await drag(page, center(await box(page, '[data-flow-handle="from"]')), center(await nodeBox(page, "t3")));
    saved = await api<any>("GET", `/sessions/${id}`);
    await page.getByTitle("Сохранить (Ctrl+S)").click();
    await page.getByText(/сохранено/).first().waitFor();
    saved = await api<any>("GET", `/sessions/${id}`);
    expect(saved.body.model.flows.find((f: any) => f.id === "f1")).toMatchObject({ from: "t3", to: "t2" });

    // сброс маршрута возвращает автоматическую прокладку
    await page.getByRole("toolbar", { name: "Действия со стрелкой" }).getByText("Сбросить маршрут").click();
    await page.getByRole("toolbar", { name: "Действия со стрелкой" }).getByText("Маршрут автоматический").waitFor();
    await page.getByTitle("Сохранить (Ctrl+S)").click();
    await page.getByText(/сохранено/).first().waitFor();
    saved = await api<any>("GET", `/sessions/${id}`);
    expect(saved.body.model.flows.find((f: any) => f.id === "f1").route ?? null).toBeNull();
    expect(errors).toEqual([]);
    await ctx.close();
  });

  it("триггер блока: значок вместо фигуры и стрелки; удаление возвращает прямую стрелку; в файле BPMN остаётся событие", async () => {
    const id = await seeded();
    const { ctx, page, errors } = await openContext(browser);
    await page.goto(`${WEB}/s/${id}`);
    await page.locator(".studio").waitFor();
    await page.waitForLoadState("networkidle");
    await page.locator('[data-nav-bpmn="o1"]').click();
    await page.locator('.studio g[data-node-id="t3"]').waitFor();
    await actualSize(page);
    const shapes = () => page.locator(".studio g[data-node-id]").count();
    const arrows = () => page.locator(".studio [data-flow-id]").count();
    const [s0, a0] = [await shapes(), await arrows()];

    await page.locator('.studio g[data-node-id="t3"]').click();
    await page.locator(".props-vtab", { hasText: "Дополнительно" }).click(); // раздел — на вкладке «Дополнительно»
    await page.locator("summary", { hasText: "Триггеры блока" }).click(); // раздел свёрнут, пока у блока нет триггеров
    await page.getByRole("button", { name: "+ Таймер" }).first().click();
    await page.locator('[data-marker]').waitFor();
    expect(await shapes()).toBe(s0); // отдельной фигуры события нет
    expect(await arrows()).toBe(a0); // и стрелки «событие → блок» нет
    expect(await page.locator('[data-marker] [data-trigger="timer"]').count()).toBe(1);

    // параметры срока — в карточке события (значок выбран после добавления)
    await page.locator(".props-vtab", { hasText: "Основные" }).click(); // карточка события — на вкладке «Основные»
    await page.getByLabel("Значение таймера").fill("P3D");
    await page.getByLabel("Значение таймера").press("Enter");
    await page.getByTitle("Сохранить (Ctrl+S)").click();
    await page.getByText(/сохранено/).first().waitFor();
    const cookie = (await ctx.cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
    const xml = await (await fetch(`http://127.0.0.1:18787/api/sessions/${id}/export/bpmn?scope=o1`, { headers: { Cookie: cookie } })).text();
    expect(xml).toMatch(/<bpmn:intermediateCatchEvent id="Node_n\d+"[^>]*><bpmn:timerEventDefinition><bpmn:timeDuration[^>]*>P3D</);
    expect(xml).toMatch(/<bpmn:sequenceFlow id="Flow_flow\d+" sourceRef="Node_n\d+" targetRef="Node_t3"/);

    // удаление значка: Delete на выбранном значке, прямая стрелка t2 → t3 сохранена
    await page.locator("[data-marker]").click();
    await page.locator(".bpe").first().focus();
    await page.keyboard.press("Delete");
    await page.locator("[data-marker]").waitFor({ state: "detached" });
    expect(await shapes()).toBe(s0);
    expect(await arrows()).toBe(a0);
    await page.getByTitle("Сохранить (Ctrl+S)").click();
    await page.getByText(/сохранено/).first().waitFor();
    const saved = await api<any>("GET", `/sessions/${id}`);
    expect(saved.body.model.flows.find((f: any) => f.id === "f2")).toMatchObject({ from: "t2", to: "t3" });
    expect(saved.body.model.nodes.some((n: any) => n.type === "event")).toBe(false);
    expect(errors).toEqual([]);
    await ctx.close();
  });
});
