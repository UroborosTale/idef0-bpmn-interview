import type { ImpactReport } from "./impactAnalysis.js";

export interface NotificationRecipient {
  kind: "process_owner" | "role";
  label: string;
  contact: string | null;
}

/** ФТ-М7.4.1: получатели — владельцы смежных процессов, исполнители изменённых шагов. */
export function resolveRecipients(report: ImpactReport): NotificationRecipient[] {
  const out: NotificationRecipient[] = [];
  for (const p of report.adjacentProcesses) {
    out.push({ kind: "process_owner", label: `Владелец процесса «${p.name}»`, contact: p.owner });
  }
  for (const r of report.affectedRoles) {
    out.push({ kind: "role", label: `Роль «${r.name}»`, contact: null });
  }
  return out;
}

/** ФТ-М7.4.3: персонализированное сообщение — что изменилось для конкретного получателя + ссылка на diff. */
export function buildNotificationMessage(
  recipient: NotificationRecipient,
  processName: string,
  report: ImpactReport,
  diffLink: string
): string {
  if (recipient.kind === "process_owner") {
    const reasons = report.adjacentProcesses.filter((p) => `Владелец процесса «${p.name}»` === recipient.label).map((p) => p.reason);
    return `Процесс «${processName}» был утверждён с изменениями, затрагивающими ваш процесс: ${reasons.join("; ")}. Подробности: ${diffLink}`;
  }
  return `В процессе «${processName}» утверждены изменения в шагах, которые выполняет ${recipient.label.toLowerCase()}: ${report.changedNodeNames.join(", ")}. Подробности: ${diffLink}`;
}
