import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONVENTIONS } from "./conventions.js";

/**
 * Инструкции ролей агентов. В Cline они подхватываются из .clinerules (общие правила — всегда, роль — workflow по «/»).
 * Для моделей без Cline (собственный сервер, API напрямую) системный промпт роли собирается из тех же файлов, поэтому
 * правила хранятся в одном месте: общие правила + инструкция роли + правила работы с моделью (Соглашение, формат правок).
 */
export const ROLE_WORKFLOWS = {
  методолог: "methodologist",
  моделист: "model-from-interview",
  нормоконтролёр: "review-model",
  интервьюер: "interviewer",
  аналитик: "analyst",
} as const;
export type AgentRole = keyof typeof ROLE_WORKFLOWS;
export const AGENT_ROLES = Object.keys(ROLE_WORKFLOWS) as AgentRole[];

/** Корень репозитория: рядом лежит .clinerules (из server/src/agent и server/dist/agent — на три уровня выше). */
export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const read = (root: string, ...parts: string[]) => fs.readFileSync(path.join(root, ...parts), "utf8").replace(/\r\n/g, "\n").trim();

/** Инструкция роли (текст workflow). */
export const roleInstruction = (role: AgentRole, root = repoRoot) => read(root, ".clinerules", "workflows", `${ROLE_WORKFLOWS[role]}.md`);

/**
 * Системный промпт роли для модели без Cline: общие правила, инструкция роли и правила работы с моделью. Инструкции ссылаются
 * на инструменты MCP-сервера и на «/» команды Cline — модель без них получает описание инструментов от своего клиента.
 */
export function systemPrompt(role: AgentRole, root = repoRoot): string {
  return [`Вы — агент с ролью «${role}» в системе моделирования процессов. Работайте только в границах этой роли.`, read(root, ".clinerules", "00-process-modeling.md"), roleInstruction(role, root), CONVENTIONS.trim()].join("\n\n---\n\n") + "\n";
}
