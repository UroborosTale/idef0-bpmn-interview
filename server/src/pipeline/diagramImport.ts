import { nanoid } from "nanoid";
import type { ProcessLogicModel, ProcessNode, ProcessFlow, Role, NodeType } from "../types/model.js";
import { SCHEMA_VERSION } from "../types/model.js";
import type { SessionMeta } from "../repo.js";

/**
 * ФТ-М9.4.1/9.5.2: разбор структурированных форматов диаграмм (.bpmn, .drawio).
 *
 * Это простой регулярный разбор ключевых тегов/атрибутов, а не полноценный
 * XML-парсер (в проекте намеренно нет тяжёлой XML-DOM зависимости) — для
 * хорошо сформированных файлов, экспортированных bpmn.io, Camunda Modeler,
 * draw.io или этой же системой, этого достаточно: разбираются открывающие
 * теги элементов и их атрибуты, без учёта пространств имён и вложенности
 * содержимого. Импорт .vsdx (Visio) НЕ реализован — это закрытый
 * ZIP/OOXML-формат, разбор которого потребовал бы отдельной библиотеки и
 * существенного объёма работы несоразмерно ценности для демонстрации
 * конвейера; при попытке загрузить .vsdx роут возвращает понятную ошибку.
 */

function unescapeXml(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([a-zA-Z_:][-\w:.]*)\s*=\s*"([^"]*)"/g;
  let mm: RegExpExecArray | null;
  while ((mm = re.exec(s))) out[mm[1]] = unescapeXml(mm[2]);
  return out;
}

// --- BPMN ---

export interface ParsedBpmnElement {
  id: string;
  tag: string;
  name: string | null;
  sourceRef?: string;
  targetRef?: string;
  condition?: string | null;
}
export interface ParsedBpmn {
  elements: ParsedBpmnElement[];
  lanes: { id: string; name: string }[];
  warnings: string[];
}

const TASK_TAGS = ["task", "userTask", "serviceTask", "manualTask", "sendTask", "receiveTask", "scriptTask", "subProcess"];
const GATEWAY_TAGS = ["exclusiveGateway", "parallelGateway", "inclusiveGateway", "eventBasedGateway"];
const EVENT_TAGS = ["startEvent", "endEvent", "intermediateCatchEvent", "intermediateThrowEvent", "boundaryEvent"];

export function parseBpmnXml(xml: string): ParsedBpmn {
  const warnings: string[] = [];
  const elements: ParsedBpmnElement[] = [];
  const lanes: { id: string; name: string }[] = [];

  const laneRe = /<(?:\w+:)?lane\s+([^>]*?)(?:\/>|>)/g;
  let m: RegExpExecArray | null;
  while ((m = laneRe.exec(xml))) {
    const attrs = parseAttrs(m[1]);
    if (attrs.id) lanes.push({ id: attrs.id, name: attrs.name ?? attrs.id });
  }

  const nodeTagPattern = [...TASK_TAGS, ...GATEWAY_TAGS, ...EVENT_TAGS].join("|");
  const nodeRe = new RegExp(`<(?:\\w+:)?(${nodeTagPattern})\\s+([^>]*?)(?:/>|>)`, "g");
  while ((m = nodeRe.exec(xml))) {
    const attrs = parseAttrs(m[2]);
    if (!attrs.id) continue;
    elements.push({ id: attrs.id, tag: m[1], name: attrs.name ?? null });
  }

  const flowRe = /<(?:\w+:)?sequenceFlow\s+([^>]*?)(?:\/>|>)/g;
  while ((m = flowRe.exec(xml))) {
    const attrs = parseAttrs(m[1]);
    if (!attrs.id || !attrs.sourceRef || !attrs.targetRef) continue;
    elements.push({ id: attrs.id, tag: "sequenceFlow", name: attrs.name ?? null, sourceRef: attrs.sourceRef, targetRef: attrs.targetRef, condition: attrs.name ?? null });
  }

  if (elements.length === 0) warnings.push("Не найдено ни одного распознаваемого элемента BPMN — проверьте, что файл экспортирован из bpmn.io/Camunda Modeler и содержит стандартные теги.");
  return { elements, lanes, warnings };
}

