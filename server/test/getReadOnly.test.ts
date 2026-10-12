import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { startApp } from "./api.js";
import { REFERENCE_PROCESSES } from "../src/reference/index.js";

delete process.env.AUTH_USERS;

/**
 * GET-запросы не должны менять данные: cookie входа с SameSite=Lax уходит и при переходе по ссылке с чужого сайта, поэтому
 * GET, который что-то пишет, можно спровоцировать извне (CSRF). Тест вызывает каждый GET-маршрут и сравнивает снимок
 * всех таблиц базы до и после.
 */
async function getRoutes(): Promise<string[]> {
  const { app } = await import("../src/app.js");
  const out: string[] = [];
  const walk = (stack: any[], prefix: string) => {
    for (const layer of stack) {
      if (layer.route?.methods?.get && typeof layer.route.path === "string") out.push(prefix + layer.route.path);
      else if (layer.handle?.stack) walk(layer.handle.stack, prefix + ((layer.regexp?.source ?? "").includes("api") ? "/api" : ""));
    }
  };
  walk((app as any)._router.stack, "");
  return [...new Set(out)].filter((p) => p.startsWith("/api"));
}

/** Хэш содержимого каждой таблицы (кроме служебных sqlite_*). */
async function snapshot(): Promise<Map<string, string>> {
  const { db } = await import("../src/db.js");
  const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all() as { name: string }[]).map((t) => t.name);
  const out = new Map<string, string>();
  for (const t of tables) out.set(t, createHash("sha1").update(JSON.stringify(db.prepare(`SELECT * FROM "${t}"`).all())).digest("hex"));
  return out;
}

let app: Awaited<ReturnType<typeof startApp>>;
let sessionId = "";
let roleId = "";
beforeAll(async () => {
  app = await startApp();
  const s = (await app.call("POST", "/sessions/blank", { meta: { processName: "GET без записи" } })).body;
  const model = REFERENCE_PROCESSES.demo.build();
  expect((await app.call("PUT", `/sessions/${s.id}/model`, model, { "X-Base-Updated-At": s.updatedAt })).status).toBe(200);
  await app.call("POST", `/sessions/${s.id}/rebuild-diagrams`);
  sessionId = s.id;
  roleId = model.roles[0].id;
}, 60_000);
afterAll(() => app?.close());

/** Таблицы, куда GET вправе писать: служебные журналы и кэш, не пользовательские данные. */
const ALLOWED = new Set<string>([]);

describe("GET-запросы не меняют данные", () => {
  it("ни один GET-маршрут не пишет в базу (по снимку всех таблиц до и после)", async () => {
    const routes = await getRoutes();
    expect(routes.length).toBeGreaterThan(50);
    const findings: string[] = [];
    for (const route of routes) {
      const url = route
        .replace(/^\/api/, "")
        .replace(":id", sessionId)
        .replace(":asIsId", sessionId)
        .replace(":toBeId", sessionId)
        .replace(":roleId", roleId)
        .replace(":diagram", "decomposition")
        .replace(/:[A-Za-z]+/g, "x");
      const before = await snapshot();
      await app.raw(url).catch(() => null);
      const after = await snapshot();
      for (const [table, hash] of after) if (before.get(table) !== hash && !ALLOWED.has(table)) findings.push(`${route} → изменилась таблица ${table}`);
    }
    expect(findings).toEqual([]);
  }, 300_000);
});
