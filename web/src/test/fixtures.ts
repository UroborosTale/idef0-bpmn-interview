import type { Fragment, ProcessLogicModel, ProcessNode, SessionRecord } from "../types";

type M = ProcessLogicModel;

export const node = (id: string, name: string, extra: Partial<ProcessNode> = {}): ProcessNode => ({
  id,
  type: "task",
  name,
  role_id: null,
  system_ids: [],
  inputs: [],
  outputs: [],
  controls: [],
  status: "confirmed",
  confidence: 1,
  source: [],
  requirement_ids: [],
  tags: [],
  confirmed_by: [],
  ...extra,
});

export const fragments: Fragment[] = [{ id: "f1", index: 0, speaker: "owner", text: "Инициатор оформляет заявку, бухгалтер оплачивает счёт в 1С." }];

/**
 * Закупка: три функции верхнего уровня (у второй — две вложенные), выход B управляет C,
 * одна связь с цитатой из интервью. Та же структура, что у серверной фикстуры.
 */
export function purchaseModel(): M {
  return {
    schema_version: "2.0.0",
    process: { id: "p", name: "Закупка", type: "AS-IS", decomposition_depth: 2, notations: ["IDEF0", "BPMN"], version: "0.1", status: "draft", kpi: [], risks: [] },
    roles: [
      { id: "r1", name: "Инициатор", kind: "internal", source: [{ fragment_id: "f1", quote: "Инициатор оформляет заявку" }] },
      { id: "r2", name: "Бухгалтер", kind: "internal", source: [] },
    ],
    systems: [{ id: "s1", name: "1С", source: [] }],
    data: [
      { id: "d1", name: "заявка", kind: "document", source: [] },
      { id: "d2", name: "счёт", kind: "document", source: [] },
      { id: "d3", name: "решение", kind: "document", source: [] },
      { id: "d4", name: "оплата", kind: "document", source: [] },
    ],
    controls: [{ id: "c1", name: "регламент закупок", kind: "regulation", source: [] }],
    nodes: [
      node("a", "оформить заявку", { outputs: ["d1"], controls: ["c1"], role_id: "r1", source: [{ fragment_id: "f1", quote: "Инициатор оформляет заявку" }] }),
      node("b", "согласовать заявку", { inputs: ["d1"], outputs: ["d3"], controls: ["c1"], role_id: "r1" }),
      node("c", "оплатить счёт", { inputs: ["d2"], control_data_ids: ["d3"], outputs: ["d4"], role_id: "r2", system_ids: ["s1"] }),
      node("b1", "проверить бюджет", { idef0_parent: "b", inputs: ["d1"], controls: ["c1"] }),
      node("b2", "принять решение", { idef0_parent: "b", outputs: ["d3"], controls: ["c1"] }),
    ],
    flows: [
      { id: "f1", from: "a", to: "b", source: [], confirmed_by: [] },
      { id: "f2", from: "b", to: "c", condition: "если одобрено", source: [], confirmed_by: [] },
      { id: "f3", from: "b1", to: "b2", source: [], confirmed_by: [] },
    ],
    gaps: [{ id: "g1", rule: "no_duration", priority: "important", element_id: "a", question: "Сколько длится оформление заявки?", status: "open" }],
    statements: [],
    interfaces: [{ id: "i1", direction: "in", data_id: "d2" }],
    requirements_links: [],
    raci: [
      { node_id: "a", role_id: "r1", type: "R" },
      { node_id: "a", role_id: "r1", type: "A" },
    ],
    respondents: [],
    discrepancies: [],
  };
}

export function session(model: M = purchaseModel()): SessionRecord {
  return {
    id: "sess_test",
    title: model.process.name,
    mode: "A",
    status: "ready",
    meta: { processName: model.process.name, modelType: "AS-IS", decompositionDepth: 2, notations: ["IDEF0", "BPMN"] },
    fragments,
    rawText: fragments[0].text,
    model,
    validation: [],
    bpmnXml: null,
    idef0: null,
    chat: [],
    versions: [],
    comments: [],
    qa: [],
    diagramsStale: false,
    provider: null,
    regulationSnapshotSeq: null,
    respondents: [],
    tracks: [],
    verificationConfirmed: [],
    reviewRoute: null,
    createdAt: "2026-10-01T10:00:00Z",
    updatedAt: "2026-10-01T10:00:00Z",
  };
}
