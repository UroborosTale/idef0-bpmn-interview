import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { recordUsage, usageForSession, withLlmContext } from "../src/llm/usage.js";
import { isPrivateAddress, safeWebhookFetch, validateWebhookUrl } from "../src/util/webhook.js";
import { backupNow } from "../src/util/backup.js";

describe("учёт расхода LLM", () => {
  it("токены записываются на сессию из контекста и суммируются, стоимость — по ценам из окружения", async () => {
    await withLlmContext("s1", async () => {
      recordUsage("anthropic", "m1", 1000, 200);
      await Promise.resolve();
      recordUsage("anthropic", "m1", 500, 100);
    });
    await withLlmContext("s2", async () => recordUsage("anthropic", "m1", 9999, 9999));
    process.env.LLM_PRICE_INPUT_PER_M = "3";
    process.env.LLM_PRICE_OUTPUT_PER_M = "15";
    const u = usageForSession("s1");
    expect(u).toMatchObject({ calls: 2, inputTokens: 1500, outputTokens: 300 });
    expect(u.costUsd).toBeCloseTo((1500 * 3 + 300 * 15) / 1e6, 6);
  });
});

describe("вебхуки", () => {
  it("внутренние адреса отклоняются и до, и после разрешения имени", async () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.0.10", "172.20.0.1", "169.254.169.254", "::1", "fd00::1", "::ffff:10.0.0.1"]) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ["8.8.8.8", "2001:4860:4860::8888"]) expect(isPrivateAddress(ip), ip).toBe(false);
    expect(validateWebhookUrl("ftp://example.com").ok).toBe(false);
    await expect(safeWebhookFetch("http://localhost:8787/api", { method: "POST" })).rejects.toThrow(/внутренний/);
    await expect(safeWebhookFetch("http://[::1]/x", { method: "POST" })).rejects.toThrow(/внутренний/);
  });
});

describe("резервные копии", () => {
  it("копия базы создаётся в data/backups и открывается", async () => {
    const file = await backupNow();
    expect(fs.existsSync(file)).toBe(true);
    expect(path.dirname(file)).toBe(path.join(process.env.DATA_DIR!, "backups"));
    expect(fs.statSync(file).size).toBeGreaterThan(0);
  });
});
