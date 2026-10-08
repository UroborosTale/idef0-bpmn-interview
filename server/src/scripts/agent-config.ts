import "../env.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildClineConfig } from "../mcp/clineConfig.js";

/**
 * Готовый конфиг MCP-сервера для Cline: `npm run agent:config -w server`.
 *  — без параметров: печатает конфиг, токен скрыт;
 *  — `-- --out <файл>`: записывает конфиг с настоящим токеном (положите его в cline_mcp_settings.json);
 *  — `-- --auto-low-risk`: без подтверждения разрешены ещё take_task, complete_task, add_questions, add_report.
 * Путь к MCP-серверу берётся от места этого проекта, адрес приложения — из PM_API_URL или PORT (по умолчанию 8787),
 * токен — из AGENT_API_TOKEN (.env приложения).
 */
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const outIndex = args.indexOf("--out");
const out = outIndex >= 0 ? args[outIndex + 1] : undefined;

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.resolve(here, "../../dist/mcp/index.js").replace(/\\/g, "/");
const url = process.env.PM_API_URL ?? `http://127.0.0.1:${Number(process.env.PORT) || 8787}`;
const token = process.env.AGENT_API_TOKEN ?? "";

const problems: string[] = [];
if (!fs.existsSync(entry)) problems.push(`MCP-сервер не собран (${entry} нет): выполните npm run build -w server.`);
if (!token) problems.push("AGENT_API_TOKEN не задан в .env: без входа (AUTH_USERS) токен не нужен, при включённом входе агент не пройдёт.");

const config = buildClineConfig({ entry, url, token: out ? token : token ? "••••••••" : "", autoApproveLowRisk: flag("--auto-low-risk") });
const text = JSON.stringify(config, null, 2);
if (out) {
  fs.writeFileSync(path.resolve(out), text + "\n", "utf8");
  console.log(`✓ конфиг записан: ${path.resolve(out)} (в нём настоящий токен — не добавляйте файл в git)`);
} else {
  console.log(text);
}
for (const p of problems) console.error(`⚠ ${p}`);
console.error(`  Проверка готовности: npm run agent:check -w server. Разрешено без подтверждения: ${config.mcpServers["process-modeling"].autoApprove.length} инструментов.`);
process.exit(0);