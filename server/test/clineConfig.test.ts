import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EXPECTED_TOOLS } from "../src/mcp/check.js";
import { LOW_RISK_WRITE_TOOLS, READ_TOOLS, WRITE_TOOLS, buildClineConfig } from "../src/mcp/clineConfig.js";
import { createAgentServer } from "../src/mcp/server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("настройка Cline: какие инструменты можно разрешить без подтверждения", () => {
  it("каждый инструмент MCP-сервера отнесён либо к чтению, либо к записи — не пропущен и не назван дважды", async () => {
    const server = createAgentServer({ get: async () => ({ status: 200, body: {} }), post: async () => ({ status: 200, body: {} }) });
    const client = new Client({ name: "t", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const real = (await client.listTools()).tools.map((x) => x.name).sort();
    await client.close();
    expect([...READ_TOOLS, ...WRITE_TOOLS].sort()).toEqual(real);
    expect([...READ_TOOLS, ...WRITE_TOOLS].sort()).toEqual([...EXPECTED_TOOLS].sort());
    expect(READ_TOOLS.some((t) => WRITE_TOOLS.includes(t))).toBe(false);
    expect(LOW_RISK_WRITE_TOOLS.every((t) => WRITE_TOOLS.includes(t))).toBe(true);
    // предложение правок и поручение другой роли — решения, которые человек подтверждает всегда
    expect(LOW_RISK_WRITE_TOOLS).not.toContain("propose_patch");
    expect(LOW_RISK_WRITE_TOOLS).not.toContain("create_task");
  });

  it("конфиг: по умолчанию без подтверждения только чтение; низкорисковые записи — по флагу", () => {
    const base = buildClineConfig({ entry: "C:/app/server/dist/mcp/index.js", url: "http://127.0.0.1:8787", token: "t0k" }).mcpServers["process-modeling"];
    expect(base.command).toBe("node");
    expect(base.args).toEqual(["C:/app/server/dist/mcp/index.js"]);
    expect(base.env).toEqual({ PM_API_URL: "http://127.0.0.1:8787", PM_AGENT_TOKEN: "t0k" });
    expect(base.autoApprove).toEqual(READ_TOOLS);
    const more = buildClineConfig({ entry: "x", url: "u", token: "t", autoApproveLowRisk: true }).mcpServers["process-modeling"].autoApprove;
    expect(more).toEqual([...READ_TOOLS, ...LOW_RISK_WRITE_TOOLS]);
    expect(more).not.toContain("propose_patch");
  });

  it("команда agent:config: токен на экране скрыт, в файле настоящий", () => {
    const run = (...args: string[]) =>
      spawnSync(process.execPath, ["--import", "tsx", "src/scripts/agent-config.ts", ...args], { cwd: serverDir, env: { ...process.env, AGENT_API_TOKEN: "secret-token-123", PORT: "9911", PM_API_URL: "" }, encoding: "utf8" });
    const shown = run();
    expect(shown.status).toBe(0);
    expect(shown.stdout).not.toContain("secret-token-123");
    const cfg = JSON.parse(shown.stdout);
    expect(cfg.mcpServers["process-modeling"].env.PM_AGENT_TOKEN).toBe("••••••••");
    expect(cfg.mcpServers["process-modeling"].args[0]).toMatch(/server\/dist\/mcp\/index\.js$/);
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pm-cline-")), "cline_mcp_settings.json");
    const written = run("--out", file, "--auto-low-risk");
    expect(written.status).toBe(0);
    expect(written.stdout).not.toContain("secret-token-123");
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(saved.mcpServers["process-modeling"].env.PM_AGENT_TOKEN).toBe("secret-token-123");
    expect(saved.mcpServers["process-modeling"].autoApprove).toContain("add_report");
  }, 60_000);
});