function bpmnTagToNode(tag: string): { type: NodeType; subtype?: string } {
  if (tag === "subProcess") return { type: "subprocess" };
  if (TASK_TAGS.includes(tag)) return { type: "task", subtype: tag === "task" ? undefined : tag.replace(/Task$/, "").toLowerCase() };
  if (GATEWAY_TAGS.includes(tag)) return { type: "gateway", subtype: tag.replace(/Gateway$/, "").toLowerCase() === "exclusive" ? "exclusive" : tag.replace(/Gateway$/, "").toLowerCase() };
  if (tag === "startEvent") return { type: "event", subtype: "start" };
  if (tag === "endEvent") return { type: "event", subtype: "end" };
  return { type: "event", subtype: "intermediate" };
}

/** ФТ-М9.5.2/9.5.3: свежая модель PLM из разобранного BPMN — новая сессия, стартовая точка интервью (9.5.4). */
export function buildModelFromParsedBpmn(parsed: ParsedBpmn, meta: SessionMeta): { model: ProcessLogicModel; warnings: string[] } {
  const warnings = [...parsed.warnings];
  const roles: Role[] = parsed.lanes.map((l) => ({ id: `role_${nanoid(8)}`, name: l.name, kind: "internal", source: [] }));
  const roleByLaneId = new Map(parsed.lanes.map((l, i) => [l.id, roles[i]] as const));

  const nodeEls = parsed.elements.filter((e) => e.tag !== "sequenceFlow");
  const flowEls = parsed.elements.filter((e) => e.tag === "sequenceFlow");

  const idMap = new Map<string, string>(); // raw bpmn id -> PLM node id
  const nodes: ProcessNode[] = nodeEls.map((e) => {
    const plmId = `imp_${nanoid(8)}`;
    idMap.set(e.id, plmId);
    const { type, subtype } = bpmnTagToNode(e.tag);
    return {
      id: plmId,
      type,
      subtype,
      name: e.name ?? "(без названия)",
      role_id: null,
      system_ids: [],
      inputs: [],
      outputs: [],
      controls: [],
      duration: null,
      frequency: null,
      idef0_parent: null,
      status: e.name ? "confirmed" : "hypothesis",
      confidence: e.name ? 0.8 : 0.4,
      source: [{ fragment_id: "diagram_import", quote: e.id }],
      requirement_ids: [],
      tags: ["from_diagram_import"],
      confirmed_by: [],
    };
  });
  if (!nodeEls.some((e) => e.name)) warnings.push("Часть элементов диаграммы без названия — они отмечены как гипотезы.");

  const flows: ProcessFlow[] = [];
  for (const f of flowEls) {
    const from = idMap.get(f.sourceRef!);
    const to = idMap.get(f.targetRef!);
    if (!from || !to) {
      warnings.push(`Связь ${f.id} ссылается на нераспознанный элемент — пропущена.`);
      continue;
    }
    flows.push({ id: `flow_${nanoid(8)}`, from, to, condition: f.condition ?? null, source: [{ fragment_id: "diagram_import", quote: f.id }], confirmed_by: [] });
  }

  const model: ProcessLogicModel = {
    schema_version: SCHEMA_VERSION,
    process: {
      id: `proc_${nanoid(8)}`,
      name: meta.processName,
      owner: meta.owner,
      department: meta.department,
      type: meta.modelType,
      decomposition_depth: meta.decompositionDepth ?? 2,
      notations: ["IDEF0", "BPMN"],
      version: "0.1",
      status: "draft",
      kpi: [],
      risks: [],
    },
    roles,
    systems: [],
    data: [],
    controls: [],
    nodes,
    flows,
    gaps: [],
    statements: [],
    interfaces: [],
    requirements_links: [],
    raci: [],
    respondents: [],
    discrepancies: [],
  };
  void roleByLaneId; // роли из lane заведены в реестр ролей; привязка узел↔lane в bpmn.io не гарантированно парсится regex-разбором — оставлено на доработку аналитиком через панель модели
  return { model, warnings };
}

export interface ReconcileChanges {
  renamed: { nodeId: string; from: string; to: string }[];
  added: string[];
  missing: string[];
}

