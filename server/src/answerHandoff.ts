import { createTask, type AgentTask } from "./agentTasks.js";
import { markHandedOff, unhandedAnswers } from "./agentQuestions.js";
import type { SessionRecord } from "./repo.js";
import { functionCodes, stepCodes } from "./shared/codes.js";

/** Роль, которой передаются ответы: внесение фактов в модель — работа моделиста. */
export const HANDOFF_AGENT = "моделист";
const MAX_TEXT = 1900; // с запасом до лимита текста задания (2000)

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Передаёт моделисту ответы, полученные на интервью: одно задание «внеси ответы», где перечислены вопросы, ответы и
 * фрагменты. Передаются только ещё не переданные ответы; вопросы запоминают задание, чтобы не передавать дважды.
 * Возвращает null, если передавать нечего.
 */
export function handOffAnswers(session: SessionRecord, createdBy: string): { task: AgentTask; count: number } | null {
  const answered = unhandedAnswers(session.id);
  if (answered.length === 0) return null;
  const codes = session.model ? new Map([...functionCodes(session.model), ...stepCodes(session.model)]) : new Map<string, string>();
  const head = `Внеси в модель ответы владельца процесса, полученные на интервью (${answered.length}). Тексты — get_fragments; факты добавляй с цитатой, чего в ответе нет — не выдумывай.`;
  const lines: string[] = [];
  const included: typeof answered = [];
  let used = head.length;
  for (const [i, q] of answered.entries()) {
    const where = q.scopeNodeId ? codes.get(q.scopeNodeId) ?? q.scopeNodeId : "процесс в целом";
    const line = `${i + 1}. [${where}] ${clip(q.text, 160)} — ${q.answer ? `«${clip(q.answer, 220)}»` : "ответ дан устно"}${q.fragmentId ? ` [${q.fragmentId}]` : ""}`;
    if (used + line.length + 90 > MAX_TEXT) break; // запас под строку о непереданных
    lines.push(line);
    included.push(q);
    used += line.length + 1;
  }
  // что не поместилось, остаётся непереданным: его заберёт следующее задание (кнопка «Передать» остаётся доступной)
  if (included.length < answered.length) lines.push(`… ещё ${answered.length - included.length} ответов не вошло — они в следующем задании (list_questions со статусом answered).`);
  // все ответы про одну функцию — задание привязывается к ней, иначе к процессу в целом
  const scopes = new Set(included.map((q) => q.scopeNodeId));
  const scope = scopes.size === 1 ? [...scopes][0] : null;
  const task = createTask({ sessionId: session.id, text: [head, ...lines].join("\n"), scopeNodeId: scope, agent: HANDOFF_AGENT, createdBy });
  markHandedOff(included.map((q) => q.id), task.id);
  return { task, count: included.length };
}