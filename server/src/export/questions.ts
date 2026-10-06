import type { SessionRecord } from "../repo.js";

const PRIORITY_LABEL: Record<string, string> = { critical: "Критично", important: "Важно", desirable: "Желательно" };

export function buildQuestionsText(session: SessionRecord): string {
  const open = (session.model?.gaps ?? []).filter((g) => g.status === "open");
  const order = { critical: 0, important: 1, desirable: 2 } as const;
  open.sort((a, b) => order[a.priority] - order[b.priority]);
  const lines = [
    `Лист уточняющих вопросов`,
    `Процесс: ${session.meta.processName}`,
    session.meta.owner ? `Владелец: ${session.meta.owner}` : "",
    `Дата: ${new Date().toISOString().slice(0, 10)}`,
    "",
    ...open.map((g, i) => `${i + 1}. [${PRIORITY_LABEL[g.priority]}] ${g.question}`),
  ].filter((l) => l !== "");
  if (open.length === 0) lines.push("Открытых вопросов нет — модель полна по текущим правилам полноты.");
  return lines.join("\n");
}
