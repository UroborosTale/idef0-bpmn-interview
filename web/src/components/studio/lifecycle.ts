import type { ProcessNode } from "../../types";

/** Статусы жизненного цикла объекта, как в Business Studio. */
export const LC_STATUS_LABELS: Record<NonNullable<ProcessNode["lc_status"]>, string> = {
  in_work: "В работе",
  review: "На согласовании",
  approved: "Утверждён",
  archived: "В архиве",
};

export const lcStatus = (n: Pick<ProcessNode, "lc_status">) => n.lc_status ?? "in_work";
export const lcVersion = (n: Pick<ProcessNode, "lc_version">) => n.lc_version || "1.0.0";

/** «Сменить версию объекта»: следующая версия (последнее число +1: 1.0.0 → 1.0.1); новая версия снова «в работе». */
export function nextVersion(v: string): string {
  const parts = v.split(".").map((x) => parseInt(x, 10));
  if (parts.some((x) => Number.isNaN(x))) return "1.0.1";
  parts[parts.length - 1] += 1;
  return parts.join(".");
}
