import type { ProcessLogicModel } from "../types/model.js";
import { diffModels } from "./diff.js";
import { buildRegulation } from "./regulation.js";

export interface AdjacentProcessImpact {
  processId: string;
  name: string;
  owner: string | null;
  reason: string;
}
export interface DocumentImpact {
  paragraphId: string;
  section: string;
}
export interface RequirementImpact {
  requirementId: string;
  elementId: string;
}

export interface AffectedRole {
  roleId: string;
  name: string;
}

export interface ImpactReport {
  significance: "cosmetic" | "structural" | "affects_others";
  changedElementIds: string[];
  changedNodeNames: string[];
  adjacentProcesses: AdjacentProcessImpact[];
  affectedDocuments: DocumentImpact[];
  affectedRequirements: RequirementImpact[];
  affectedRoles: AffectedRole[];
  kpiChanged: boolean;
}

/** Множество id элементов, затронутых изменением (добавлено/удалено/изменено), по всем сущностям PLM. */
function collectChangedIds(before: ProcessLogicModel, after: ProcessLogicModel): Set<string> {
  const d = diffModels(before, after);
  const ids = new Set<string>();
  const collect = (part: { added: { id: string }[]; removed: { id: string }[]; changed: { id: string }[] }) => {
    for (const x of part.added) ids.add(x.id);
    for (const x of part.removed) ids.add(x.id);
    for (const x of part.changed) ids.add(x.id);
  };
  collect(d.nodes);
  collect(d.flows);
  collect(d.roles);
  collect(d.systems);
  collect(d.data);
  collect(d.controls);
  return ids;
}

/**
 * ФТ-М7.3.1/7.3.2: анализ влияния изменений между базовой моделью (начало
 * цикла согласования) и текущей. Внешние связи (смежные процессы, документы)
 * передаются вызывающей стороной (routes/impactAnalysis.ts), т.к. требуют
 * обращения к БД реестра — сам модуль остаётся чистой функцией от моделей.
 */
export function analyzeImpact(
  before: ProcessLogicModel,
  after: ProcessLogicModel,
  linkedAdjacent: AdjacentProcessImpact[]
): ImpactReport {
  const d = diffModels(before, after);
  const changedIds = collectChangedIds(before, after);
  const nodeById = new Map(after.nodes.map((n) => [n.id, n] as const));
  const beforeNodeById = new Map(before.nodes.map((n) => [n.id, n] as const));

  const changedNodeNames = [...new Set([...d.nodes.added, ...d.nodes.removed, ...d.nodes.changed.map((c) => c.after)].map((n) => n.name))];

  // документы: абзацы регламента (М1.1), чьи sourceRefs пересекаются с изменёнными элементами
  const regParagraphs = buildRegulation(after);
  const affectedDocuments: DocumentImpact[] = regParagraphs
    .filter((p) => p.sourceRefs.some((ref) => changedIds.has(ref)))
    .map((p) => ({ paragraphId: p.id, section: p.section }));

  // требования: связи requirements_links, чей element_id изменился
  const affectedRequirements: RequirementImpact[] = after.requirements_links
    .filter((rl) => changedIds.has(rl.element_id))
    .map((rl) => ({ requirementId: rl.requirement_id, elementId: rl.element_id }));

  const kpiChanged = d.kpi.added.length > 0 || d.kpi.removed.length > 0 || d.kpi.changed.length > 0;

  // исполнители изменённых шагов (ФТ-М7.4.1)
  const roleById = new Map(after.roles.map((r) => [r.id, r.name] as const));
  const affectedRoleIds = new Set<string>();
  for (const n of after.nodes) {
    if (changedIds.has(n.id) && n.role_id) affectedRoleIds.add(n.role_id);
  }
  const affectedRoles = [...affectedRoleIds].map((roleId) => ({ roleId, name: roleById.get(roleId) ?? roleId }));

  // значимость (ФТ-М7.3.2)
  const hasStructuralChange = d.nodes.added.length > 0 || d.nodes.removed.length > 0 || d.flows.added.length > 0 || d.flows.removed.length > 0;
  const hasRoleReassignment = d.nodes.changed.some((c) => beforeNodeById.get(c.id)?.role_id !== nodeById.get(c.id)?.role_id);
  const affectsOthers = linkedAdjacent.length > 0 || affectedDocuments.length > 0 || affectedRequirements.length > 0;

  let significance: ImpactReport["significance"] = "cosmetic";
  if (affectsOthers) significance = "affects_others";
  else if (hasStructuralChange || hasRoleReassignment || kpiChanged) significance = "structural";

  return {
    significance,
    changedElementIds: [...changedIds],
    changedNodeNames,
    adjacentProcesses: linkedAdjacent,
    affectedDocuments,
    affectedRequirements,
    affectedRoles,
    kpiChanged,
  };
}
