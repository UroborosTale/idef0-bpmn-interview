import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkAgentSetup, formatCheck } from "../mcp/check.js";

/**
 * Проверка готовности к подключению Cline: `npm run agent:check -w server`.
 * PM_API_URL (по умолчанию http://127.0.0.1:8787) и PM_AGENT_TOKEN — те же, что в настройках MCP-сервера в Cline.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const built = path.resolve(here, "../../dist/mcp/index.js");

const lines = await checkAgentSetup({
  baseUrl: process.env.PM_API_URL ?? "http://127.0.0.1:8787",
  token: process.env.PM_AGENT_TOKEN ?? "",
  stdioEntry: fs.existsSync(built) ? built : undefined,
});
if (!fs.existsSync(built)) lines.push({ ok: false, text: "Сборка сервера не найдена (server/dist/mcp/index.js)", hint: "Cline запускает MCP-сервер из сборки: выполните npm run build -w server." });
console.log(formatCheck(lines));
process.exit(lines.every((l) => l.ok) ? 0 : 1);
