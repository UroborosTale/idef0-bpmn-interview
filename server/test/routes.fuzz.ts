import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApp } from "./api.js";
import { REFERENCE_PROCESSES } from "../src/reference/index.js";

delete process.env.AUTH_USERS;

type Route = { method: string; path: string };

/** Все маршруты приложения: обход стека Express (вложенные роутеры смонтированы на /api). */
async function listRoutes(): Promise<Route[]> {
  const { app } = await import("../src/app.js");
  const out: Route[] = [];
  const walk = (stack: any[], prefix: string) => {
    for (const layer of stack) {
      if (layer.route) {
        for (const m of Object.keys(layer.route.methods)) out.push({ method: m.toUpperCase(), path: prefix + layer.route.path });
      } else if (layer.handle?.stack) {
        // путь монтирования роутера восстанавливаем из регулярного выражения слоя
        const src: string = layer.regexp?.source ?? "";
        const mount = src.includes("api") ? "/api" : "";
        walk(layer.handle.stack, prefix + mount);
      }
    }
  };
  walk((app as any)._router.stack, "");
  return out.filter((r) => typeof r.path === "string");
}

let app: Awaited<ReturnType<typeof startApp>>;
let demoId = "";
let textId = "";
const findings: string[] = [];

beforeAll(async () => {
  app = await startApp();
  const s = (await app.call("POST", "/sessions/blank", { meta: { processName: "Демо для фаззинга" } })).body;
  const model = REFERENCE_PROCESSES.demo.build();
  const put = await app.call("PUT", `/sessions/${s.id}/model`, model, { "X-Base-Updated-At": s.updatedAt });
  expect(put.status).toBe(200);
  await app.call("POST", `/sessions/${s.id}/rebuild-diagrams`);
  demoId = s.id;
  // сессия с текстом интервью: офлайн-извлечение
  const t = (await app.call("POST", "/sessions", { mode: "A", meta: { processName: "Закупка", modelType: "AS-IS", decompositionDepth: 2, notations: ["IDEF0", "BPMN"] } })).body;
  textId = t.id;
  await app.call("POST", `/sessions/${t.id}/ingest-text`, { text: "Менеджер получает заявку от клиента. Затем бухгалтер проверяет счёт в 1С. Если сумма больше 100 тысяч, директор согласует договор. Юрист подписывает договор." });
  const run = await app.call("POST", `/sessions/${t.id}/run`, {});
  if (run.body?.jobId || run.body?.id) {
    const jobId = run.body.jobId ?? run.body.id;
    for (let i = 0; i < 60; i++) {
      const j = await app.call("GET", `/jobs/${jobId}`);
      if (j.body?.status !== "running") break;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}, 120_000);
afterAll(() => app?.close());

const TYPE_CONFUSED = {
  text: 123, xml: { a: 1 }, content: ["x"], format: "vsdx", name: { x: 1 }, title: 7, meta: "x", model: "x", id: { x: 1 }, ids: "x", items: "x",
  answer: { a: 1 }, question: 5, status: "zzz", seq: "x", note: { a: 1 }, url: "http://x.invalid/", webhook_url: 5, csv: 5, rows: 5, value: { a: 1 },
  kind: { a: 1 }, code: [], level: 9, role: {}, respondentId: [], trackId: 5, gapId: {}, nodeId: [], entityId: 5, intoId: {}, class: [], synonyms: "x",
  description: [], owner: {}, comment: [], text2: null, element_id: 5, steps: "x", route: 5, mode: 7, scope: [], limit: "x", from: {}, to: [],
};
const NULLS = Object.fromEntries(Object.keys(TYPE_CONFUSED).map((k) => [k, null]));
const BIG = { text: "я".repeat(200_000), name: "x".repeat(50_000), title: "x".repeat(50_000) };

function fillPath(path: string, sessionId: string): string {
  return path
    .replace(/:id\b/g, sessionId)
    .replace(/:sessionId\b/g, sessionId)
    .replace(/:diagram\b/g, "decomposition")
    .replace(/:kind\b/g, "roles")
    .replace(/:(\w+)/g, "x-не-существует");
}

describe("фаззинг API: ни один маршрут не отвечает 500 и не зависает на некорректных данных", () => {
  it("обход всех маршрутов", async () => {
    const routes = await listRoutes();
    expect(routes.length).toBeGreaterThan(150);
    // удаления — в конце, чтобы не уничтожить сессии раньше времени
    const ordered = [...routes.filter((r) => r.method !== "DELETE"), ...routes.filter((r) => r.method === "DELETE")];
    const skip = [/\/auth\/logout/, /\/backup/, /\/restore/];
    const bodies: [string, unknown][] = [
      ["без тела", undefined],
      ["{}", {}],
      ["массив", [1, 2]],
      ["перепутаны типы", TYPE_CONFUSED],
      ["null в полях", NULLS],
      ["огромные строки", BIG],
    ];
    let calls = 0;
    for (const r of ordered) {
      if (skip.some((re) => re.test(r.path))) continue;
      if (!r.path.startsWith("/api/")) continue;
      for (const sid of [demoId, textId, "нет-такой"]) {
        const url = fillPath(r.path.replace(/^\/api/, ""), sid);
        const variants = r.method === "GET" || r.method === "DELETE" ? [["без тела", undefined] as [string, unknown], ["мусорный запрос", "?scope=%00zz&q[]=1&limit=-5&class[]=a&page=NaN"] as [string, unknown]] : bodies;
        for (const [label, body] of variants) {
          calls++;
          const isQuery = typeof body === "string" && body.startsWith("?");
          const t0 = Date.now();
          let res: { status: number; body: any };
          try {
            res = await Promise.race([
              app.call(r.method, isQuery ? url + body : url, isQuery ? undefined : body),
              new Promise<never>((_, rej) => setTimeout(() => rej(new Error("ЗАВИС > 15 с")), 15_000)),
            ]);
          } catch (e) {
            findings.push(`${r.method} ${r.path} [${sid === demoId ? "демо" : sid === textId ? "текст" : "нет сессии"}; ${label}] → ${(e as Error).message}`);
            continue;
          }
          if (res.status >= 500 && res.status !== 501) {
            const msg = typeof res.body === "object" ? res.body?.error : String(res.body).slice(0, 120);
            findings.push(`${r.method} ${r.path} [${sid === demoId ? "демо" : sid === textId ? "текст" : "нет сессии"}; ${label}] → ${res.status}: ${String(msg).slice(0, 160)}`);
          }
          if (Date.now() - t0 > 5000) findings.push(`${r.method} ${r.path} [${label}] — медленно: ${Date.now() - t0} мс`);
        }
      }
    }
    // сервер жив после всего
    expect((await app.call("GET", "/health")).status).toBe(200);
    console.log(`вызовов: ${calls}, маршрутов: ${routes.length}, находок: ${findings.length}`);
    // группировка по маршруту, чтобы видеть уникальные ошибки
    const uniq = new Map<string, string>();
    for (const f of findings) {
      const key = f.replace(/\[[^\]]*\]/, "").replace(/→.*$/, "");
      if (!uniq.has(key)) uniq.set(key, f);
    }
    console.log([...uniq.values()].join("\n"));
    expect(findings.filter((f) => !/медленно/.test(f))).toEqual([]);
  }, 900_000);
});
