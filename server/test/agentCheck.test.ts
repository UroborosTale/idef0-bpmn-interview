import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApp } from "./api.js";
import { checkAgentSetup, formatCheck } from "../src/mcp/check.js";
import { structuredModel } from "./fixtures.js";

delete process.env.AUTH_USERS;

describe("проверка готовности к подключению агента", () => {
  let app: Awaited<ReturnType<typeof startApp>>;
  beforeAll(async () => {
    app = await startApp();
    const s = (await app.call("POST", "/sessions/blank", { meta: { processName: "Проверка связи" } })).body;
    await app.call("PUT", `/sessions/${s.id}/model`, structuredModel());
  });
  afterAll(() => app.close());

  it("всё в порядке: приложение, доступ, сессии, инструменты", async () => {
    const lines = await checkAgentSetup({ baseUrl: app.url, token: "" });
    expect(lines.every((l) => l.ok)).toBe(true);
    expect(lines.map((l) => l.text)).toEqual([
      expect.stringContaining("Приложение отвечает"),
      "API агента доступно (вход в приложении отключён — токен не требуется)",
      expect.stringMatching(/^Сессий: \d+, с моделью: \d+$/),
      "Инструменты MCP-сервера: 11 инструментов",
    ]);
    expect(formatCheck(lines)).toContain("Всё готово");
  });

  it("приложение не запущено — одна понятная строка и подсказка", async () => {
    const lines = await checkAgentSetup({ baseUrl: "http://127.0.0.1:1", token: "x" });
    expect(lines).toHaveLength(1);
    expect(lines[0].ok).toBe(false);
    expect(lines[0].hint).toMatch(/Запустите приложение/);
    expect(formatCheck(lines)).toMatch(/✗ Приложение не отвечает.*\n {4}→ Запустите/);
  });

  it("вход включён: нет токена, неверный токен, верный токен", async () => {
    process.env.AUTH_USERS = "analyst:pass";
    process.env.AGENT_API_TOKEN = "agent-secret-token-123";
    try {
      const none = await checkAgentSetup({ baseUrl: app.url, token: "" });
      expect(none.at(-1)).toMatchObject({ ok: false, text: "Токен агента не задан, а в приложении включён вход" });
      expect(none.at(-1)!.hint).toMatch(/AGENT_API_TOKEN/);

      const wrong = await checkAgentSetup({ baseUrl: app.url, token: "wrong-token" });
      expect(wrong.at(-1)).toMatchObject({ ok: false, text: "Токен агента не принят" });
      expect(wrong.at(-1)!.hint).toMatch(/перезапустите приложение/);

      const right = await checkAgentSetup({ baseUrl: app.url, token: "agent-secret-token-123" });
      expect(right.every((l) => l.ok)).toBe(true);
      expect(right[1].text).toBe("Токен агента принят (вход в приложении включён)");
    } finally {
      delete process.env.AUTH_USERS;
      delete process.env.AGENT_API_TOKEN;
    }
  });

  it("запуск отдельным процессом: нет сборки — подсказка собрать сервер", async () => {
    const lines = await checkAgentSetup({ baseUrl: app.url, token: "", stdioEntry: "C:/нет/такого/index.js" });
    expect(lines.at(-1)).toMatchObject({ ok: false });
    expect(lines.at(-1)!.text).toContain("Файл MCP-сервера не найден");
    expect(lines.at(-1)!.hint).toMatch(/npm run build -w server/);
  });
});