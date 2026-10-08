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
const ev = (id: string, name: string, x: number, subtype: string, trigger?: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  node(id, { type: "event", subtype, name, bpmn_scope: "o1", role_id: "r2", layout: { x, y: 117 }, ...(trigger ? { trigger } : {}), ...extra });

const section = (page: Page) => page.locator("details.prop-section", { has: page.locator("summary", { hasText: "Событие и триггер" }) });

describe("события и триггеры в браузере", () => {
  it("значки по видам и направлениям, правка триггера в свойствах, сохранение и выгрузка BPMN с определениями", async () => {
    const created = await api<{ id: string; updatedAt: string; model: any }>("POST", "/sessions/blank", { meta: { processName: "Управление процессами" } });
    const id = created.body.id;
    const base = created.body.model;
    const model = {
      ...base,
      process: { ...base.process, code: "B002.00.00", name: "Управление процессами" },
      roles: [{ id: "r2", name: "Специалист отдела" }],
      nodes: [
        node("s1", { name: "Моделирование процесса" }),
        node("o1", { name: "Актуализация реестра", idef0_parent: "s1", role_id: "r2" }),
        ev("a", "Сообщение получено", 130, "start", { type: "message", name: "Заявка" }),
        ev("b", "Наступил срок", 230, "start", { type: "timer", timer: { kind: "date", value: "2026-12-31T09:00:00" } }),
        ev("c", "Срок наступил", 330, "intermediate", { type: "timer", direction: "catch", timer: { kind: "duration", value: "P3D" } }),
        ev("d", "Уведомление отправлено", 430, "intermediate", { type: "message", direction: "throw", name: "Уведомление" }),
        ev("e", "Условие выполнено", 530, "intermediate", { type: "conditional", direction: "catch", condition: "сумма > 100" }),
        ev("f", "Сигнал отправлен", 630, "intermediate", { type: "signal", direction: "throw", name: "Стоп" }),
        ev("g", "Вопрос эскалирован", 730, "intermediate", { type: "escalation", direction: "throw", name: "Директору" }),
        ev("h", "Процесс завершён с ошибкой", 830, "end", { type: "error", name: "E42" }),
        ev("i", "Процесс прекращён", 930, "end", { type: "terminate" }),
        ev("j", "Конец без триггера", 1030, "end"),
        node("t1", { name: "Проверить реестр", bpmn_scope: "o1", role_id: "r2", layout: { x: 330, y: 220 } }),
        ev("k", "Срок проверки истёк", 0, "intermediate", { type: "timer", timer: { kind: "duration", value: "PT2H" } }, { attached_to: "t1", interrupting: false, layout: null }),
      ],
      flows: [],
      assignments: [{ node_id: "o1", role_id: "r2", kind: "executor", functions: [] }],
    };
    expect((await api("PUT", `/sessions/${id}/model`, model, { "X-Base-Updated-At": created.body.updatedAt })).status).toBe(200);

    const { ctx, page, errors } = await openContext(browser);
    await page.goto(`${WEB}/s/${id}`);
    await page.locator(".studio").waitFor();
    await page.waitForLoadState("networkidle");
    await page.locator('[data-nav-bpmn="o1"]').click();
    await page.locator('.studio g[data-node-id="a"]').waitFor();

    // значки: ждущие — контур, выбрасывающие — залиты, у «без триггера» значка нет
    const trig = (n: string) => page.locator(`.studio g[data-node-id="${n}"] [data-trigger]`);
    expect(await trig("a").getAttribute("data-trigger")).toBe("message");
    expect(await trig("a").getAttribute("data-throwing")).toBeNull();
    expect(await trig("d").getAttribute("data-throwing")).toBe("true");
    expect(await trig("f").getAttribute("data-trigger")).toBe("signal");
    expect(await trig("i").getAttribute("data-trigger")).toBe("terminate");
    expect(await trig("j").count()).toBe(0);
    expect(await trig("k").getAttribute("data-trigger")).toBe("timer");
    expect(await page.locator('.studio g[data-node-id="b"] title').textContent()).toContain("Таймер: 2026-12-31T09:00:00");

    const shot = process.env.E2E_SHOTS;
    if (shot) {
      mkdirSync(shot, { recursive: true });
      await page.setViewportSize({ width: 2600, height: 950 });
      await page.getByRole("button", { name: "100%" }).first().click().catch(() => {});
      await page.locator(".bpe-canvas").first().screenshot({ path: `${shot}/bpmn-events.png` });
      await page.setViewportSize({ width: 1600, height: 950 });
    }

    // правка в свойствах: «Сигнал отправлен» → ждёт сообщение «Заявка принята»
    await page.locator('.studio g[data-node-id="f"]').click();
    await section(page).getByLabel("Направление").selectOption("catch");
    await section(page).getByLabel("Триггер", { exact: true }).selectOption("message");
    await section(page).getByLabel("Название сообщения").fill("Заявка принята");
    await section(page).getByLabel("Название сообщения").press("Enter");
    expect(await trig("f").getAttribute("data-trigger")).toBe("message");
    expect(await trig("f").getAttribute("data-throwing")).toBeNull();

    // недопустимый триггер виден как замечание проверки, а допустимый выбирается из списка
    await page.locator('.studio g[data-node-id="a"]').click();
    await section(page).getByLabel("Вид события").selectOption("end"); // сообщение у конечного допустимо
    expect(await section(page).getByLabel("Триггер", { exact: true }).inputValue()).toBe("message");
    await section(page).getByLabel("Триггер", { exact: true }).selectOption("terminate");
    await section(page).getByLabel("Вид события").selectOption("start"); // терминатор началу не подходит — триггер сбрасывается
    expect(await section(page).getByLabel("Триггер", { exact: true }).inputValue()).toBe("none");

    // сохранение и выгрузка BPMN операции
    await page.getByTitle("Сохранить (Ctrl+S)").click();
    await page.getByText(/сохранено/).first().waitFor();
    const saved = await api<any>("GET", `/sessions/${id}`);
    const f = saved.body.model.nodes.find((n: any) => n.id === "f");
    expect(f).toMatchObject({ subtype: "intermediate", trigger: { type: "message", direction: "catch", name: "Заявка принята" } });
    const cookie = (await ctx.cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
    const xml = await (await fetch(`http://127.0.0.1:18787/api/sessions/${id}/export/bpmn?scope=o1`, { headers: { Cookie: cookie } })).text();
    expect(xml).toMatch(/<bpmn:intermediateCatchEvent id="Node_c"[^>]*><bpmn:timerEventDefinition><bpmn:timeDuration xsi:type="bpmn:tFormalExpression">P3D</);
    expect(xml).toMatch(/<bpmn:intermediateThrowEvent id="Node_d"[^>]*><bpmn:messageEventDefinition messageRef="Message_\d+" \/>/);
    expect(xml).toMatch(/<bpmn:conditionalEventDefinition><bpmn:condition xsi:type="bpmn:tFormalExpression">сумма &gt; 100</);
    expect(xml).toMatch(/<bpmn:endEvent id="Node_h"[^>]*><bpmn:errorEventDefinition errorRef="Error_1" \/>/);
    expect(xml).toMatch(/<bpmn:endEvent id="Node_i"[^>]*><bpmn:terminateEventDefinition \/>/);
    expect(xml).toMatch(/<bpmn:boundaryEvent id="Node_k"[^>]*attachedToRef="Node_t1" cancelActivity="false"><bpmn:timerEventDefinition><bpmn:timeDuration[^>]*>PT2H</);
    expect(xml).toMatch(/<bpmn:message id="Message_\d+" name="Заявка принята" \/>/);
    expect(errors).toEqual([]);
    await ctx.close();
  });
});