/** ФТ-М9.4.1: правки из bpmn.io/Camunda Modeler — отправка обратно в PLM существующей сессии. */
export function reconcileBpmnEdit(model: ProcessLogicModel, parsed: ParsedBpmn): { model: ProcessLogicModel; changes: ReconcileChanges } {
  const out: ProcessLogicModel = JSON.parse(JSON.stringify(model));
  const changes: ReconcileChanges = { renamed: [], added: [], missing: [] };
  const nodeById = new Map(out.nodes.map((n) => [n.id, n] as const));
  const seenNodeIds = new Set<string>();

  const nodeEls = parsed.elements.filter((e) => e.tag !== "sequenceFlow");
  for (const e of nodeEls) {
    const match = /^Node_(.+)$/.exec(e.id);
    if (match && nodeById.has(match[1])) {
      const node = nodeById.get(match[1])!;
      seenNodeIds.add(node.id);
      if (e.name && e.name !== node.name) {
        changes.renamed.push({ nodeId: node.id, from: node.name, to: e.name });
        node.name = e.name;
        if (!node.tags.includes("edited_externally")) node.tags = [...node.tags, "edited_externally"];
      }
    } else {
      const { type, subtype } = bpmnTagToNode(e.tag);
      const newNode: ProcessNode = {
        id: `imp_${nanoid(8)}`,
        type,
        subtype,
        name: e.name ?? "(без названия)",
        role_id: null,
        system_ids: [],
        inputs: [],
        outputs: [],
        controls: [],
        duration: null,
        frequency: null,
        idef0_parent: null,
        status: "hypothesis",
        confidence: 0.4,
        source: [{ fragment_id: "diagram_import", quote: e.id }],
        requirement_ids: [],
        tags: ["from_diagram_import", "added_externally"],
        confirmed_by: [],
      };
      out.nodes.push(newNode);
      changes.added.push(newNode.id);
      // индексация для последующего сопоставления sequenceFlow, ссылающихся на новый узел по его исходному bpmn-id
      nodeById.set(e.id, newNode);
    }
  }

  for (const n of model.nodes) {
    if (!seenNodeIds.has(n.id) && !parsed.elements.some((e) => e.id === `Node_${n.id}`)) {
      changes.missing.push(n.id);
    }
  }

  const flowEls = parsed.elements.filter((e) => e.tag === "sequenceFlow");
  const existingFlowKeys = new Set(out.flows.map((f) => `${f.from}|${f.to}`));
  for (const f of flowEls) {
    const fromId = /^Node_(.+)$/.exec(f.sourceRef ?? "")?.[1] ?? nodeById.get(f.sourceRef ?? "")?.id;
    const toId = /^Node_(.+)$/.exec(f.targetRef ?? "")?.[1] ?? nodeById.get(f.targetRef ?? "")?.id;
    if (!fromId || !toId) continue;
    const key = `${fromId}|${toId}`;
    if (!existingFlowKeys.has(key)) {
      out.flows.push({ id: `flow_${nanoid(8)}`, from: fromId, to: toId, condition: f.condition ?? null, source: [{ fragment_id: "diagram_import", quote: f.id }], confirmed_by: [] });
      existingFlowKeys.add(key);
    }
  }

  return { model: out, changes };
}

// --- draw.io (mxGraph) ---

export interface ParsedDrawioCell {
  id: string;
  value: string | null;
  isEdge: boolean;
  source?: string;
  target?: string;
}
export interface ParsedDrawio {
  cells: ParsedDrawioCell[];
  warnings: string[];
}

export function parseDrawioXml(xml: string): ParsedDrawio {
  const warnings: string[] = [];
  const cells: ParsedDrawioCell[] = [];
  const cellRe = /<mxCell\s+([^>]*?)\/?>(?:\s*<mxGeometry[^>]*\/?>\s*<\/mxCell>)?/g;
  let m: RegExpExecArray | null;
  while ((m = cellRe.exec(xml))) {
    const attrs = parseAttrs(m[1]);
    if (!attrs.id || attrs.id === "0" || attrs.id === "1") continue;
    if (!attrs.vertex && !attrs.edge) continue;
    cells.push({ id: attrs.id, value: attrs.value ?? null, isEdge: attrs.edge === "1", source: attrs.source, target: attrs.target });
  }
  if (cells.length === 0) warnings.push("Не найдено ни одной фигуры draw.io (mxCell с vertex или edge) — проверьте формат файла.");
  return { cells, warnings };
}

