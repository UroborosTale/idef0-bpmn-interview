import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_ROLES, ROLE_WORKFLOWS, repoRoot, roleInstruction, systemPrompt } from "../src/agent/prompts.js";
import { createAgentServer } from "../src/mcp/server.js";
import { ProposalInput } from "../src/types/patch.js";
import { ProcessNode } from "../src/types/model.js";

/** Имена инструментов MCP-сервера: инструкции не должны упоминать несуществующие. */
async function toolNames(): Promise<string[]> {
  const server = createAgentServer({ get: async () => ({ status: 200, body: {} }), post: async () => ({ status: 200, body: {} }) });
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const names = (await client.listTools()).tools.map((t) => t.name);
  await client.close();
  return names;
}

/** Имена в обратных кавычках, похожие на инструмент или параметр (snake_case): get_model, task_id… */
const snake = (text: string) => [...new Set([...text.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((m) => m[1]))];

describe("инструкции ролей агентов", () => {
  // всё, что кроме инструментов, инструкции вправе называть: параметры инструментов, поля модели, правила проверок
  const KNOWN = new Set([
    "task_id", "session_id", "for_agent", "from_agent", "asked_count", "time_processing", "time_waiting", "manual_transfer", "double_entry",
    "data_no_supplier", "data_no_consumer", "set_process", "set_assignments", "bpmn_scope", "system_ids", "role_id", "cost_estimate",
  ]);

  it("у каждой из пяти ролей есть инструкция одной структуры: роль, границы, подготовка или порядок, завершение", () => {
    expect(AGENT_ROLES).toEqual(["методолог", "моделист", "нормоконтролёр", "интервьюер", "аналитик"]);
    for (const role of AGENT_ROLES) {
      const text = roleInstruction(role);
      expect(text, role).toContain(`agent: "${role}"`);
      expect(text, role).toMatch(/\n## Границы\n/);
      expect(text, role).toMatch(/\n## Подготовка\n/);
      expect(text, role).toMatch(/\n## Завершение\n/);
      expect(text.length, role).toBeGreaterThan(1500); // не заглушка
      expect(text.length, role).toBeLessThan(9000); // и не простыня: роль читают каждый запуск
    }
  });

  it("инструкции ссылаются только на существующие инструменты MCP и известные поля и параметры", async () => {
    const tools = new Set(await toolNames());
    expect(tools.size).toBe(16);
    const used = new Set<string>();
    for (const role of AGENT_ROLES) {
      for (const name of snake(roleInstruction(role))) {
        used.add(name);
        expect(tools.has(name) || KNOWN.has(name), `${role}: «${name}» — нет такого инструмента или поля`).toBe(true);
      }
    }
    // общие правила тоже
    for (const name of snake(fs.readFileSync(path.join(repoRoot, ".clinerules", "00-process-modeling.md"), "utf8"))) expect(tools.has(name) || KNOWN.has(name), name).toBe(true);
    // и каждый инструмент где-нибудь описан в инструкциях ролей
    for (const t of ["get_conventions", "get_model", "get_fragments", "propose_patch", "list_proposals", "get_tasks", "take_task", "complete_task", "create_task", "list_sessions", "add_questions", "list_questions", "add_report", "list_reports"]) expect(used.has(t), t).toBe(true);
  });

  it("поля модели, которые называет аналитик, существуют в схеме узла; поручения и роли в agent допустимы", () => {
    for (const f of ["duration", "time_processing", "time_waiting", "frequency", "cost_estimate", "tags", "role_id", "system_ids", "inputs", "outputs"]) expect(Object.keys(ProcessNode.shape), f).toContain(f);
    // сервер принимает любую непустую подпись роли — значит, подписи из инструкций проходят проверку формата
    for (const r of AGENT_ROLES) expect(ProposalInput.shape.agent.safeParse(r).success, r).toBe(true);
  });

  it("границы ролей не пересекаются: правки модели предлагают только те, кому это положено", () => {
    // интервьюер модель не правит; аналитик — только измеримые факты; остальные предлагают через propose_patch
    expect(roleInstruction("интервьюер")).toMatch(/`propose_patch` не используется/);
    expect(roleInstruction("аналитик")).toMatch(/Единственное, что можно предложить моделью/);
    for (const role of ["методолог", "моделист", "нормоконтролёр"] as const) expect(roleInstruction(role), role).toContain("propose_patch");
    // передачи работы идут по заданиям и только по существующим ролям
    expect(roleInstruction("моделист")).toMatch(/for_agent: «нормоконтролёр»/);
    expect(roleInstruction("нормоконтролёр")).toMatch(/for_agent: «моделист»/);
    expect(roleInstruction("интервьюер")).toMatch(/for_agent: «моделист»/);
    expect(roleInstruction("аналитик")).toMatch(/for_agent: «интервьюер»/);
    // методолог ссылается на инструкции всех ролей
    const m = roleInstruction("методолог");
    for (const w of Object.values(ROLE_WORKFLOWS).filter((x) => x !== "methodologist")) expect(m, w).toContain(`/${w}`);
  });

  it("общие правила называют все пять ролей и их команды", () => {
    const common = fs.readFileSync(path.join(repoRoot, ".clinerules", "00-process-modeling.md"), "utf8");
    for (const [role, wf] of Object.entries(ROLE_WORKFLOWS)) {
      expect(common, role).toContain(role);
      expect(common, role).toContain(`/${wf}`);
    }
    // задания «work-tasks» распределяют работу между всеми пятью
    const work = fs.readFileSync(path.join(repoRoot, ".clinerules", "workflows", "work-tasks.md"), "utf8");
    for (const wf of Object.values(ROLE_WORKFLOWS)) expect(work, wf).toContain(wf);
  });

  it("системный промпт для модели без Cline: представление роли, общие правила, инструкция роли и Соглашение", () => {
    for (const role of AGENT_ROLES) {
      const p = systemPrompt(role);
      expect(p.startsWith(`Вы — агент с ролью «${role}»`), role).toBe(true);
      expect(p).toContain("Вы только предлагаете — применяет аналитик"); // общие правила
      expect(p).toContain(roleInstruction(role)); // инструкция роли целиком
      expect(p).toContain("Правила работы агента с процессной моделью"); // правила модели (get_conventions)
      expect(p).not.toMatch(/\r/);
    }
    // роль не подмешивает чужую инструкцию
    expect(systemPrompt("интервьюер")).not.toContain("# Нормоконтролёр: проверка модели и обратная связь");
  });
});
