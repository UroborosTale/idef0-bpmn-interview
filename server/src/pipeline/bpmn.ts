import type { ProcessLogicModel, ProcessNode } from "../types/model.js";
import { layoutLayered, orthogonalWaypoints, type LayoutNodeIn, type LayoutEdgeIn } from "./layout.js";
import { LANE_X, SIZE } from "../shared/bpmnGeometry.js";
import { idef0Codes } from "../shared/idef0Layout.js";
import { scopeView } from "../shared/scope.js";
import { artifactsOf, boundaryBoxes, isBoundaryNode, messageEdges, poolBoxes } from "../shared/bpmnArtifacts.js";

/** Диаграмма в структурированном виде (координаты в пикселях, как в BPMN DI) — для экспорта в VSDX. */
export interface BpmnDiagramData {
  poolName: string;
  width: number;
  height: number;
  pool: { x: number; y: number; w: number; h: number };
  /** roleId — id роли дорожки; null у дорожки «Без исполнителя». */
  lanes: { roleId: string | null; name: string; x: number; y: number; w: number; h: number }[];
  /** nodeId — id узла модели; у служебных начала/конца (их нет в модели) его нет. */
  shapes: { id: string; nodeId?: string; kind: "task" | "subprocess" | "gateway" | "event"; subtype?: string; name: string; x: number; y: number; w: number; h: number; /** id фигуры задачи, к которой прикреплено граничное событие */ attachedTo?: string; interrupting?: boolean }[];
  /** flowId — id потока модели (у служебных стрелок отсутствует); from/to — id фигур. */
  edges: { id: string; flowId?: string; from: string; to: string; points: [number, number][]; label?: string }[];
  /** data — документ, store — хранилище данных (информационная система), annotation — регламент; link — ассоциация с задачей. */
  extras: { kind: "data" | "store" | "annotation"; name: string; x: number; y: number; w: number; h: number; link?: [number, number][]; linkDirection?: "to-task" | "from-task" | "none" }[];
  /** Свёрнутые внешние пулы под диаграммой. */
  pools: { id: string; name: string; x: number; y: number; w: number; h: number }[];
  /** Потоки сообщений: id фигур-концов (фигура шага или пул). */
  messages: { id: string; from: string; to: string; points: [number, number][]; label?: string }[];
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
    case "business_rule":
      return "businessRuleTask";
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

function eventInfo(subtype?: string, boundary = false): { tag: string; def?: string } {
  if (boundary) {
    const def = { timer: "timerEventDefinition", message: "messageEventDefinition", error: "errorEventDefinition", signal: "signalEventDefinition" }[subtype ?? ""];
    return { tag: "boundaryEvent", def };
  }
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
      return { tag: "endEvent", def: "errorEventDefinition" }; // ошибку вне границы задачи можно только выбросить
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
  // граничное событие входит в диаграмму через свою задачу: у него нет входящих стрелок, но оно не начало процесса
  const isBoundary = (n: ProcessNode) => isBoundaryNode(n, nodes);
  const hostOf = (n: ProcessNode) => (isBoundary(n) ? nodes.find((x) => x.id === n.attached_to)! : n);
  const roots = nodes.filter((n) => (incomingCount.get(n.id) ?? 0) === 0 && !isBoundary(n));
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
  const roleOf = (n: ProcessNode) => hostOf(n).role_id;
  const hasUnassigned = nodes.some((n) => !roleOf(n)) || synthEvents.length > 0;
  const unassignedIndex = laneRoles.length;
  if (hasUnassigned) laneIndexOf.set(UNASSIGNED_LANE, unassignedIndex);
  const laneCount = laneRoles.length + (hasUnassigned ? 1 : 0);

  // --- layout ---
  // граничные события в раскладке не участвуют: они стоят на границе своей задачи, а их стрелки идут «от задачи»
  const layoutNodes: LayoutNodeIn[] = nodes
    .filter((n) => !isBoundary(n))
    .map((n) => {
      const size = NODE_SIZE[n.type] ?? NODE_SIZE.task;
      return {
        id: nodeIdOf(n.id),
        width: size.w,
        height: size.h,
        laneIndex: laneIndexOf.get(laneIdOf(roleOf(n))) ?? unassignedIndex,
      };
    });
  for (const se of synthEvents) {
    layoutNodes.push({ id: se.id, width: NODE_SIZE.event.w, height: NODE_SIZE.event.h, laneIndex: unassignedIndex });
  }
  const layoutSource = (id: string) => {
    const n = nodes.find((x) => x.id === id);
    return n && isBoundary(n) ? hostOf(n).id : id;
  };
  const layoutEdges: LayoutEdgeIn[] = [
    ...flows.map((f) => ({ id: f.id, from: nodeIdOf(layoutSource(f.from)), to: nodeIdOf(f.to) })),
    ...synthFlows.map((f) => ({ id: f.id, from: f.from, to: f.to })),
  ];
  const layout = await layoutLayered(layoutNodes, layoutEdges, Math.max(laneCount, 1));

  // Позиции, заданные в редакторе (node.layout), приоритетнее авто-раскладки.
  for (const n of nodes) {
    if (!n.layout) continue;
    const box = layout.boxes.get(nodeIdOf(n.id));
    if (box) layout.boxes.set(nodeIdOf(n.id), { ...box, x: n.layout.x, y: n.layout.y });
  }
  // граничные события — на нижней границе задачи
  const hostBoxes = new Map<string, { x: number; y: number; w: number; h: number }>();
  for (const n of nodes) {
    const b = layout.boxes.get(nodeIdOf(n.id));
    if (b) hostBoxes.set(n.id, { x: b.x, y: b.y, w: b.width, h: b.height });
  }
  for (const [id, b] of boundaryBoxes(nodes, hostBoxes)) layout.boxes.set(nodeIdOf(id), { x: b.x, y: b.y, width: b.w, height: b.h });
  for (const b of layout.boxes.values()) layout.totalWidth = Math.max(layout.totalWidth, b.x + b.width + 80);

  // --- XML: flow elements ---
  const flowElementsXml: string[] = [];
  const shapesXml: string[] = [];

  // документы и хранилища данных у задач: значки над задачей с ассоциациями
  const artifacts = artifactsOf(nodes, hostBoxes, { data: new Map(model.data.map((d) => [d.id, d.name])), systems: new Map(model.systems.map((s) => [s.id, s.name])) });
  const artId = (a: { nodeId: string; kind: string; entityId: string }) => `${a.kind === "store" ? "StoreRef" : "DataRef"}_${a.nodeId}_${a.entityId}`;

  function pushEventXml(id: string, name: string, subtype: string | undefined, attach?: { hostId: string; interrupting: boolean }) {
    const info = eventInfo(subtype, !!attach);
    const defXml = info.def ? `<bpmn:${info.def} />` : "";
    const attrs = attach ? ` attachedToRef="${nodeIdOf(attach.hostId)}" cancelActivity="${attach.interrupting}"` : "";
    flowElementsXml.push(`<bpmn:${info.tag} id="${id}" name="${esc(name)}"${attrs}>${defXml}</bpmn:${info.tag}>`);
  }

  for (const n of nodes) {
    const id = nodeIdOf(n.id);
    elementIndex[n.id] = id;
    if (n.type === "task") {
      const tag = taskTag(n.subtype);
      const mine = artifacts.filter((a) => a.nodeId === n.id);
      const inputAssoc = mine
        .filter((a) => a.kind === "input")
        .map((a) => `<bpmn:dataInputAssociation id="DIA_${n.id}_${a.entityId}"><bpmn:sourceRef>${artId(a)}</bpmn:sourceRef></bpmn:dataInputAssociation>`)
        .join("");
      const outputAssoc = mine
        .filter((a) => a.kind === "output")
        .map((a) => `<bpmn:dataOutputAssociation id="DOA_${n.id}_${a.entityId}"><bpmn:targetRef>${artId(a)}</bpmn:targetRef></bpmn:dataOutputAssociation>`)
        .join("");
      flowElementsXml.push(`<bpmn:${tag} id="${id}" name="${esc(n.name)}">${inputAssoc}${outputAssoc}</bpmn:${tag}>`);
    } else if (n.type === "subprocess") {
      flowElementsXml.push(`<bpmn:subProcess id="${id}" name="${esc(n.name)}" />`);
    } else if (n.type === "gateway") {
      const tag = gatewayTag(n.subtype);
      flowElementsXml.push(`<bpmn:${tag} id="${id}" name="${esc(n.name)}" />`);
    } else if (n.type === "event") {
      pushEventXml(id, n.name, n.subtype, isBoundary(n) ? { hostId: n.attached_to!, interrupting: n.interrupting !== false } : undefined);
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
  const usedControls = new Set(nodes.flatMap((n) => n.controls));
  const wp = (pts: [number, number][]) => pts.map(([x, y]) => `<di:waypoint x="${Math.round(x)}" y="${Math.round(y)}" />`).join("");
  const declared = new Set<string>();
  for (const a of artifacts) {
    const ref = artId(a);
    if (a.kind === "store") {
      // хранилище данных (информационная система): связь с задачей — ассоциация без направления
      dataXml.push(`<bpmn:dataStoreReference id="${ref}" name="${esc(a.name)}" />`);
      dataXml.push(`<bpmn:association id="Assoc_${ref}" sourceRef="${nodeIdOf(a.nodeId)}" targetRef="${ref}" associationDirection="None" />`);
    } else {
      if (!declared.has(a.entityId)) {
        declared.add(a.entityId);
        dataXml.push(`<bpmn:dataObject id="DataObj_${a.entityId}" name="${esc(a.name)}" />`);
      }
      dataXml.push(`<bpmn:dataObjectReference id="${ref}" name="${esc(a.name)}" dataObjectRef="DataObj_${a.entityId}" />`);
    }
    const { x, y, w, h } = a.box;
    diagramExtras.push({ kind: a.kind === "store" ? "store" : "data", name: a.name, x, y, w, h, link: a.edge, linkDirection: a.kind === "store" ? "none" : a.kind === "input" ? "to-task" : "from-task" });
    dataShapesXml.push(
      `<bpmndi:BPMNShape id="${ref}_di" bpmnElement="${ref}"><dc:Bounds x="${Math.round(x)}" y="${Math.round(y)}" width="${w}" height="${h}" /><bpmndi:BPMNLabel><dc:Bounds x="${Math.round(x + w / 2 - 35)}" y="${Math.round(y - 13)}" width="70" height="12" /></bpmndi:BPMNLabel></bpmndi:BPMNShape>`
    );
    const assoc = a.kind === "store" ? `Assoc_${ref}` : a.kind === "input" ? `DIA_${a.nodeId}_${a.entityId}` : `DOA_${a.nodeId}_${a.entityId}`;
    dataShapesXml.push(`<bpmndi:BPMNEdge id="${assoc}_di" bpmnElement="${assoc}">${wp(a.edge)}</bpmndi:BPMNEdge>`);
  }

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
      const hb = hostBoxes.get(referencingNode.id);
      if (hb) annotationShapesXml.push(`<bpmndi:BPMNEdge id="${assocId}_di" bpmnElement="${assocId}">${wp([[hb.x + hb.w / 2, hb.y + hb.h], [x + 90, y]])}</bpmndi:BPMNEdge>`);
    }
  });

