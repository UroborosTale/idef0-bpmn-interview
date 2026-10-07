import type { ProcessLogicModel } from "../../types";
import { processCodeOf } from "@shared/codes";
import { idef0Codes } from "../idef0-editor/geometry";

/** Документ (вкладка) окна студии. */
export type StudioDoc =
  | { key: string; kind: "bpmn"; scope: string | null }
  | { key: string; kind: "idef0"; parent: string | null }
  | { key: string; kind: "dict"; dict: DictKind }
  | { key: string; kind: "report"; report: ReportKind };

export type DictKind = "roles" | "systems" | "data" | "controls" | "kpi" | "risks";
export type ReportKind = "passport" | "regulation" | "raci" | "jobs" | "statuses";

export const DICT_TITLES: Record<DictKind, string> = {
  roles: "Исполнители",
  systems: "Информационные системы",
  data: "Документы и данные",
  controls: "Регламенты и нормы",
  kpi: "Показатели (KPI)",
  risks: "Риски",
};

export const REPORT_TITLES: Record<ReportKind, string> = {
  passport: "Паспорт процесса",
  regulation: "Регламент процесса",
  raci: "Матрица RACI",
  jobs: "Должностные инструкции",
  statuses: "Схема перехода статусов",
};

/** Диаграмма BPMN: общая схема процесса (scope = null) или операции (id функции IDEF0). */
export const bpmnDoc = (scope: string | null = null): StudioDoc => ({ key: scope ? `bpmn:${scope}` : "bpmn", kind: "bpmn", scope });
export const idef0Doc = (parent: string | null): StudioDoc => ({ key: `idef0:${parent ?? "root"}`, kind: "idef0", parent });
export const dictDoc = (dict: DictKind): StudioDoc => ({ key: `dict:${dict}`, kind: "dict", dict });
export const reportDoc = (report: ReportKind): StudioDoc => ({ key: `report:${report}`, kind: "report", report });

/** Заголовок вкладки; для диаграммы IDEF0 — код функции (A0, A2, A21…). */
export function docTitle(doc: StudioDoc, model: ProcessLogicModel): string {
  switch (doc.kind) {
    case "bpmn":
      return doc.scope ? `BPMN ${idef0Codes(model).get(doc.scope) ?? "?"}` : "BPMN";
    case "idef0":
      return `IDEF0 ${doc.parent ? idef0Codes(model).get(doc.parent) ?? "A?" : processCodeOf(model)}`;
    case "dict":
      return DICT_TITLES[doc.dict];
    case "report":
      return REPORT_TITLES[doc.report];
  }
}

/** Вкладка ссылается на исчезнувший элемент (удалили функцию, откатили правку) — её нужно закрыть. */
export const docIsStale = (doc: StudioDoc, model: ProcessLogicModel): boolean =>
  (doc.kind === "idef0" && !!doc.parent && !model.nodes.some((n) => n.id === doc.parent)) || (doc.kind === "bpmn" && !!doc.scope && !model.nodes.some((n) => n.id === doc.scope));