/** ФТ-М9.4.2: применить правки названий узлов IDEF0, внесённые в draw.io (по id ячейки "IDEF0_<nodeId>", см. idef0ToDrawio). */
export function reconcileDrawioIdef0Edit(model: ProcessLogicModel, parsed: ParsedDrawio): { model: ProcessLogicModel; changes: { nodeId: string; from: string; to: string }[] } {
  const out: ProcessLogicModel = JSON.parse(JSON.stringify(model));
  const nodeById = new Map(out.nodes.map((n) => [n.id, n] as const));
  const changes: { nodeId: string; from: string; to: string }[] = [];
  for (const cell of parsed.cells) {
    const match = /^IDEF0_(.+)$/.exec(cell.id);
    if (!match || !cell.value) continue;
    const node = nodeById.get(match[1]);
    if (!node) continue;
    // значение ячейки в идёт как "A1: Название" (см. idef0ToDrawio) — берём часть после первого ": "
    const label = cell.value.includes(": ") ? cell.value.slice(cell.value.indexOf(": ") + 2) : cell.value;
    if (label && label !== node.name) {
      changes.push({ nodeId: node.id, from: node.name, to: label });
      node.name = label;
      if (!node.tags.includes("edited_externally")) node.tags = [...node.tags, "edited_externally"];
    }
  }
  return { model: out, changes };
}

/** ФТ-М9.5.2/9.5.3: свежая модель PLM из произвольной (не обязательно IDEF0) draw.io-диаграммы — вершины как узлы, рёбра как связи. */
export function buildModelFromParsedDrawio(parsed: ParsedDrawio, meta: SessionMeta): { model: ProcessLogicModel; warnings: string[] } {
  const warnings = [...parsed.warnings];
  const idMap = new Map<string, string>();
  const nodes: ProcessNode[] = parsed.cells
    .filter((c) => !c.isEdge)
    .map((c) => {
      const plmId = `imp_${nanoid(8)}`;
      idMap.set(c.id, plmId);
      return {
        id: plmId,
        type: "task" as NodeType,
        name: c.value ?? "(без названия)",
        role_id: null,
        system_ids: [],
        inputs: [],
        outputs: [],
        controls: [],
        duration: null,
        frequency: null,
        idef0_parent: null,
        status: c.value ? ("confirmed" as const) : ("hypothesis" as const),
        confidence: c.value ? 0.7 : 0.4,
        source: [{ fragment_id: "diagram_import", quote: c.id }],
        requirement_ids: [],
        tags: ["from_diagram_import"],
        confirmed_by: [],
      };
    });

  const flows: ProcessFlow[] = [];
  for (const c of parsed.cells.filter((c) => c.isEdge)) {
    const from = c.source ? idMap.get(c.source) : undefined;
    const to = c.target ? idMap.get(c.target) : undefined;
    if (!from || !to) {
      warnings.push(`Связь ${c.id} без распознанных концов — пропущена.`);
      continue;
    }
    flows.push({ id: `flow_${nanoid(8)}`, from, to, condition: null, source: [{ fragment_id: "diagram_import", quote: c.id }], confirmed_by: [] });
  }

  const model: ProcessLogicModel = {
    schema_version: SCHEMA_VERSION,
    process: {
      id: `proc_${nanoid(8)}`,
      name: meta.processName,
      owner: meta.owner,
      department: meta.department,
      type: meta.modelType,
      decomposition_depth: meta.decompositionDepth ?? 2,
      notations: ["IDEF0", "BPMN"],
      version: "0.1",
      status: "draft",
      kpi: [],
      risks: [],
    },
    roles: [],
    systems: [],
    data: [],
    controls: [],
    nodes,
    flows,
    gaps: [],
    statements: [],
    interfaces: [],
    requirements_links: [],
    raci: [],
    respondents: [],
    discrepancies: [],
  };
  return { model, warnings };
}
