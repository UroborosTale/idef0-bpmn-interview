import type { ProcessLogicModel } from "../../types";
import type { Arrow } from "../idef0-editor/geometry";
import type { DictKind } from "./docs";

/**
 * Что сейчас выделено в окне студии — по этому объекту панель «Свойства» показывает карточку.
 * Диаграммы сообщают о своём выделении, справочники — о выбранной записи; из самой панели можно
 * перейти к связанной записи (back хранит, откуда пришли).
 */
export type Selection =
  | { kind: "node"; id: string; back?: Selection }
  | { kind: "flow"; id: string; back?: Selection }
  | { kind: "arrow"; arrow: Arrow; back?: Selection }
  | { kind: "entry"; dict: DictKind; id: string; back?: Selection }
  | null;

const listOf = (m: ProcessLogicModel, dict: DictKind): { id: string }[] =>
  dict === "roles" ? m.roles : dict === "systems" ? m.systems : dict === "data" ? m.data : dict === "controls" ? m.controls : dict === "kpi" ? m.process.kpi : m.process.risks;

/** Выделенный объект ещё есть в модели (его могли удалить или откатить правку). */
export function selectionExists(m: ProcessLogicModel, s: Selection): boolean {
  if (!s) return false;
  switch (s.kind) {
    case "node":
      return m.nodes.some((n) => n.id === s.id);
    case "flow":
      return m.flows.some((f) => f.id === s.id);
    case "arrow":
      return m.nodes.some((n) => n.id === s.arrow.nodeId);
    case "entry":
      return listOf(m, s.dict).some((e) => e.id === s.id);
  }
}

/** Справочник и запись, на которые указывает стрелка IDEF0. */
export function arrowEntry(a: Arrow): { dict: DictKind; id: string } {
  switch (a.kind) {
    case "control":
      return { dict: "controls", id: a.entityId };
    case "system":
      return { dict: "systems", id: a.entityId };
    case "role":
      return { dict: "roles", id: a.entityId };
    default:
      return { dict: "data", id: a.entityId };
  }
}
