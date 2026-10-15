/**
 * Показ параметров объекта на диаграмме, как «Настроить показ параметров» в Business Studio: вокруг фигуры шесть мест для параметров
 * (углы и середины сверху и снизу), четыре сноски в углах и седьмое место — после названия. В каждое место ставится один параметр
 * объекта с приставкой и окончанием. Общий модуль выгрузки Visio и диалога студии.
 */
import type { ProcessLogicModel, ProcessNode } from "../types/model.js";

export const PARAM_SLOTS = ["p1", "p2", "p3", "p4", "p5", "p6", "n1", "n2", "n3", "n4", "p7"] as const;
export type ParamSlotId = (typeof PARAM_SLOTS)[number];

export const PARAM_SLOT_LABELS: Record<ParamSlotId, string> = {
  p1: "Параметр 1",
  p2: "Параметр 2",
  p3: "Параметр 3",
  p4: "Параметр 4",
  p5: "Параметр 5",
  p6: "Параметр 6",
  n1: "Сноска 1",
  n2: "Сноска 2",
  n3: "Сноска 3",
  n4: "Сноска 4",
  p7: "Параметр 7 (после названия)",
};

export interface ParamSlot {
  /** Ключ из PARAMS. */
  param: string;
  prefix?: string;
  postfix?: string;
  align?: "left" | "center" | "right";
  /** Перед значением выводится название параметра. */
  title?: boolean;
  /** У списков — сколько строк выводить (по умолчанию 5). */
  rows?: number;
}
export type ParamDisplay = Partial<Record<ParamSlotId, ParamSlot>>;

type Node = Pick<ProcessNode, "id" | "type"> & Partial<ProcessNode>;
type Model = Pick<ProcessLogicModel, "roles" | "systems" | "data" | "controls">;

const LC: Record<string, string> = { in_work: "В работе", review: "На согласовании", approved: "Утверждён", archived: "В архиве" };

/** Параметры объекта, которые можно показать: название и способ получить значение (строки списка). */
export const PARAMS: { key: string; title: string; list?: boolean; values: (n: Node, m: Model) => string[] }[] = [
  { key: "role", title: "Исполнитель", values: (n, m) => (n.role_id ? [m.roles.find((r) => r.id === n.role_id)?.name ?? ""] : []) },
  { key: "systems", title: "Программные продукты", list: true, values: (n, m) => (n.system_ids ?? []).map((id) => m.systems.find((s) => s.id === id)?.name ?? "") },
  { key: "inputs", title: "Входы", list: true, values: (n, m) => (n.inputs ?? []).map((id) => m.data.find((d) => d.id === id)?.name ?? "") },
  { key: "outputs", title: "Выходы", list: true, values: (n, m) => (n.outputs ?? []).map((id) => m.data.find((d) => d.id === id)?.name ?? "") },
  { key: "controls", title: "Нормативные документы", list: true, values: (n, m) => (n.controls ?? []).map((id) => m.controls.find((c) => c.id === id)?.name ?? "") },
  { key: "duration", title: "Длительность", values: (n) => (n.duration ? [n.duration] : []) },
  { key: "frequency", title: "Периодичность", values: (n) => (n.frequency ? [n.frequency] : []) },
  { key: "content", title: "Содержание", values: (n) => (n.content ? [n.content] : []) },
  { key: "begin", title: "Начало", values: (n) => (n.begin ? [n.begin] : []) },
  { key: "result", title: "Результат", values: (n) => (n.result ? [n.result] : []) },
  { key: "deadline", title: "Сроки", values: (n) => (n.deadline ? [n.deadline] : []) },
  { key: "lc_status", title: "Статус", values: (n) => [LC[n.lc_status ?? "in_work"]] },
  { key: "lc_version", title: "Версия", values: (n) => [n.lc_version ?? "1.0.0"] },
];

/** Текст, который нужно вывести в месте slot у объекта; пусто — выводить нечего. */
export function paramText(slot: ParamSlot, node: Node, model: Model): string {
  const def = PARAMS.find((p) => p.key === slot.param);
  if (!def) return "";
  let values = def.values(node, model).filter((v) => v.trim());
  if (def.list) values = values.slice(0, Math.max(1, slot.rows ?? 5));
  if (values.length === 0) return "";
  const head = slot.title ? `${def.title}: ` : "";
  return `${slot.prefix ?? ""}${head}${values.join("\n")}${slot.postfix ?? ""}`;
}

/** Настроенные места объекта (только те, где выбран параметр). */
export function shownParams(node: Node): [ParamSlotId, ParamSlot][] {
  const pd = node.param_display;
  if (!pd) return [];
  return PARAM_SLOTS.filter((id) => pd[id]?.param).map((id) => [id, pd[id]!] as [ParamSlotId, ParamSlot]);
}
