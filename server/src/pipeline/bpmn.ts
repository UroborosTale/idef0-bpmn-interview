import type { ProcessLogicModel, ProcessNode } from "../types/model.js";
import { layoutLayered, orthogonalWaypoints, type LayoutNodeIn, type LayoutEdgeIn } from "./layout.js";
import { LANE_X, SIZE } from "../shared/bpmnGeometry.js";
import { idef0Codes } from "../shared/idef0Layout.js";
import { scopeView } from "../shared/scope.js";

/** Диаграмма в структурированном виде (координаты в пикселях, как в BPMN DI) — для экспорта в VSDX. */
export interface BpmnDiagramData {
  poolName: string;
  width: number;
  height: number;
  pool: { x: number; y: number; w: number; h: number };
  /** roleId — id роли дорожки; null у дорожки «Без исполнителя». */
  lanes: { roleId: string | null; name: string; x: number; y: number; w: number; h: number }[];
  /** nodeId — id узла модели; у служебных начала/конца (их нет в модели) его нет. */
  shapes: { id: string; nodeId?: string; kind: "task" | "subprocess" | "gateway" | "event"; subtype?: string; name: string; x: number; y: number; w: number; h: number }[];
  /** flowId — id потока модели (у служебных стрелок отсутствует); from/to — id фигур. */
  edges: { id: string; flowId?: string; from: string; to: string; points: [number, number][]; label?: string }[];
  extras: { kind: "data" | "annotation"; name: string; x: number; y: number; w: number; h: number }[];
}

export interface BpmnGenerationResult {
  xml: string;
  elementIndex: Record<string, string>; // model node id -> bpmn element id
  diagram: BpmnDiagramData;
}

