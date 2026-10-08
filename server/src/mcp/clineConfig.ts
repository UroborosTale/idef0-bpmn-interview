/**
 * Настройка MCP-сервера в Cline. Какие инструменты можно разрешить без подтверждения: читающие ничего не меняют в приложении;
 * пишущие создают записи для аналитика (предложения, вопросы, отчёты, задания), но и они модель не меняют — применяет человек.
 * По умолчанию без подтверждения только чтение, остальное агент делает после согласия человека в Cline.
 */
export const READ_TOOLS = ["get_conventions", "list_sessions", "get_model", "get_fragments", "list_proposals", "get_proposal", "get_tasks", "list_questions", "list_reports", "get_report"];
export const WRITE_TOOLS = ["propose_patch", "create_task", "take_task", "complete_task", "add_questions", "add_report"];
/** Записи, которые безопасно разрешить без подтверждения, когда роль уже проверена: не меняют ничего, кроме собственных заметок агента. */
export const LOW_RISK_WRITE_TOOLS = ["take_task", "complete_task", "add_questions", "add_report"];

export interface ClineConfigInput {
  /** Абсолютный путь к server/dist/mcp/index.js. */
  entry: string;
  url: string;
  token: string;
  /** Разрешить без подтверждения ещё и малорисковые записи (take_task, complete_task, add_questions, add_report). */
  autoApproveLowRisk?: boolean;
}

export function buildClineConfig(input: ClineConfigInput) {
  return {
    mcpServers: {
      "process-modeling": {
        command: "node",
        args: [input.entry],
        env: { PM_API_URL: input.url, PM_AGENT_TOKEN: input.token },
        disabled: false,
        autoApprove: [...READ_TOOLS, ...(input.autoApproveLowRisk ? LOW_RISK_WRITE_TOOLS : [])],
      },
    },
  };
}