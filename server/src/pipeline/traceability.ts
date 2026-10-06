import type { ProcessLogicModel } from "../types/model.js";

export interface TraceabilityRequirementRow {
  requirementId: string;
  code: string;
  title: string;
  linkedElementIds: string[];
  coverage: "full" | "partial" | "none";
}

export interface TraceabilityReport {
  requirements: TraceabilityRequirementRow[];
  coveragePercent: number;
  uncoveredRequirementIds: string[];
  unlinkedElementIds: string[];
}

export interface RequirementCatalogEntry {
  id: string;
  code: string;
  title: string;
}

/** ФТ-М6.3: трассировка требований — покрытие каталога требований элементами модели и наоборот. */
export function buildTraceabilityReport(model: ProcessLogicModel, catalog: RequirementCatalogEntry[]): TraceabilityReport {
  const linksByRequirement = new Map<string, { element_id: string; coverage: "full" | "partial" }[]>();
  for (const link of model.requirements_links) {
    const list = linksByRequirement.get(link.requirement_id) ?? [];
    list.push({ element_id: link.element_id, coverage: link.coverage });
    linksByRequirement.set(link.requirement_id, list);
  }

  const requirements: TraceabilityRequirementRow[] = catalog.map((r) => {
    const links = linksByRequirement.get(r.id) ?? [];
    const coverage: "full" | "partial" | "none" = links.length === 0 ? "none" : links.some((l) => l.coverage === "full") ? "full" : "partial";
    return { requirementId: r.id, code: r.code, title: r.title, linkedElementIds: links.map((l) => l.element_id), coverage };
  });

  const uncoveredRequirementIds = requirements.filter((r) => r.coverage === "none").map((r) => r.requirementId);
  const coveragePercent = catalog.length === 0 ? 0 : Math.round(((catalog.length - uncoveredRequirementIds.length) / catalog.length) * 100);

  const linkedElementIds = new Set(model.requirements_links.map((l) => l.element_id));
  const traceableElements = [
    ...model.nodes.filter((n) => n.type === "task" || n.type === "subprocess").map((n) => n.id),
    ...model.controls.map((c) => c.id),
  ];
  const unlinkedElementIds = traceableElements.filter((id) => !linkedElementIds.has(id));

  return { requirements, coveragePercent, uncoveredRequirementIds, unlinkedElementIds };
}