  // lanes
  const lanesXml: string[] = [];
  for (const role of laneRoles) {
    const refs = nodes.filter((n) => roleOf(n) === role.id).map((n) => `<bpmn:flowNodeRef>${nodeIdOf(n.id)}</bpmn:flowNodeRef>`);
    lanesXml.push(`<bpmn:lane id="${laneIdOf(role.id)}" name="${esc(role.name)}">${refs.join("")}</bpmn:lane>`);
  }
  if (hasUnassigned) {
    const refs = [
      ...nodes.filter((n) => !roleOf(n)).map((n) => `<bpmn:flowNodeRef>${nodeIdOf(n.id)}</bpmn:flowNodeRef>`),
      ...synthEvents.map((se) => `<bpmn:flowNodeRef>${se.id}</bpmn:flowNodeRef>`),
    ];
    lanesXml.push(`<bpmn:lane id="${UNASSIGNED_LANE}" name="Без исполнителя">${refs.join("")}</bpmn:lane>`);
  }

  // shapes (nodes)
  const allNodeIds = [...nodes.map((n) => nodeIdOf(n.id)), ...synthEvents.map((s) => s.id)];
  const shapeMeta = new Map<string, { nodeId?: string; kind: BpmnDiagramData["shapes"][number]["kind"]; subtype?: string; name: string; attachedTo?: string; interrupting?: boolean }>([
    ...nodes.map((n) => [nodeIdOf(n.id), { nodeId: n.id, kind: n.type, subtype: n.subtype, name: n.name, ...(isBoundary(n) ? { attachedTo: nodeIdOf(n.attached_to!), interrupting: n.interrupting !== false } : {}) }] as const),
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
    const fromNode = nodes.find((n) => n.id === f.from);
    const toNode = nodes.find((n) => n.id === f.to);
    const points = orthogonalWaypoints(from, to, others, { fromType: fromNode?.type, toType: toNode?.type, fromBoundary: !!fromNode && isBoundary(fromNode) });
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

  // внешние пулы — свёрнутые участники под диаграммой (и под аннотациями), потоки сообщений идут к ним от шагов
  const allBoxes = new Map<string, { x: number; y: number; w: number; h: number }>();
  for (const n of nodes) {
    const b = layout.boxes.get(nodeIdOf(n.id));
    if (b) allBoxes.set(n.id, { x: b.x, y: b.y, w: b.width, h: b.height });
  }
  const knownPools = new Set((view.pools ?? []).map((q) => q.id));
  const messages = (view.messages ?? []).filter((m) => (visibleIds.has(m.from) && knownPools.has(m.to)) || (knownPools.has(m.from) && visibleIds.has(m.to)));
  const annotationsBottom = diagramExtras.filter((e) => e.kind === "annotation").reduce((mx, e) => Math.max(mx, e.y + e.h), 0);
  const poolsTop = Math.max(40 + poolHeight, annotationsBottom) + 50;
  const poolRects = poolBoxes(view.pools ?? [], messages, allBoxes, poolsTop);
  const poolLabel = (q: { name: string; code?: string | null }) => `${q.code ? `${q.code} ` : ""}${q.name}`;
  const poolEndId = (id: string) => (knownPools.has(id) ? `Pool_${id}` : nodeIdOf(id));
  const diagramPools: BpmnDiagramData["pools"] = [];
  const diagramMessages: BpmnDiagramData["messages"] = [];
  const participantsXml: string[] = [];
  const poolShapesXml: string[] = [];
  for (const q of view.pools ?? []) {
    const r = poolRects.get(q.id);
    if (!r) continue;
    participantsXml.push(`<bpmn:participant id="Pool_${q.id}" name="${esc(poolLabel(q))}" />`);
    poolShapesXml.push(`<bpmndi:BPMNShape id="Pool_${q.id}_di" bpmnElement="Pool_${q.id}" isHorizontal="true"><dc:Bounds x="${Math.round(r.x)}" y="${Math.round(r.y)}" width="${r.w}" height="${r.h}" /></bpmndi:BPMNShape>`);
    diagramPools.push({ id: `Pool_${q.id}`, name: poolLabel(q), x: r.x, y: r.y, w: r.w, h: r.h });
  }
  for (const { message: m, points } of messageEdges(messages, allBoxes, poolRects)) {
    participantsXml.push(`<bpmn:messageFlow id="Msg_${m.id}" name="${esc(m.name)}" sourceRef="${poolEndId(m.from)}" targetRef="${poolEndId(m.to)}" />`);
    poolShapesXml.push(`<bpmndi:BPMNEdge id="Msg_${m.id}_di" bpmnElement="Msg_${m.id}">${wp(points)}</bpmndi:BPMNEdge>`);
    diagramMessages.push({ id: `Msg_${m.id}`, from: poolEndId(m.from), to: poolEndId(m.to), points, label: m.name ?? undefined });
  }
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
    ${participantsXml.join("\n    ")}
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
      ${poolShapesXml.join("\n      ")}
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>
`;

  const pool = { x: 60, y: 40, w: poolWidth, h: poolHeight };
  const diagram: BpmnDiagramData = {
    poolName,
    width: pool.x + pool.w + 40,
    height: Math.max(pool.y + pool.h, ...diagramExtras.map((e) => e.y + e.h), ...diagramPools.map((q) => q.y + q.h)) + 40,
    pool,
    lanes: diagramLanes,
    shapes: diagramShapes,
    edges: diagramEdges,
    extras: diagramExtras,
    pools: diagramPools,
    messages: diagramMessages,
  };

  return { xml, elementIndex, diagram };
}
