import fs from "node:fs";
import { AGENT_ROLES, systemPrompt, type AgentRole } from "../agent/prompts.js";

/**
 * Системный промпт роли агента для модели без Cline:
 *   npm run agent:prompt -w server -- нормоконтролёр
 *   npm run agent:prompt -w server -- аналитик --out analyst-prompt.md
 * Без аргументов — список ролей. Промпт собирается из .clinerules и правил работы с моделью: правила хранятся в одном месте.
 */
const [role, flag, out] = process.argv.slice(2);
if (!role || !AGENT_ROLES.includes(role as AgentRole)) {
  console.error(`Укажите роль: ${AGENT_ROLES.join(" | ")}`);
  process.exit(1);
}
const text = systemPrompt(role as AgentRole);
if (flag === "--out" && out) {
  fs.writeFileSync(out, text, "utf8");
  console.log(`Записано: ${out} (${text.length} символов)`);
} else {
  process.stdout.write(text);
}
