import type { SessionRecord } from "../repo.js";

/** Протокол интервью (ФТ-2.8, ФТ-10.4): полный диалог и краткое резюме. */
export function buildProtocolMarkdown(session: SessionRecord): string {
  const m = session.model;
  const lines: string[] = [];
  lines.push(`# Протокол интервью — ${session.meta.processName}`);
  lines.push("");
  lines.push(`- Режим: ${session.mode === "B" ? "интерактивное интервью" : "обработка готового текста"}`);
  lines.push(`- Владелец процесса: ${session.meta.owner ?? "не указан"}`);
  lines.push(`- Подразделение: ${session.meta.department ?? "не указано"}`);
  lines.push(`- Тип модели: ${session.meta.modelType}`);
  lines.push(`- Статус сессии: ${session.status}`);
  lines.push("");
  lines.push("## Краткое резюме процесса");
  if (m) {
    lines.push(`- Цель: ${m.process.goal ?? "не выявлена"}`);
    lines.push(`- Триггер: ${m.process.trigger ?? "не выявлен"}`);
    lines.push(`- Результат: ${m.process.result ?? "не выявлен"}`);
    lines.push(`- Роли: ${m.roles.map((r) => r.name).join(", ") || "—"}`);
    lines.push(`- Действия/события: ${m.nodes.length}`);
    lines.push(`- Открытых пробелов: ${m.gaps.filter((g) => g.status === "open").length}`);
  } else {
    lines.push("Модель ещё не построена.");
  }
  lines.push("");
  lines.push("## Диалог");
  if (session.chat.length === 0) {
    lines.push("_Диалог отсутствует (использован режим обработки готового текста)._");
  } else {
    for (const msg of session.chat) {
      const who = msg.role === "assistant" ? "Система" : msg.role === "owner" ? "Владелец процесса" : "Система";
      lines.push(`**${who}:** ${msg.text}`);
      lines.push("");
    }
  }
  return lines.join("\n");
}
