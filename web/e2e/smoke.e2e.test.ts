import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright";
import { c025Model } from "../../server/src/reference/c025";
import { WEB, api, launch, openContext } from "./env";

let browser: Browser;
beforeAll(async () => {
  browser = await launch();
});
afterAll(async () => {
  await browser?.close();
});

/** Вкладки сессии (WorkspacePage.ALL_TABS) и самостоятельные страницы приложения. */
const TABS = [
  "text", "bpmn", "studio", "idef0", "model", "gaps", "validation", "export", "versions", "raci", "regulation",
  "multiInterview", "verification", "review", "analytics", "checklist", "traceability", "jobDescriptions", "agentRuns",
  "hypotheses", "mining", "bpms", "diagramReimport", "auditPackage",
];
const PAGES = ["/", "/new", "/registry", "/repository", "/glossary", "/notifications", "/requirements", "/checklist-rules", "/audit", "/technology"];

/** Модель C025 с тем, что добавлено в последних версиях: внешний пул и поток сообщений с ручным маршрутом, смещённые значки, рамка IDEF0. */
function richModel() {
  const m: any = c025Model();
  const fn = m.nodes.find((n: any) => n.type === "task" && !n.bpmn_scope === false) ?? m.nodes.find((n: any) => n.type === "task");
  m.pools = [...(m.pools ?? []), { id: "pool_smoke", name: "Поставщики", code: "S001", scope: fn?.bpmn_scope ?? "", dx: 40 }];
  if (fn) {
    m.messages = [...(m.messages ?? []), { id: "msg_smoke", from: fn.id, to: "pool_smoke", name: "Запрос предложений", route: { points: [[600, 700]] } }];
    fn.artifact_offsets = { ...(fn.artifact_offsets ?? {}), ...(fn.inputs?.[0] ? { [`input:${fn.inputs[0]}`]: { dx: 30, dy: -10 } } : {}) };
  }
  m.idef0_frames = { "": { texts: { title: "Лист для проверки" } } };
  return m;
}

async function openSession(): Promise<string> {
  const created = await api<{ id: string; updatedAt: string }>("POST", "/sessions/blank", { meta: { processName: "Smoke" } });
  const put = await api("PUT", `/sessions/${created.body.id}/model`, richModel(), { "X-Base-Updated-At": created.body.updatedAt });
  expect(put.status, JSON.stringify(put.body).slice(0, 300)).toBe(200);
  return created.body.id;
}

const boundary = (page: Page) => page.locator("text=/Что-то пошло не так|Произошла ошибка|Unexpected Application Error/i").count();

describe("обход интерфейса: ни одна вкладка и страница не пишет ошибок в консоль и не падает", () => {
  it("вкладки сессии и самостоятельные страницы", async () => {
    const id = await openSession();
    const { ctx, page, errors } = await openContext(browser);
    const problems: string[] = [];
    for (const tab of TABS) {
      errors.length = 0;
      await page.goto(`${WEB}/s/${id}?tab=${tab}`);
      await page.waitForLoadState("networkidle");
      if ((await boundary(page)) > 0) problems.push(`вкладка ${tab}: сработала страховка ErrorBoundary`);
      if (errors.length) problems.push(`вкладка ${tab}: ${errors.join(" | ")}`);
    }
    for (const path of PAGES) {
      errors.length = 0;
      await page.goto(`${WEB}${path}`);
      await page.waitForLoadState("networkidle");
      if ((await boundary(page)) > 0) problems.push(`страница ${path}: сработала страховка ErrorBoundary`);
      if (errors.length) problems.push(`страница ${path}: ${errors.join(" | ")}`);
    }
    expect(problems).toEqual([]);
    await ctx.close();
  });

  it("студия: каждый документ в дереве открывается, по фигурам, пулам, значкам и потокам можно щёлкать и править без ошибок", async () => {
    const id = await openSession();
    const { ctx, page, errors } = await openContext(browser);
    await page.goto(`${WEB}/s/${id}`);
    await page.locator(".studio").waitFor();
    await page.waitForLoadState("networkidle");
    const problems: string[] = [];

    // все диаграммы дерева: BPMN операций и IDEF0
    const bpmnNav = await page.locator("[data-nav-bpmn]").count();
    for (let i = 0; i < bpmnNav; i++) {
      errors.length = 0;
      await page.locator("[data-nav-bpmn]").nth(i).click();
      await page.locator(".studio svg.bpe-svg").first().waitFor();
      // щелчки по каждому виду объектов диаграммы
      for (const sel of ["[data-node-id]", "[data-artifact]", "[data-pool-id]", "[data-message-id]", "[data-flow-id]"]) {
        const el = page.locator(`.studio ${sel}`).first();
        if ((await el.count()) === 0) continue;
        await el.click({ force: true, timeout: 3000 }).catch(() => {});
        await el.dblclick({ force: true, timeout: 3000 }).catch(() => {});
        await page.keyboard.press("Escape");
      }
      if (errors.length) problems.push(`BPMN #${i}: ${errors.join(" | ")}`);
    }
    for (const label of ["Внешний пул", "Поток сообщений"]) {
      const b = page.getByRole("button", { name: label });
      if ((await b.count()) > 0) {
        await b.first().click().catch(() => {});
        await page.keyboard.press("Escape");
      }
    }
    if (errors.length) problems.push(`палитра: ${errors.join(" | ")}`);

    errors.length = 0;
    const idefTabs = page.locator(".doc-tab", { hasText: "IDEF0" });
    const idefCount = await idefTabs.count();
    for (let i = 0; i < idefCount; i++) {
      await idefTabs.nth(i).click();
      await page.locator(".studio svg.bpe-svg").first().waitFor();
      await page.locator(".studio [data-frame-field]").first().dblclick({ force: true, timeout: 3000 }).catch(() => {});
      await page.keyboard.press("Escape");
      for (const name of ["Лист", "Миникарта"]) await page.locator(".studio summary, .studio button", { hasText: name }).first().click({ timeout: 2000 }).catch(() => {});
    }
    if (errors.length) problems.push(`IDEF0: ${errors.join(" | ")}`);

    // справочники и остальные документы окна студии (вкладки в строке документов)
    errors.length = 0;
    const tabs = page.locator(".doc-tab");
    const n = await tabs.count();
    for (let i = 0; i < n; i++) await tabs.nth(i).click({ timeout: 3000 }).catch(() => {});
    if (errors.length) problems.push(`документы студии: ${errors.join(" | ")}`);

    expect(problems).toEqual([]);
    await ctx.close();
  });
});
