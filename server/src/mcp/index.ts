import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createAgentServer, httpApi } from "./server.js";

/**
 * Запуск MCP-сервера для Cline: `npm run mcp -w server`. Переменные окружения:
 *   PM_API_URL      адрес приложения (по умолчанию http://127.0.0.1:8787)
 *   PM_AGENT_TOKEN  токен агента — то же значение, что AGENT_API_TOKEN у приложения
 * Подключение к Cline — docs/agents/README.md.
 */
const url = process.env.PM_API_URL ?? "http://127.0.0.1:8787";
const token = process.env.PM_AGENT_TOKEN ?? "";

const server = createAgentServer(httpApi(url, token));
await server.connect(new StdioServerTransport());
// stdout занят протоколом MCP — сообщения о запуске только в stderr
console.error(`process-modeling MCP: ${url}${token ? "" : " (PM_AGENT_TOKEN не задан — работает только при отключённом входе)"}`);
