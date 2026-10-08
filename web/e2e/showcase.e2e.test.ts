import { mkdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "playwright";
import { demoModel } from "../../server/src/reference/demo";
import { WEB, api, launch, openContext } from "./env";

let browser: Browser;
beforeAll(async () => {
  browser = await launch();
});
afterAll(async () => {
  await browser?.close();
});

type Pt = [number, number];
/** Линии стрелок, нарисованные в редакторе: начало, конец и отрезки — из атрибута d. */
const parsePath = (d: string): Pt[] => d.split(/[ML]/).filter(Boolean).map((p) => p.trim().split(" ").map(Number) as Pt);

describe("демонстрационный процесс C090 в студии", () => {
  it("дерево по кодам, нулевые замечания и одно принятое, диаграммы со всеми видами событий, шлюзов и задач", async () => {
    const created = await api<{ id: string; updatedAt: string }>("POST", "/sessions/blank", { meta: { processName: "C090" } });
    const id = created.body.id;
    expect((await api("PUT", `/sessions/${id}/model`, demoModel(), { "X-Base-Updated-At": created.body.updatedAt })).status).toBe(200);

    const { ctx, page, errors } = await openContext(browser);
    await page.goto(`${WEB}/s/${id}`);
    await page.locator(".studio").waitFor();
    await page.waitForLoadState("networkidle");

    // дерево: группа → процесс → подпроцессы → операции → диаграммы
    expect(await page.locator("[data-nav-group] .nav-name").innerText()).toBe("Демонстрационные процессы");
    expect(await page.locator("[data-nav-process] .nav-code").innerText()).toBe("C090.00.00");
    expect(await page.locator("[data-nav-fn] .nav-code").allTextContents()).toEqual(["C090.01.00", "C090.01.01", "C090.01.02", "C090.02.00", "C090.02.01", "C090.02.02", "C090.03.00", "C090.03.01", "C090.03.02"]);
    expect(await page.locator("[data-nav-bpmn]").count()).toBe(6);

    // проверки: ни ошибок, ни предупреждений; осознанное отступление принято с причиной
    const status = await page.locator(".statusbar").innerText();
    expect(status).toMatch(/ошибок: 0/);
    expect(status).toMatch(/предупреждений: 0/);
    expect(status).toMatch(/принято: 1/);
    await page.getByLabel(/принятые \(1\)/).check();
    expect(await page.locator("[data-accepted-rule='bpmn_xor_after_task']").innerText()).toContain("Статус поставки приходит от поставщика");

    const shot = process.env.E2E_SHOTS;
    if (shot) mkdirSync(shot, { recursive: true });
    const seen = new Set<string>();
    const open = async (op: string) => {
      await page.locator(`[data-nav-bpmn="${op}"]`).click();
      await page.locator(".bpe-svg").waitFor();
      await page.locator(`.studio g[data-node-id^="${op}_"]`).first().waitFor();
      for (const t of await page.locator(".studio [data-trigger]").evaluateAll((els) => els.map((e) => `${e.getAttribute("data-trigger")}${e.getAttribute("data-throwing") ? ":throw" : ""}`))) seen.add(t);
      if (shot) {
        await page.getByRole("button", { name: "100%" }).first().click().catch(() => {});
        await page.locator(".bpe-canvas").first().screenshot({ path: `${shot}/demo-${op}.png` });
      }
    };
    // нарисованные стрелки каждой диаграммы: никто не выходит из одной точки, не входит в одну и не лежит на другой линии
    const drawn = async () => (await page.locator(".studio g[data-flow-id] path[marker-end]").evaluateAll((els) => els.map((e) => e.getAttribute("d") ?? ""))).map(parsePath);
    const problems = (paths: Pt[][]) => {
      const out: string[] = [];
      const near = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 5;
      for (let i = 0; i < paths.length; i++) {
        for (let j = i + 1; j < paths.length; j++) {
          if (near(paths[i][0], paths[j][0])) out.push(`общий выход ${i}/${j}`);
          if (near(paths[i].at(-1)!, paths[j].at(-1)!)) out.push(`общий вход ${i}/${j}`);
          for (let a = 0; a + 1 < paths[i].length; a++) {
            for (let b = 0; b + 1 < paths[j].length; b++) {
              const [p, q, r, u] = [paths[i][a], paths[i][a + 1], paths[j][b], paths[j][b + 1]];
              const horizontal = p[1] === q[1];
              if (horizontal !== (r[1] === u[1])) continue;
              const k = horizontal ? 1 : 0;
              const m = 1 - k;
              if (Math.abs(p[k] - r[k]) < 3 && Math.min(Math.max(p[m], q[m]), Math.max(r[m], u[m])) - Math.max(Math.min(p[m], q[m]), Math.min(r[m], u[m])) > 2) out.push(`наложение ${i}/${j}`);
            }
          }
        }
      }
      return out;
    };
    for (const op of ["o11", "o12", "o21", "o22", "o31", "o32"]) {
      await open(op);
      const paths = await drawn();
      expect(paths.length, op).toBeGreaterThan(5);
      expect(problems(paths), op).toEqual([]);
    }

    // все значки триггеров, кроме отмены; залитые (выбрасывающие) — у отправки, конца, эскалации, компенсации, ссылки
    const base = new Set([...seen].map((t) => t.replace(":throw", "")));
    for (const t of ["conditional", "signal", "message", "timer", "escalation", "terminate", "error", "link", "multiple", "parallel_multiple", "compensation"]) expect(base.has(t), t).toBe(true);
    for (const t of ["message:throw", "signal:throw", "escalation:throw", "terminate:throw", "error:throw", "link:throw", "compensation:throw"]) expect(seen.has(t), t).toBe(true);
    expect(seen.has("timer:throw")).toBe(false); // таймер не выбрасывают
    expect(seen.has("conditional:throw")).toBe(false);    // шлюзы и задачи разных видов на диаграммах
    await page.locator('[data-nav-bpmn="o22"]').click();
    await page.locator('.studio g[data-node-id="o22_split"]').waitFor();
    // свёрнутые внешние пулы и потоки сообщений
    await page.locator('[data-nav-bpmn="o21"]').click();
    await page.locator('.studio g[data-node-id="o21_send"]').waitFor();
    expect(await page.locator("[data-pool-id]").textContent()).toContain("Поставщики");
    expect(errors).toEqual([]);
    await ctx.close();
  });
});
