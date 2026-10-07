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
    assignments: [],
    pools: [],
    messages: [],
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

/**
 * Модель по структуре Соглашения о моделировании: процесс B002.00.00, подпроцессы s1 и s2, операции o1–o3,
 * у операции o1 — диаграмма BPMN (старт, две задачи, конец), ролевая модель и продукты.
 */
export function structuredModel(): ProcessLogicModel {
  const role = (id: string, name: string, extra: object = {}) => ({ id, name, kind: "internal" as const, source: [], ...extra });
  const data = (id: string, name: string) => ({ id, name, kind: "document" as const, source: [] });
  return {
    ...purchaseModel(),
    process: { id: "p", name: "Управление процессами", code: "B002.00.00", type: "AS-IS", decomposition_depth: 2, notations: ["IDEF0", "BPMN"], version: "0.1", status: "draft", kpi: [], risks: [] },
    roles: [role("r1", "Начальник отдела"), role("r2", "Специалист отдела", { qualification: "Опыт моделирования" }), role("r3", "Директор")],
    systems: [{ id: "s1", name: "ELMA365", source: [] }],
    data: [data("d1", "Информация о процессе"), data("d2", "Реестр процессов"), data("d3", "Протокол интервью"), data("d4", "Информация об эффективности")],
    controls: [{ id: "c1", name: "СТП 113", kind: "regulation", source: [] }],
    nodes: [
      node("s1", "Моделирование процесса", { inputs: ["d1"], outputs: ["d3"], controls: ["c1"] }),
      node("s2", "Анализ эффективности", { inputs: ["d3"], outputs: ["d4"], controls: ["c1"] }),
      node("o1", "Актуализация реестра", { idef0_parent: "s1", inputs: ["d1"], outputs: ["d2"], controls: ["c1"], role_id: "r2" }),
      node("o2", "Проведение интервью", { idef0_parent: "s1", inputs: ["d2"], outputs: ["d3"], controls: ["c1"] }),
      node("o3", "Анализ соответствия", { idef0_parent: "s2", inputs: ["d3"], outputs: ["d4"], controls: ["c1"], role_id: "r2" }),
      node("b0", "Информация получена", { type: "event", subtype: "start", bpmn_scope: "o1", role_id: "r2", layout: { x: 160, y: 120 } }),
      node("b1", "Открыть реестр", { bpmn_scope: "o1", role_id: "r2", system_ids: ["s1"], layout: { x: 280, y: 100 } }),
      node("b2", "Внести код процесса", { bpmn_scope: "o1", role_id: "r2", layout: { x: 440, y: 100 } }),
      node("b9", "Реестр актуализирован", { type: "event", subtype: "end", bpmn_scope: "o1", role_id: "r2", layout: { x: 600, y: 120 } }),
    ],
    flows: [
      { id: "bf1", from: "b0", to: "b1", source: [], confirmed_by: [] },
      { id: "bf2", from: "b1", to: "b2", source: [], confirmed_by: [] },
      { id: "bf3", from: "b2", to: "b9", source: [], confirmed_by: [] },
    ],
    gaps: [],
    interfaces: [],
    raci: [],
    assignments: [
      { node_id: null, role_id: "r1", kind: "owner", functions: [] },
      { node_id: "s1", role_id: "r1", kind: "owner", functions: [] },
      { node_id: "o1", role_id: "r3", kind: "controller", functions: [] },
      { node_id: "o1", role_id: "r2", kind: "executor", functions: ["Внесение данных в реестр"] },
    ],
  };
}