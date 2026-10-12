import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright";
import { c025Model } from "../../server/src/reference/c025";
import { API, WEB, api, launch, login, openContext } from "./env";

let browser: Browser;
beforeAll(async () => {
  browser = await launch();
});
afterAll(async () => {
  await browser?.close();
});

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function seed(): Promise<string> {
  const created = await api<{ id: string; updatedAt: string }>("POST", "/sessions/blank", { meta: { processName: "Обезьяна" } });
  const m: any = c025Model();
  const task = m.nodes.find((n: any) => n.type === "task" && n.bpmn_scope);
  if (task) {
    m.pools = [...(m.pools ?? []), { id: "pool_m", name: "Поставщики", scope: task.bpmn_scope }];
    m.messages = [...(m.messages ?? []), { id: "msg_m", from: task.id, to: "pool_m", name: "Запрос" }];
  }
  const put = await api("PUT", `/sessions/${created.body.id}/model`, m, { "X-Base-Updated-At": created.body.updatedAt });
  expect(put.status).toBe(200);
  return created.body.id;
}

const KEYS = ["Delete", "Escape", "Enter", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Control+z", "Control+y", "Control+Shift+z", "Control+c", "Control+v", "Control+x", "Control+d", "Control+a"];

/** Случайные действия по холсту, палитре и панели выделения открытого редактора. */
async function monkey(page: Page, r: () => number, steps: number, log: string[]) {
  const canvas = page.locator(".studio .bpe-canvas").first();
  const box = (await canvas.boundingBox())!;
  const at = () => [box.x + 10 + r() * (box.width - 20), box.y + 10 + r() * (box.height - 20)] as const;
  for (let i = 0; i < steps; i++) {
    const w = r();
    try {
      if (w < 0.25) {
        const [x, y] = at();
        log.push(`click ${Math.round(x)},${Math.round(y)}`);
        await page.mouse.click(x, y, { modifiers: r() < 0.15 ? ["Shift"] : [] });
      } else if (w < 0.35) {
        const [x, y] = at();
        log.push(`dblclick ${Math.round(x)},${Math.round(y)}`);
        await page.mouse.dblclick(x, y, { modifiers: r() < 0.3 ? ["Control"] : [] });
        await page.keyboard.type(r() < 0.5 ? "Правка" : "");
        await page.keyboard.press(r() < 0.7 ? "Enter" : "Escape");
      } else if (w < 0.6) {
        const [x1, y1] = at();
        const [x2, y2] = at();
        log.push(`drag ${Math.round(x1)},${Math.round(y1)}→${Math.round(x2)},${Math.round(y2)}`);
        await page.mouse.move(x1, y1);
        await page.mouse.down();
        await page.mouse.move((x1 + x2) / 2, (y1 + y2) / 2, { steps: 3 });
        await page.mouse.move(x2, y2, { steps: 3 });
        await page.mouse.up();
      } else if (w < 0.78) {
        const key = KEYS[Math.floor(r() * KEYS.length)];
        log.push(`key ${key}`);
        await page.locator(".studio .bpe").first().focus().catch(() => {});
        await page.keyboard.press(key);
      } else if (w < 0.9) {
        // кнопка палитры или панели выделения
        const buttons = page.locator(".studio .bpe-palette button:visible, .studio .bpe-selbar button:visible:enabled");
        const n = await buttons.count();
        if (n === 0) continue;
        const k = Math.floor(r() * n);
        log.push(`button ${(await buttons.nth(k).innerText().catch(() => "?")).slice(0, 30)}`);
        await buttons.nth(k).click({ timeout: 1500 }).catch(() => {});
      } else {
        // ручка выбранной стрелки или край листа — их тянут чаще, чем попадают случайно
        const handles = page.locator(".studio [data-flow-handle], .studio [data-ah], .studio [data-frame-resize], .studio [data-frame-move]");
        const n = await handles.count();
        if (n === 0) continue;
        const hb = await handles.nth(Math.floor(r() * n)).boundingBox();
        if (!hb) continue;
        const [x2, y2] = at();
        log.push(`handle →${Math.round(x2)},${Math.round(y2)}`);
        await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
        await page.mouse.down();
        await page.mouse.move(x2, y2, { steps: 4 });
        await page.mouse.up();
      }
    } catch (e) {
      log.push(`(действие не выполнено: ${(e as Error).message.split("\n")[0]})`);
    }
  }
}

describe("обезьяний тест редакторов: случайные действия не роняют интерфейс, сохранённая модель принимается сервером", () => {
  // сиды: по умолчанию один (обычный прогон), больше — E2E_MONKEY_SEEDS=11,23,37,41,59
  const SEEDS = (process.env.E2E_MONKEY_SEEDS ?? "23").split(",").map(Number).filter(Number.isFinite);
  for (const seedNo of SEEDS) {
    it(`сид ${seedNo}: BPMN операции и IDEF0, по 120 действий, затем сохранение`, async () => {
      const id = await seed();
      const { ctx, page, errors } = await openContext(browser);
      page.on("dialog", (d) => void d.accept().catch(() => {}));
      ctx.on("page", (p) => void p.close().catch(() => {})); // выгрузки открываются в новых вкладках
      await page.goto(`${WEB}/s/${id}`);
      await page.locator(".studio").waitFor();
      await page.waitForLoadState("networkidle");
      const r = rng(seedNo);
      const log: string[] = [];

      // BPMN: диаграмма операции с внешним пулом
      await page.locator("[data-nav-bpmn]").first().click();
      await page.locator(".studio svg.bpe-svg").first().waitFor();
      await monkey(page, r, 120, log);
      const bpmnErrors = [...errors];

      // IDEF0 A0
      errors.length = 0;
      await page.locator("[data-nav-process]").click();
      await page.locator(".studio svg.bpe-svg").first().waitFor();
      await monkey(page, r, 120, log);
      const idefErrors = [...errors];

      const crashed = await page.locator("text=/Что-то пошло не так|Произошла ошибка/i").count();
      // сохранение: сервер проверяет модель схемой — 400 означал бы, что редактор собрал недопустимую модель
      errors.length = 0;
      await page.keyboard.press("Escape");
      const save = page.getByTitle("Сохранить (Ctrl+S)");
      const putDone = page.waitForResponse((res) => res.url().includes(`/sessions/${id}/model`) && res.request().method() === "PUT", { timeout: 15000 }).catch(() => null);
      if (await save.isEnabled()) await save.click();
      const put = await putDone;
      const saveStatus = put ? put.status() : "не сохраняли (правок нет)";

      // выгрузки модели, «помятой» редактором: сервер не должен отвечать ошибкой
      const exportsFailed: string[] = [];
      if (put && put.status() === 200) {
        await api("POST", `/sessions/${id}/rebuild-diagrams`);
        for (const path of ["export/bpmn", "export/bpmn.zip", "export/model.json", "export/idef0/decomposition.svg", "export/idef0/context.svg", "export/idef0.drawio", "export/vsdx", "export/album.html"]) {
          // выгрузки — XML, ZIP, SVG, HTML: смотрим статус и непустое тело, без разбора JSON
          const res = await fetch(`${API}/sessions/${id}/${path}`, { headers: { Cookie: await login() } });
          const body = Buffer.from(await res.arrayBuffer());
          // архив диаграмм операций законно отказывает, если обезьяна удалила все операции (кнопки выгрузки тогда нет)
          if (path === "export/bpmn.zip" && res.status === 400 && body.toString("utf8").includes("нет операций")) continue;
          if (res.status !== 200 || body.byteLength === 0) exportsFailed.push(`${path}: ${res.status}, ${body.toString("utf8").slice(0, 120)}`);
        }
      }
      const report = { bpmnErrors, idefErrors, crashed, saveStatus, saveErrors: [...errors], exportsFailed };
      if (bpmnErrors.length || idefErrors.length || crashed || (put && put.status() !== 200) || exportsFailed.length) {
        throw new Error(`находки: ${JSON.stringify(report, null, 1)}\nпоследние действия: ${log.slice(-15).join(" | ")}`);
      }
      await ctx.close();
    }, 300_000);
  }
});
