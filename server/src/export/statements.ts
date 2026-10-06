import type { SessionRecord } from "../repo.js";

/** Список пожеланий (TO-BE) и проблем, отдельно от AS-IS модели (ФТ-3.11, ФТ-10.4). */
export function buildStatementsMarkdown(session: SessionRecord): string {
  const m = session.model!;
  const proposals = m.statements.filter((s) => s.kind === "proposal");
  const problems = m.statements.filter((s) => s.kind === "problem");
  const lines: string[] = [];
  lines.push(`# Проблемы и предложения — ${session.meta.processName}`);
  lines.push("");
  lines.push("## Проблемы / боли");
  if (problems.length === 0) lines.push("_Не выявлено._");
  for (const p of problems) {
    lines.push(`- ${p.text}${p.source[0] ? ` _(фрагмент ${p.source[0].fragment_id}: «${p.source[0].quote}»)_` : ""}`);
  }
  lines.push("");
  lines.push("## Предложения (TO-BE)");
  if (proposals.length === 0) lines.push("_Не выявлено._");
  for (const p of proposals) {
    lines.push(`- ${p.text}${p.source[0] ? ` _(фрагмент ${p.source[0].fragment_id}: «${p.source[0].quote}»)_` : ""}`);
  }
  return lines.join("\n");
}