function esc(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function taskTag(subtype?: string): string {
  switch (subtype) {
    case "user":
      return "userTask";
    case "service":
      return "serviceTask";
    case "manual":
      return "manualTask";
    case "send":
      return "sendTask";
    case "receive":
      return "receiveTask";
    case "script":
      return "scriptTask";
    default:
      return "task";
  }
}

function gatewayTag(subtype?: string): string {
  switch (subtype) {
    case "parallel":
      return "parallelGateway";
    case "inclusive":
      return "inclusiveGateway";
    case "event_based":
      return "eventBasedGateway";
    default:
      return "exclusiveGateway";
  }
}

function eventInfo(subtype?: string): { tag: string; def?: string } {
  switch (subtype) {
    case "start":
      return { tag: "startEvent" };
    case "end":
      return { tag: "endEvent" };
    case "timer":
      return { tag: "intermediateCatchEvent", def: "timerEventDefinition" };
    case "message":
      return { tag: "intermediateCatchEvent", def: "messageEventDefinition" };
    case "error":
      return { tag: "boundaryEvent", def: "errorEventDefinition" };
    case "signal":
      return { tag: "intermediateThrowEvent", def: "signalEventDefinition" };
    default:
      return { tag: "intermediateThrowEvent" };
  }
}

// Размеры фигур — общие с редактором (shared/bpmnGeometry.ts).
const NODE_SIZE = SIZE;

/**
 * Детерминированная генерация BPMN 2.0 XML (ФТ-6) из промежуточной модели.
 * Пул + дорожки по ролям, задачи с типами, шлюзы, события, объекты данных,
 * авто-раскладка слева направо через ElkJS (layered/Sugiyama, ФТ-6.2) с
 * ортогональной маршрутизацией стрелок. Совместим с bpmn.io / Camunda Modeler.
 *
 * scope — id операции: тогда строится диаграмма BPMN этой операции (её шаги и дорожки её исполнителей, имя —
 * «код название»); null — общая схема процесса.
 */
export async function generateBpmn(model: ProcessLogicModel, scope: string | null = null): Promise<BpmnGenerationResult> {
  const elementIndex: Record<string, string> = {};
  const nodeIdOf = (mid: string) => `Node_${mid}`;

  const view = scopeView(model, scope);
  const host = scope ? model.nodes.find((n) => n.id === scope) : undefined;
  const poolName = host ? `${idef0Codes(model).get(host.id) ?? ""} ${host.name}`.trim() : model.process.name;

  // Узлы с idef0_parent — детали декомпозиции IDEF0, на диаграмме процесса они не показываются
  // (родитель остаётся одним шагом). Стрелки к скрытым узлам тоже опускаем.
  const nodes = view.nodes.filter((n) => !n.idef0_parent);
  const visibleIds = new Set(nodes.map((n) => n.id));
  const flows = view.flows.filter((f) => visibleIds.has(f.from) && visibleIds.has(f.to));

  // синтетические старт/конец, если явных событий нет в модели (только для рендера)
  const hasExplicitStart = nodes.some((n) => n.type === "event" && n.subtype === "start");
  const hasExplicitEnd = nodes.some((n) => n.type === "event" && n.subtype === "end");

  const outgoingCount = new Map<string, number>();
  const incomingCount = new Map<string, number>();
  for (const f of flows) {
    outgoingCount.set(f.from, (outgoingCount.get(f.from) ?? 0) + 1);
    incomingCount.set(f.to, (incomingCount.get(f.to) ?? 0) + 1);
  }
  const roots = nodes.filter((n) => (incomingCount.get(n.id) ?? 0) === 0);
  const leaves = nodes.filter((n) => (outgoingCount.get(n.id) ?? 0) === 0 && !(n.type === "event" && n.subtype === "end"));

  type SynthEvent = { id: string; name: string; kind: "start" | "end" };
  const synthEvents: SynthEvent[] = [];
  const synthFlows: { id: string; from: string; to: string }[] = [];
  if (!hasExplicitStart) {
    const sid = "SynthStart";
    synthEvents.push({ id: sid, name: "Начало процесса", kind: "start" });
    for (const r of roots) synthFlows.push({ id: `SynthFlow_s_${r.id}`, from: sid, to: nodeIdOf(r.id) });
  }
  if (!hasExplicitEnd) {
    const eid = "SynthEnd";
    synthEvents.push({ id: eid, name: "Завершение процесса", kind: "end" });
    for (const l of leaves) synthFlows.push({ id: `SynthFlow_e_${l.id}`, from: nodeIdOf(l.id), to: eid });
  }

  // роли -> дорожки (+ "без исполнителя")
  const laneRoles = [...view.roles];
  const UNASSIGNED_LANE = "Lane_unassigned";
  const laneIdOf = (roleId: string | null | undefined) => (roleId ? `Lane_${roleId}` : UNASSIGNED_LANE);
  const laneIndexOf = new Map<string, number>();
  laneRoles.forEach((r, i) => laneIndexOf.set(laneIdOf(r.id), i));
  const hasUnassigned = nodes.some((n) => !n.role_id) || synthEvents.length > 0;
  const unassignedIndex = laneRoles.length;
  if (hasUnassigned) laneIndexOf.set(UNASSIGNED_LANE, unassignedIndex);
  const laneCount = laneRoles.length + (hasUnassigned ? 1 : 0);

  // --- layout ---
  const layoutNodes: LayoutNodeIn[] = nodes.map((n) => {
    const size = NODE_SIZE[n.type] ?? NODE_SIZE.task;
    return {
      id: nodeIdOf(n.id),
      width: size.w,
      height: size.h,
      laneIndex: laneIndexOf.get(laneIdOf(n.role_id)) ?? unassignedIndex,
    };
  });
  for (const se of synthEvents) {
    layoutNodes.push({ id: se.id, width: NODE_SIZE.event.w, height: NODE_SIZE.event.h, laneIndex: unassignedIndex });
  }
  const layoutEdges: LayoutEdgeIn[] = [
    ...flows.map((f) => ({ id: f.id, from: nodeIdOf(f.from), to: nodeIdOf(f.to) })),
    ...synthFlows.map((f) => ({ id: f.id, from: f.from, to: f.to })),
  ];
  const layout = await layoutLayered(layoutNodes, layoutEdges, Math.max(laneCount, 1));

  // Позиции, заданные в редакторе (node.layout), приоритетнее авто-раскладки.
  for (const n of nodes) {
    if (!n.layout) continue;
    const box = layout.boxes.get(nodeIdOf(n.id));
    if (box) layout.boxes.set(nodeIdOf(n.id), { ...box, x: n.layout.x, y: n.layout.y });
  }
  for (const b of layout.boxes.values()) layout.totalWidth = Math.max(layout.totalWidth, b.x + b.width + 80);

  // --- XML: flow elements ---
  const flowElementsXml: string[] = [];
  const shapesXml: string[] = [];

  function pushEventXml(id: string, name: string, subtype: string | undefined) {
    const info = eventInfo(subtype);
    const defXml = info.def ? `<bpmn:${info.def} />` : "";
    flowElementsXml.push(`<bpmn:${info.tag} id="${id}" name="${esc(name)}">${defXml}</bpmn:${info.tag}>`);
  }

  for (const n of nodes) {
    const id = nodeIdOf(n.id);
    elementIndex[n.id] = id;
    if (n.type === "task") {
      const tag = taskTag(n.subtype);
      const inputAssoc = n.inputs
        .map((did, i) => `<bpmn:dataInputAssociation id="DIA_${n.id}_${i}"><bpmn:sourceRef>DataRef_${did}</bpmn:sourceRef></bpmn:dataInputAssociation>`)
        .join("");
      const outputAssoc = n.outputs
        .map((did, i) => `<bpmn:dataOutputAssociation id="DOA_${n.id}_${i}"><bpmn:targetRef>DataRef_${did}</bpmn:targetRef></bpmn:dataOutputAssociation>`)
        .join("");
      flowElementsXml.push(`<bpmn:${tag} id="${id}" name="${esc(n.name)}">${inputAssoc}${outputAssoc}</bpmn:${tag}>`);
    } else if (n.type === "subprocess") {
      flowElementsXml.push(`<bpmn:subProcess id="${id}" name="${esc(n.name)}" />`);
    } else if (n.type === "gateway") {
      const tag = gatewayTag(n.subtype);
      flowElementsXml.push(`<bpmn:${tag} id="${id}" name="${esc(n.name)}" />`);
    } else if (n.type === "event") {
      pushEventXml(id, n.name, n.subtype);
    }
  }
  for (const se of synthEvents) pushEventXml(se.id, se.name, se.kind);

  for (const f of flows) {
    const condXml = f.condition
      ? `<bpmn:conditionExpression xsi:type="bpmn:tFormalExpression">${esc(f.condition)}</bpmn:conditionExpression>`
      : "";
    flowElementsXml.push(
      `<bpmn:sequenceFlow id="Flow_${f.id}" sourceRef="${nodeIdOf(f.from)}" targetRef="${nodeIdOf(f.to)}"${
        f.condition ? ` name="${esc(f.condition)}"` : ""
      }>${condXml}</bpmn:sequenceFlow>`
    );
  }
  for (const sf of synthFlows) {
    flowElementsXml.push(`<bpmn:sequenceFlow id="Flow_${sf.id}" sourceRef="${sf.from}" targetRef="${sf.to}" />`);
  }

  // структурированные данные диаграммы (для VSDX)
  const diagramExtras: BpmnDiagramData["extras"] = [];
  const diagramShapes: BpmnDiagramData["shapes"] = [];
  const diagramEdges: BpmnDiagramData["edges"] = [];

  // data objects
  const dataXml: string[] = [];
  const dataShapesXml: string[] = [];
  const usedData = new Set(nodes.flatMap((n) => [...n.inputs, ...n.outputs]));
  const usedControls = new Set(nodes.flatMap((n) => n.controls));
  (scope ? model.data.filter((d) => usedData.has(d.id)) : model.data).forEach((d, i) => {
    dataXml.push(`<bpmn:dataObject id="DataObj_${d.id}" name="${esc(d.name)}" />`);
    dataXml.push(`<bpmn:dataObjectReference id="DataRef_${d.id}" name="${esc(d.name)}" dataObjectRef="DataObj_${d.id}" />`);
    const x = 100 + i * 110;
    diagramExtras.push({ kind: "data", name: d.name, x, y: 10, w: 36, h: 50 });
    dataShapesXml.push(
      `<bpmndi:BPMNShape id="DataRef_${d.id}_di" bpmnElement="DataRef_${d.id}"><dc:Bounds x="${x}" y="10" width="36" height="50" /></bpmndi:BPMNShape>`
    );
  });

  // controls as text annotations, associated with the tasks that reference them
  const annotationXml: string[] = [];
  const annotationShapesXml: string[] = [];
  const annotationAssocXml: string[] = [];
  (scope ? model.controls.filter((c) => usedControls.has(c.id)) : model.controls).forEach((c, i) => {
    const annId = `Annotation_${c.id}`;
    annotationXml.push(`<bpmn:textAnnotation id="${annId}"><bpmn:text>${esc(c.name)}</bpmn:text></bpmn:textAnnotation>`);
    const y = layout.totalHeight + 20;
    const x = 100 + i * 220;
    diagramExtras.push({ kind: "annotation", name: c.name, x, y, w: 180, h: 60 });
    annotationShapesXml.push(
      `<bpmndi:BPMNShape id="${annId}_di" bpmnElement="${annId}"><dc:Bounds x="${x}" y="${y}" width="180" height="60" /></bpmndi:BPMNShape>`
    );
    const referencingNode = nodes.find((n) => n.controls.includes(c.id));
    if (referencingNode) {
      const assocId = `Assoc_${c.id}`;
      annotationXml.push(
        `<bpmn:association id="${assocId}" sourceRef="${nodeIdOf(referencingNode.id)}" targetRef="${annId}" />`
      );
    }
  });

  // lanes
  const lanesXml: string[] = [];
  for (const role of laneRoles) {
    const refs = nodes.filter((n) => n.role_id === role.id).map((n) => `<bpmn:flowNodeRef>${nodeIdOf(n.id)}</bpmn:flowNodeRef>`);
    lanesXml.push(`<bpmn:lane id="${laneIdOf(role.id)}" name="${esc(role.name)}">${refs.join("")}</bpmn:lane>`);
  }
  if (hasUnassigned) {
    const refs = [
      ...nodes.filter((n) => !n.role_id).map((n) => `<bpmn:flowNodeRef>${nodeIdOf(n.id)}</bpmn:flowNodeRef>`),
      ...synthEvents.map((se) => `<bpmn:flowNodeRef>${se.id}</bpmn:flowNodeRef>`),
    ];
    lanesXml.push(`<bpmn:lane id="${UNASSIGNED_LANE}" name="Без исполнителя">${refs.join("")}</bpmn:lane>`);
  }

  // shapes (nodes)
  const allNodeIds = [...nodes.map((n) => nodeIdOf(n.id)), ...synthEvents.map((s) => s.id)];
  const shapeMeta = new Map<string, { nodeId?: string; kind: BpmnDiagramData["shapes"][number]["kind"]; subtype?: string; name: string }>([
    ...nodes.map((n) => [nodeIdOf(n.id), { nodeId: n.id, kind: n.type, subtype: n.subtype, name: n.name }] as const),
    ...synthEvents.map((s) => [s.id, { kind: "event" as const, subtype: s.kind, name: s.name }] as const),
  ]);
  for (const id of allNodeIds) {
    const box = layout.boxes.get(id);
    if (!box) continue;
    diagramShapes.push({ id, ...shapeMeta.get(id)!, x: box.x, y: box.y, w: box.width, h: box.height });
    shapesXml.push(
      `<bpmndi:BPMNShape id="${id}_di" bpmnElement="${id}"><dc:Bounds x="${Math.round(box.x)}" y="${Math.round(
        box.y
      )}" width="${box.width}" height="${box.height}" /></bpmndi:BPMNShape>`
    );
  }

  // edges — ортогональная маршрутизация (см. пояснение в layout.ts)
  const edgesXml: string[] = [];
  for (const f of flows) {
    const from = layout.boxes.get(nodeIdOf(f.from));
    const to = layout.boxes.get(nodeIdOf(f.to));
    if (!from || !to) continue;
    const others = [...layout.boxes.entries()].filter(([id]) => id !== nodeIdOf(f.from) && id !== nodeIdOf(f.to)).map(([, b]) => b);
    const points = orthogonalWaypoints(from, to, others);
    diagramEdges.push({ id: `Flow_${f.id}`, flowId: f.id, from: nodeIdOf(f.from), to: nodeIdOf(f.to), points, label: f.condition ?? undefined });
    const waypointsXml = points.map(([x, y]) => `<di:waypoint x="${Math.round(x)}" y="${Math.round(y)}" />`).join("");
    edgesXml.push(`<bpmndi:BPMNEdge id="Flow_${f.id}_di" bpmnElement="Flow_${f.id}">${waypointsXml}</bpmndi:BPMNEdge>`);
  }
  for (const sf of synthFlows) {
    const from = layout.boxes.get(sf.from);
    const to = layout.boxes.get(sf.to);
    if (!from || !to) continue;
    const points = orthogonalWaypoints(from, to);
    diagramEdges.push({ id: `Flow_${sf.id}`, from: sf.from, to: sf.to, points });
    const waypointsXml = points.map(([x, y]) => `<di:waypoint x="${Math.round(x)}" y="${Math.round(y)}" />`).join("");
    edgesXml.push(`<bpmndi:BPMNEdge id="Flow_${sf.id}_di" bpmnElement="Flow_${sf.id}">${waypointsXml}</bpmndi:BPMNEdge>`);
  }

  const laneSetXml = laneCount > 0 ? `<bpmn:laneSet id="LaneSet_1">${lanesXml.join("")}</bpmn:laneSet>` : "";

  const poolWidth = layout.totalWidth + 20;
  const poolHeight = Math.max(layout.totalHeight, 120) + 20;
  const diagramLanes: BpmnDiagramData["lanes"] = [];
  const laneShapesXml = [...laneRoles.map((r) => r.id), ...(hasUnassigned ? ["__unassigned__"] : [])].map((rid, i) => {
    const bounds = layout.laneBounds[i] ?? { y: 60, height: 150 };
    diagramLanes.push({ roleId: rid === "__unassigned__" ? null : rid, name: rid === "__unassigned__" ? "Без исполнителя" : laneRoles[i].name, x: LANE_X, y: bounds.y, w: poolWidth - LANE_X, h: bounds.height });
    const laneId = rid === "__unassigned__" ? UNASSIGNED_LANE : laneIdOf(rid);
    return `<bpmndi:BPMNShape id="${laneId}_di" bpmnElement="${laneId}" isHorizontal="true"><dc:Bounds x="${LANE_X}" y="${bounds.y}" width="${poolWidth - LANE_X}" height="${bounds.height}" /></bpmndi:BPMNShape>`;
  });

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" xmlns:di="http://www.omg.org/spec/DD/20100524/DI" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" id="Definitions_${model.process.id}${scope ? `_${scope}` : ""}" targetNamespace="http://example.org/bpmn" exporter="IDEF0-BPMN Interview System" exporterVersion="1.0">
  <bpmn:collaboration id="Collaboration_1">
    <bpmn:participant id="Participant_1" name="${esc(poolName)}" processRef="Process_1" />
  </bpmn:collaboration>
  <bpmn:process id="Process_1" name="${esc(poolName)}" isExecutable="false">
    ${laneSetXml}
    ${flowElementsXml.join("\n    ")}
    ${dataXml.join("\n    ")}
    ${annotationXml.join("\n    ")}
  </bpmn:process>
  <bpmndi:BPMNDiagram id="BPMNDiagram_1">
    <bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="Collaboration_1">
      <bpmndi:BPMNShape id="Participant_1_di" bpmnElement="Participant_1" isHorizontal="true"><dc:Bounds x="60" y="40" width="${poolWidth}" height="${poolHeight}" /></bpmndi:BPMNShape>
      ${laneShapesXml.join("\n      ")}
      ${shapesXml.join("\n      ")}
      ${dataShapesXml.join("\n      ")}
      ${annotationShapesXml.join("\n      ")}
      ${edgesXml.join("\n      ")}
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>
`;

  const pool = { x: 60, y: 40, w: poolWidth, h: poolHeight };
  const diagram: BpmnDiagramData = {
    poolName,
    width: pool.x + pool.w + 40,
    height: Math.max(pool.y + pool.h, ...diagramExtras.map((e) => e.y + e.h)) + 40,
    pool,
    lanes: diagramLanes,
    shapes: diagramShapes,
    edges: diagramEdges,
    extras: diagramExtras,
  };

  return { xml, elementIndex, diagram };
}
