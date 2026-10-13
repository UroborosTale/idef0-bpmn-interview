import type { ProcessLogicModel } from "../../types";
import { bpmnHosts } from "@shared/codes";
import { descendantsOf, functionsOf } from "../idef0-editor/geometry";
import { bpmnDoc, docTitle, idef0Doc, type StudioDoc } from "./docs";

type M = ProcessLogicModel;

/**
 * Где изображена функция или шаг (как «Использование на диаграммах» в Business Studio):
 * block — блок на диаграмме IDEF0 родителя, scheme — шаг общей схемы процесса BPMN (функции верхнего уровня),
 * decomposition — её собственная диаграмма IDEF0, operation — диаграмма BPMN операции, step — шаг диаграммы операции.
 */
export type UsageKind = "block" | "scheme" | "decomposition" | "operation" | "step";

export interface FnUsage {
  kind: UsageKind;
  doc: StudioDoc;
  /** Название диаграммы, как на вкладке: «IDEF0 B002.01.00», «BPMN B002.01.01». */
  title: string;
}

export const USAGE_LABELS: Record<UsageKind, string> = {
  block: "блок функции",
  scheme: "шаг общей схемы",
  decomposition: "декомпозиция функции",
  operation: "диаграмма операции",
  step: "шаг диаграммы операции",
};

export function functionUsage(m: M, id: string): FnUsage[] {
  const n = m.nodes.find((x) => x.id === id);
  if (!n) return [];
  const mk = (kind: UsageKind, doc: StudioDoc): FnUsage => ({ kind, doc, title: docTitle(doc, m) });
  if (n.bpmn_scope) return [mk("step", bpmnDoc(n.bpmn_scope))];
  if (n.type !== "task" && n.type !== "subprocess") return [];
  const out: FnUsage[] = [mk("block", idef0Doc(n.idef0_parent ?? null))];
  if (!n.idef0_parent) out.push(mk("scheme", bpmnDoc(null)));
  if (functionsOf(m, n.id).length > 0) out.push(mk("decomposition", idef0Doc(n.id)));
  if (bpmnHosts(m).some((h) => h.id === n.id) && m.nodes.some((s) => s.bpmn_scope === n.id)) out.push(mk("operation", bpmnDoc(n.id)));
  return out;
}

/**
 * Что случится с диаграммами при удалении функции: changed — диаграммы, с которых уйдёт её блок (они останутся),
 * removed — диаграммы самой функции и вложенных (декомпозиция, BPMN операции), которые исчезнут.
 */
export function deleteDiagramImpact(m: M, id: string): { changed: string[]; removed: string[] } {
  const n = m.nodes.find((x) => x.id === id);
  if (!n) return { changed: [], removed: [] };
  const changed = [docTitle(idef0Doc(n.idef0_parent ?? null), m)];
  if (!n.idef0_parent) changed.push(docTitle(bpmnDoc(null), m));
  const removed: string[] = [];
  for (const fid of [id, ...descendantsOf(m, id)]) {
    if (functionsOf(m, fid).length > 0) removed.push(docTitle(idef0Doc(fid), m));
    if (m.nodes.some((s) => s.bpmn_scope === fid)) removed.push(docTitle(bpmnDoc(fid), m));
  }
  return { changed: [...new Set(changed)], removed: [...new Set(removed)] };
}
