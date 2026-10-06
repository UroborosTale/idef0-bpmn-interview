import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";
import { ProcessNode, type ProcessLogicModel, type ProcessFlow } from "../types/model.js";
import { VSDX_FORMAT } from "./vsdx.js";

/**
 * Чтение .vsdx, отредактированного в Microsoft Visio, обратно в модель процесса.
 * Файл строит vsdx.ts: фигуры помечены ячейками User (pm_k — вид элемента, pm_id — id в модели),
 * стрелки — соединители, приклеенные к фигурам. Здесь файл разбирается в плоские структуры
 * (readVsdx), а затем правки накладываются на текущую модель (applyVisio): позиции, названия,
 * дорожки (роли), новые и удалённые шаги, функции и связи.
 */

const IN = 96; // пикселей диаграммы в дюйме Visio

type M = ProcessLogicModel;
type Pt = { x: number; y: number };

interface VPort {
  dirX: number;
  dirY: number;
}

export interface VShape {
  id: number;
  tag: Record<string, string>;
  oneD: boolean;
  /** Левый верхний угол и размеры в пикселях диаграммы (у соединителя — ограничивающий прямоугольник). */
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  /** У соединителя — начало и конец в пикселях. */
  begin?: Pt;
  end?: Pt;
  hasOutline: boolean;
  ports: Map<number, VPort>;
}

export interface VGlue {
  /** id соединителя, какой его конец, к какой фигуре и в какую точку (индекс Connection, если не вся фигура). */
  from: number;
  end: "begin" | "end";
  to: number;
  port?: number;
}

export interface VPage {
  name: string;
  meta: Record<string, string>;
  shapes: VShape[];
  glue: VGlue[];
}

export interface VDoc {
  meta: Record<string, string>;
  pages: VPage[];
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  trimValues: false,
  textNodeName: "#text",
  parseAttributeValue: false,
  parseTagValue: false,
  isArray: (name) => ["Shape", "Cell", "Row", "Section", "Page", "Connect", "Rel", "Relationship"].includes(name),
});

type Node = Record<string, any>;
const arr = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

function cellsOf(node: Node): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of arr<Node>(node.Cell)) if (c["@_N"] !== undefined && c["@_V"] !== undefined) out[c["@_N"]] = String(c["@_V"]);
  return out;
}

/** Строковые значения секции User: имя строки → значение. */
function userOf(node: Node): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of arr<Node>(node.Section)) {
    if (s["@_N"] !== "User") continue;
    for (const r of arr<Node>(s.Row)) {
      const v = arr<Node>(r.Cell).find((c) => c["@_N"] === "Value");
      if (r["@_N"] && v) out[r["@_N"]] = String(v["@_V"] ?? "");
    }
  }
  return out;
}

function textOf(shape: Node): string {
  const t = shape.Text;
  if (t === undefined || t === null) return "";
  if (typeof t === "string") return t;
  const body = t["#text"];
  return Array.isArray(body) ? body.join("") : typeof body === "string" ? body : "";
}

function portsOf(shape: Node): Map<number, VPort> {
  const ports = new Map<number, VPort>();
  for (const s of arr<Node>(shape.Section)) {
    if (s["@_N"] !== "Connection") continue;
    arr<Node>(s.Row).forEach((r, i) => {
      const c = cellsOf(r);
      ports.set(r["@_IX"] !== undefined ? Number(r["@_IX"]) : i, { dirX: Number(c.DirX ?? 0), dirY: Number(c.DirY ?? 0) });
    });
  }
  return ports;
}

function collectShapes(container: Node | undefined, pageH: number, out: VShape[]) {
  for (const s of arr<Node>(container?.Shape)) {
    const c = cellsOf(s);
    const id = Number(s["@_ID"]);
    const oneD = c.BeginX !== undefined && c.EndX !== undefined;
    const W = Number(c.Width ?? 0);
    const H = Number(c.Height ?? 0);
    const locX = c.LocPinX !== undefined ? Number(c.LocPinX) : W / 2;
    const locY = c.LocPinY !== undefined ? Number(c.LocPinY) : H / 2;
    const px = Number(c.PinX ?? 0);
    const py = Number(c.PinY ?? 0);
    const shape: VShape = {
      id,
      tag: userOf(s),
      oneD,
      x: (px - locX) * IN,
      y: (pageH - (py + (H - locY))) * IN,
      w: W * IN,
      h: H * IN,
      text: textOf(s),
      hasOutline: c.LinePattern === undefined || Number(c.LinePattern) !== 0,
      ports: portsOf(s),
    };
    if (oneD) {
      shape.begin = { x: Number(c.BeginX) * IN, y: (pageH - Number(c.BeginY)) * IN };
      shape.end = { x: Number(c.EndX) * IN, y: (pageH - Number(c.EndY)) * IN };
    }
    out.push(shape);
    collectShapes(s.Shapes, pageH, out); // группы
  }
}

/** Разбирает пакет .vsdx в страницы с фигурами и приклейками. */
export async function readVsdx(buf: Buffer): Promise<VDoc> {
  const zip = await JSZip.loadAsync(buf);
  const read = async (name: string) => {
    const f = zip.file(name);
    if (!f) throw new Error(`в файле нет части ${name}`);
    return f.async("string");
  };
  const docXml = parser.parse(await read("visio/document.xml"));
  const meta = userOf(docXml.VisioDocument?.DocumentSheet ?? {});

  const pagesXml = parser.parse(await read("visio/pages/pages.xml"));
  const relsXml = parser.parse(await read("visio/pages/_rels/pages.xml.rels"));
  const target = new Map<string, string>(arr<Node>(relsXml.Relationships?.Relationship).map((r) => [r["@_Id"], r["@_Target"]] as const));

  const pages: VPage[] = [];
  for (const p of arr<Node>(pagesXml.Pages?.Page)) {
    const sheet = p.PageSheet ?? {};
    const rid = arr<Node>(p.Rel)[0]?.["@_r:id"];
    const file = rid ? target.get(rid) : undefined;
    if (!file) continue;
    const pageH = Number(cellsOf(sheet).PageHeight ?? 0);
    const content = parser.parse(await read(`visio/pages/${file.replace(/^\/?(visio\/pages\/)?/, "")}`));
    const root = content.PageContents ?? {};
    const shapes: VShape[] = [];
    collectShapes(root.Shapes, pageH, shapes);
    const glue: VGlue[] = [];
    for (const c of arr<Node>(root.Connects?.Connect)) {
      const toCell: string = c["@_ToCell"] ?? "";
      const m = /^Connections\.X(\d+)$/.exec(toCell);
      glue.push({ from: Number(c["@_FromSheet"]), end: c["@_FromCell"] === "BeginX" ? "begin" : "end", to: Number(c["@_ToSheet"]), port: m ? Number(m[1]) - 1 : undefined });
    }
    pages.push({ name: p["@_Name"] ?? p["@_NameU"] ?? "", meta: userOf(sheet), shapes, glue });
  }
  return { meta, pages };
}

// --- наложение правок на модель ---

export interface ApplyResult {
  model: M;
  /** Фигуры и соединители, из которых при этом созданы элементы модели («страница|id фигуры» → id элемента). */
  created: Record<string, string>;
  /** Человекочитаемый список изменений. */
  changes: string[];
  warnings: string[];
}

/** Уже созданное из фигур Visio ранее: файл у пользователя открыт и хранит те же копии, их нельзя создавать повторно. */
interface Ctx {
  known: Record<string, string>;
  created: Record<string, string>;
}

const clean = (s: string) => s.replace(/\s+/g, " ").trim();
const SHORT = 26;
const short = (s: string) => (s.length > SHORT ? s.slice(0, SHORT - 1) + "…" : s);
const q = (s: string) => `«${s}»`;

function nextId(prefix: string, used: Iterable<string>): string {
  const set = new Set(used);
  let i = set.size + 1;
  while (set.has(prefix + i)) i++;
  return prefix + i;
}

const mapNode = (m: M, id: string, fn: (n: ProcessNode) => ProcessNode): M => ({ ...m, nodes: m.nodes.map((n) => (n.id === id ? fn(n) : n)) });
type Slot = "inputs" | "outputs" | "controls" | "control_data_ids" | "system_ids";
const slotOf = (n: ProcessNode, slot: Slot): string[] => n[slot] ?? [];
const attach = (m: M, nodeId: string, slot: Slot, id: string): M => mapNode(m, nodeId, (n) => (slotOf(n, slot).includes(id) ? n : { ...n, [slot]: [...slotOf(n, slot), id] }));
const detach = (m: M, nodeId: string, slot: Slot, id: string): M => mapNode(m, nodeId, (n) => ({ ...n, [slot]: slotOf(n, slot).filter((x) => x !== id) }));

function subtreeIds(m: M, id: string): Set<string> {
  const ids = new Set([id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const n of m.nodes) if (n.idef0_parent && ids.has(n.idef0_parent) && !ids.has(n.id)) (ids.add(n.id), (grew = true));
  }
  return ids;
}

/** Удаляет узел вместе со вложенными функциями и всем, что на них ссылается. */
function deleteNode(m: M, id: string): M {
  const gone = subtreeIds(m, id);
  return {
    ...m,
    nodes: m.nodes.filter((n) => !gone.has(n.id)),
    flows: m.flows.filter((f) => !gone.has(f.from) && !gone.has(f.to)),
    raci: m.raci.filter((r) => !gone.has(r.node_id)),
    requirements_links: m.requirements_links.filter((r) => !gone.has(r.element_id)),
    discrepancies: m.discrepancies.filter((d) => !gone.has(d.element_id)),
    interfaces: m.interfaces.map((i) => (i.linked_node_id && gone.has(i.linked_node_id) ? { ...i, linked_node_id: null } : i)),
  };
}

const newNode = (m: M, over: Partial<ProcessNode> & Pick<ProcessNode, "name">): ProcessNode =>
  ProcessNode.parse({ type: "task", status: "confirmed", confidence: 1, ...over, id: nextId("n", m.nodes.map((n) => n.id)) });

const parseManifest = (page: VPage): Record<string, string[]> | null => {
  try {
    return page.meta.pm_manifest ? JSON.parse(page.meta.pm_manifest) : null;
  } catch {
    return null;
  }
};

/**
 * Разбивает фигуры одного вида по id модели: «оригинал» — фигура, чей Visio-id совпадает с записанным
 * pm_sid, остальные — копии (Ctrl+C/V, Ctrl+D), то есть новые элементы.
 */
function splitCopies(shapes: VShape[]): { originals: Map<string, VShape>; copies: VShape[] } {
  const byId = new Map<string, VShape[]>();
  for (const s of shapes) byId.set(s.tag.pm_id, [...(byId.get(s.tag.pm_id) ?? []), s]);
  const originals = new Map<string, VShape>();
  const copies: VShape[] = [];
  for (const [id, list] of byId) {
    const own = list.find((s) => String(s.id) === s.tag.pm_sid) ?? list[0];
    originals.set(id, own);
    copies.push(...list.filter((s) => s !== own));
  }
  return { originals, copies };
}

/** Фигура-кандидат на новый элемент: нарисована в Visio вручную (нет тегов), с текстом и контуром. */
const isDrawnByHand = (s: VShape) => !s.oneD && s.tag.pm_k === undefined && clean(s.text) !== "" && s.hasOutline && s.w > 10 && s.h > 10;

/**
 * Текст изменён пользователем в Visio — относительно того, что было записано при выгрузке (pm_n).
 * Сравнение с моделью нельзя: на другой странице тот же элемент мог быть уже изменён.
 */
const textEdited = (s: VShape, text: string) => (s.tag.pm_n === undefined ? true : text !== s.tag.pm_n);

const moved = (s: VShape, tag: Record<string, string>) => Math.abs(s.x - Number(tag.pm_x ?? s.x)) > 1.5 || Math.abs(s.y - Number(tag.pm_y ?? s.y)) > 1.5;
const rnd = (v: number) => Math.round(v);
const samePlace = (at: { x: number; y: number } | null | undefined, s: VShape) => !!at && Math.abs(at.x - s.x) <= 1.5 && Math.abs(at.y - s.y) <= 1.5;

// --- BPMN ---

function applyBpmn(m: M, page: VPage, ctx: Ctx, changes: string[], warnings: string[]): M {
  const manifest = parseManifest(page);
  const shapeById = new Map(page.shapes.map((s) => [s.id, s] as const));

  // дорожки: роль определяется по дорожке, в которую попал центр фигуры
  const lanes = page.shapes.filter((s) => s.tag.pm_k === "lane").map((s) => ({ roleId: s.tag.pm_id === "__unassigned__" ? null : s.tag.pm_id, y0: s.y, y1: s.y + s.h }));
  const laneRoleAt = (s: VShape): string | null | undefined => {
    const cy = s.y + s.h / 2;
    const lane = lanes.find((l) => cy >= l.y0 && cy < l.y1);
    return lane ? lane.roleId : undefined;
  };

  // роли: переименование подписи дорожки
  for (const s of page.shapes.filter((x) => x.tag.pm_k === "lanelabel" && x.tag.pm_id !== "__unassigned__")) {
    const name = clean(s.text);
    const role = m.roles.find((r) => r.id === s.tag.pm_id);
    if (role && name && textEdited(s, name) && name !== role.name) {
      changes.push(`Роль ${q(role.name)} переименована в ${q(name)}`);
      m = { ...m, roles: m.roles.map((r) => (r.id === role.id ? { ...r, name } : r)) };
    }
  }

  const nodeShapes = page.shapes.filter((s) => s.tag.pm_k === "node" && !s.oneD);
  const { originals, copies } = splitCopies(nodeShapes);
  const visioToNode = new Map<number, string>(); // Visio-id фигуры → id узла (включая только что созданные)
  const skey = (s: VShape) => `${page.meta.pm_page}|${s.id}`;
  const handDrawn = page.shapes.filter(isDrawnByHand);
  // копии и нарисованные фигуры, из которых шаги уже созданы при прошлом применении, — обычные существующие шаги
  const knownShapes = [...copies, ...handDrawn].filter((s) => ctx.known[skey(s)]);
  const existing: [string, VShape][] = [...originals, ...knownShapes.map((s) => [ctx.known[skey(s)], s] as [string, VShape])];
  for (const [id, s] of existing) visioToNode.set(s.id, id);

  // удалённые в Visio шаги
  for (const id of manifest?.n ?? []) {
    if (originals.has(id) || !m.nodes.some((n) => n.id === id)) continue;
    const gone = m.nodes.find((n) => n.id === id)!;
    changes.push(`Удалён шаг ${q(gone.name)}`);
    m = deleteNode(m, id);
  }

  // существующие шаги: название, позиция, дорожка
  let movedCount = 0;
  for (const [id, s] of existing) {
    const node = m.nodes.find((n) => n.id === id);
    if (!node) continue;
    const name = clean(s.text);
    const patch: Partial<ProcessNode> = {};
    if (name && textEdited(s, name) && name !== node.name) {
      changes.push(`Шаг ${q(node.name)} переименован в ${q(name)}`);
      patch.name = name;
    }
    // позиция: фигура сдвинута относительно выгрузки и модель ещё не знает этого положения (повторное сохранение ничего не меняет)
    const isMoved = moved(s, s.tag) && !samePlace(node.layout, s);
    // дорожка (исполнитель) меняется только если фигуру переместили: иначе устаревший файл затёр бы правку роли
    const roleAt = moved(s, s.tag) ? laneRoleAt(s) : undefined;
    if (roleAt !== undefined && (roleAt ?? null) !== (node.role_id ?? null)) {
      const label = (rid: string | null | undefined) => (rid ? m.roles.find((r) => r.id === rid)?.name ?? rid : "Без исполнителя");
      changes.push(`Шаг ${q(patch.name ?? node.name)}: исполнитель ${q(label(node.role_id))} → ${q(label(roleAt))}`);
      patch.role_id = roleAt;
    }
    if (isMoved || patch.role_id !== undefined) {
      if (isMoved) movedCount++;
      patch.layout = { x: rnd(s.x), y: rnd(s.y) };
    }
    if (Object.keys(patch).length) m = mapNode(m, id, (n) => ({ ...n, ...patch }));
  }
  if (movedCount) changes.push(`Перемещено фигур: ${movedCount}`);

  // новые шаги: копии фигур и нарисованные вручную
  const fresh: { shape: VShape; source?: ProcessNode }[] = [
    ...copies.filter((s) => !ctx.known[skey(s)]).map((shape) => ({ shape, source: m.nodes.find((n) => n.id === shape.tag.pm_id) })),
    ...handDrawn.filter((s) => !ctx.known[skey(s)]).map((shape) => ({ shape })),
  ];
  for (const { shape, source } of fresh) {
    const roleAt = laneRoleAt(shape);
    const node = newNode(m, {
      name: clean(shape.text) || "Новый шаг",
      type: source?.type ?? "task",
      subtype: source?.subtype,
      role_id: roleAt === undefined ? source?.role_id ?? null : roleAt,
      layout: { x: rnd(shape.x), y: rnd(shape.y) },
    });
    m = { ...m, nodes: [...m.nodes, node] };
    visioToNode.set(shape.id, node.id);
    ctx.created[skey(shape)] = node.id;
    changes.push(`Добавлен шаг ${q(node.name)}`);
  }

  // потоки
  const nodeOfEnd = (flowShape: VShape, end: "begin" | "end"): string | undefined => {
    const g = page.glue.find((x) => x.from === flowShape.id && x.end === end);
    if (!g) return undefined;
    const target = shapeById.get(g.to);
    if (!target) return undefined;
    return visioToNode.get(g.to);
  };
  const glued = (s: VShape, end: "begin" | "end") => page.glue.some((x) => x.from === s.id && x.end === end);

  const flowShapes = page.shapes.filter((s) => s.oneD && s.tag.pm_k === "flow");
  const flowSplit = splitCopies(flowShapes);
  const presentFlows = new Set(flowSplit.originals.keys());

  for (const id of manifest?.f ?? []) {
    if (presentFlows.has(id)) continue;
    const gone = m.flows.find((f) => f.id === id);
    if (!gone) continue;
    const a = m.nodes.find((n) => n.id === gone.from)?.name ?? gone.from;
    const b = m.nodes.find((n) => n.id === gone.to)?.name ?? gone.to;
    changes.push(`Удалена связь ${q(a)} → ${q(b)}`);
    m = { ...m, flows: m.flows.filter((f) => f.id !== id) };
  }

  for (const [id, s] of flowSplit.originals) {
    const flow = m.flows.find((f) => f.id === id);
    if (!flow) continue;
    const from = nodeOfEnd(s, "begin");
    const to = nodeOfEnd(s, "end");
    const patch: Partial<ProcessFlow> = {};
    if (from && to && from !== to && (from !== flow.from || to !== flow.to)) {
      const n = (nid: string) => m.nodes.find((x) => x.id === nid)?.name ?? nid;
      changes.push(`Связь ${q(n(flow.from))} → ${q(n(flow.to))} перенаправлена: ${q(n(from))} → ${q(n(to))}`);
      patch.from = from;
      patch.to = to;
    } else if (!glued(s, "begin") || !glued(s, "end")) {
      warnings.push(`Соединитель ${s.id} не приклеен к фигуре с одного из концов — связь оставлена как была`);
    }
    const label = clean(s.text);
    if (textEdited(s, label) && label !== (flow.condition ?? "")) {
      changes.push(label ? `Условие связи: ${q(label)}` : "Условие связи убрано");
      patch.condition = label || null;
    }
    if (Object.keys(patch).length) m = { ...m, flows: m.flows.map((f) => (f.id === id ? { ...f, ...patch } : f)) };
  }

  // новые связи: соединители без тегов и копии соединителей
  const newConnectors = [...flowSplit.copies, ...page.shapes.filter((s) => s.oneD && s.tag.pm_k === undefined)];
  for (const s of newConnectors) {
    if (ctx.known[skey(s)]) continue; // связь по этому соединителю уже создана
    const from = nodeOfEnd(s, "begin");
    const to = nodeOfEnd(s, "end");
    if (!from || !to || from === to) {
      if (!page.glue.some((g) => g.from === s.id && shapeById.get(g.to)?.tag.pm_k === "synth")) warnings.push(`Новый соединитель ${s.id} пропущен: оба конца должны быть приклеены к шагам процесса`);
      continue;
    }
    if (m.flows.some((f) => f.from === from && f.to === to)) {
      ctx.created[skey(s)] = m.flows.find((f) => f.from === from && f.to === to)!.id;
      continue;
    }
    const condition = clean(s.text) || null;
    const flow: ProcessFlow = { id: nextId("flow", m.flows.map((f) => f.id)), from, to, condition, source: [], confirmed_by: [] };
    m = { ...m, flows: [...m.flows, flow] };
    ctx.created[skey(s)] = flow.id;
    const n = (nid: string) => m.nodes.find((x) => x.id === nid)?.name ?? nid;
    changes.push(`Новая связь ${q(n(from))} → ${q(n(to))}`);
  }
  return m;
}

// --- IDEF0 ---

type ArrowKind = "input" | "link" | "output" | "control" | "controlData" | "controlLink" | "role" | "system";

/** Название функции: текст блока без служебной строки с кодом («A21 ⊞»). */
function functionName(text: string): string {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  while (lines.length > 1 && /^A\d+(\s*⊞)?$/.test(lines[lines.length - 1])) lines.pop();
  return clean(lines.join(" "));
}

function renameEntity(m: M, kind: ArrowKind, id: string, name: string): M {
  const ren = <T extends { id: string; name: string }>(xs: T[]) => xs.map((x) => (x.id === id ? { ...x, name } : x));
  switch (kind) {
    case "control":
      return { ...m, controls: ren(m.controls) };
    case "role":
      return { ...m, roles: ren(m.roles) };
    case "system":
      return { ...m, systems: ren(m.systems) };
    default:
      return { ...m, data: ren(m.data) };
  }
}

const entityName = (m: M, kind: ArrowKind, id: string): string | undefined =>
  (kind === "control" ? m.controls : kind === "role" ? m.roles : kind === "system" ? m.systems : m.data).find((e) => e.id === id)?.name;

/** Есть ли у функции стрелка этого вида с этой сущностью. */
function hasArrow(n: ProcessNode, kind: ArrowKind, entityId: string): boolean {
  switch (kind) {
    case "input":
    case "link":
      return n.inputs.includes(entityId);
    case "output":
      return n.outputs.includes(entityId);
    case "control":
      return n.controls.includes(entityId);
    case "controlData":
    case "controlLink":
      return (n.control_data_ids ?? []).includes(entityId);
    case "system":
      return n.system_ids.includes(entityId);
    case "role":
      return !!n.role_id;
  }
}

function removeArrow(m: M, kind: ArrowKind, nodeId: string, entityId: string): M {
  switch (kind) {
    case "input":
    case "link":
      return detach(m, nodeId, "inputs", entityId);
    case "output":
      return detach(m, nodeId, "outputs", entityId);
    case "control":
      return detach(m, nodeId, "controls", entityId);
    case "controlData":
    case "controlLink":
      return detach(m, nodeId, "control_data_ids", entityId);
    case "system":
      return detach(m, nodeId, "system_ids", entityId);
    case "role":
      return mapNode(m, nodeId, (n) => ({ ...n, role_id: null }));
  }
}

const siblingsOf = (m: M, parentId: string | null) => m.nodes.filter((n) => (n.type === "task" || n.type === "subprocess") && (n.idef0_parent ?? null) === parentId);

/** Связь «выход from → вход (или управление) to»: берёт непотреблённый выход источника или создаёт данные. */
function linkFunctions(m: M, from: string, to: string, as: "input" | "control", name: string | null): { model: M; ok: boolean } {
  const a = m.nodes.find((n) => n.id === from);
  const b = m.nodes.find((n) => n.id === to);
  if (!a || !b || from === to) return { model: m, ok: false };
  const takenBy = (n: ProcessNode, did: string) => n.inputs.includes(did) || (n.control_data_ids ?? []).includes(did);
  const sameKind = (n: ProcessNode, did: string) => (as === "control" ? (n.control_data_ids ?? []).includes(did) : n.inputs.includes(did));
  if (a.outputs.some((o) => sameKind(b, o))) return { model: m, ok: false };
  const free = a.outputs.find((o) => m.data.some((d) => d.id === o) && !siblingsOf(m, a.idef0_parent ?? null).some((f) => f.id !== from && takenBy(f, o)));
  let next = m;
  let dataId = free;
  if (!dataId) {
    dataId = nextId("data", m.data.map((d) => d.id));
    next = { ...m, data: [...m.data, { id: dataId, name: name ?? "Новый документ", kind: "document", source: [] }] };
    next = attach(next, from, "outputs", dataId);
  } else if (name) {
    next = renameEntity(next, "link", dataId, name);
  }
  return { model: attach(next, to, as === "control" ? "control_data_ids" : "inputs", dataId), ok: true };
}

function applyIdef0(m: M, page: VPage, ctx: Ctx, changes: string[], warnings: string[]): M {
  const manifest = parseManifest(page);
  const parentId = page.meta.pm_parent ?? null;
  const shapeById = new Map(page.shapes.map((s) => [s.id, s] as const));

  const fnShapes = page.shapes.filter((s) => s.tag.pm_k === "fn" && !s.oneD);
  const { originals, copies } = splitCopies(fnShapes);
  const visioToNode = new Map<number, string>();
  const skey = (s: VShape) => `${page.meta.pm_page}|${s.id}`;
  const handDrawn = page.shapes.filter(isDrawnByHand);
  const knownShapes = [...copies, ...handDrawn].filter((s) => ctx.known[skey(s)]);
  const existing: [string, VShape][] = [...originals, ...knownShapes.map((s) => [ctx.known[skey(s)], s] as [string, VShape])];
  for (const [id, s] of existing) visioToNode.set(s.id, id);

  for (const id of manifest?.fn ?? []) {
    if (originals.has(id)) continue;
    const gone = m.nodes.find((n) => n.id === id);
    if (!gone) continue;
    changes.push(`Удалена функция ${q(gone.name)}${m.nodes.some((n) => n.idef0_parent === id) ? " вместе с вложенными" : ""}`);
    m = deleteNode(m, id);
  }

  let movedCount = 0;
  for (const [id, s] of existing) {
    const node = m.nodes.find((n) => n.id === id);
    if (!node) continue;
    const patch: Partial<ProcessNode> = {};
    const name = functionName(s.text);
    if (name && textEdited(s, name) && name !== node.name) {
      changes.push(`Функция ${q(node.name)} переименована в ${q(name)}`);
      patch.name = name;
    }
    if (moved(s, s.tag) && !samePlace(node.idef0_layout, s)) {
      movedCount++;
      patch.idef0_layout = { x: rnd(s.x), y: rnd(s.y) };
    }
    if (Object.keys(patch).length) m = mapNode(m, id, (n) => ({ ...n, ...patch }));
  }
  if (movedCount) changes.push(`Перемещено блоков: ${movedCount}`);

  const fresh = [...copies, ...handDrawn].filter((s) => !ctx.known[skey(s)]);
  for (const shape of fresh) {
    const node = newNode(m, { name: functionName(shape.text) || "Новая функция", idef0_parent: parentId, idef0_layout: { x: Math.max(20, rnd(shape.x)), y: Math.max(20, rnd(shape.y)) } });
    m = { ...m, nodes: [...m.nodes, node] };
    visioToNode.set(shape.id, node.id);
    ctx.created[skey(shape)] = node.id;
    changes.push(`Добавлена функция ${q(node.name)}`);
  }

  const fnOfEnd = (s: VShape, end: "begin" | "end") => {
    const g = page.glue.find((x) => x.from === s.id && x.end === end);
    return g ? { fn: visioToNode.get(g.to), port: g.port !== undefined ? shapeById.get(g.to)?.ports.get(g.port) : undefined } : undefined;
  };

  // стрелки модели: соединители с тегом pm_a = «вид|функция|сущность»
  const arrowShapes = page.shapes.filter((s) => s.oneD && s.tag.pm_k === "arrow");
  const present = new Map<string, VShape>();
  const dupes: VShape[] = [];
  for (const s of arrowShapes) {
    const key = s.tag.pm_a;
    const prev = present.get(key);
    if (!prev) present.set(key, s);
    else if (String(s.id) === s.tag.pm_sid && String(prev.id) !== prev.tag.pm_sid) (dupes.push(prev), present.set(key, s));
    else dupes.push(s);
  }

  for (const key of manifest?.ar ?? []) {
    if (present.has(key)) continue;
    const [kind, nodeId, entityId] = key.split("|") as [ArrowKind, string, string];
    if (!m.nodes.some((n) => n.id === nodeId)) continue;
    const owner = m.nodes.find((n) => n.id === nodeId)!;
    if (!hasArrow(owner, kind, entityId)) continue; // уже убрана при прошлом применении
    const fnName = owner.name;
    changes.push(`Удалена стрелка ${q(entityName(m, kind, entityId) ?? entityId)} у функции ${q(fnName)}`);
    m = removeArrow(m, kind, nodeId, entityId);
  }

  for (const [key, s] of present) {
    const [kind, nodeId, entityId] = key.split("|") as [ArrowKind, string, string];
    if (!m.nodes.some((n) => n.id === nodeId)) continue;
    const label = clean(s.text);
    const name = entityName(m, kind, entityId);
    if (name !== undefined && label && textEdited(s, label) && label !== name && label !== short(name)) {
      changes.push(`Стрелка ${q(name)} переименована в ${q(label)}`);
      m = renameEntity(m, kind, entityId, label);
    }
    if (kind === "link" || kind === "controlLink") {
      // конец или начало переклеены на другие функции
      const to = fnOfEnd(s, "end")?.fn;
      const from = fnOfEnd(s, "begin")?.fn;
      const slot: Slot = kind === "link" ? "inputs" : "control_data_ids";
      const producer = siblingsOf(m, m.nodes.find((n) => n.id === nodeId)?.idef0_parent ?? null).find((n) => n.id !== nodeId && n.outputs.includes(entityId))?.id;
      if (to && to !== nodeId) {
        changes.push(`Стрелка ${q(name ?? entityId)} переключена на функцию ${q(m.nodes.find((n) => n.id === to)?.name ?? to)}`);
        m = attach(detach(m, nodeId, slot, entityId), to, slot, entityId);
      }
      if (from && producer && from !== producer) {
        changes.push(`Источник стрелки ${q(name ?? entityId)} изменён на ${q(m.nodes.find((n) => n.id === from)?.name ?? from)}`);
        m = attach(detach(m, producer, "outputs", entityId), from, "outputs", entityId);
      }
    }
  }

  // новые связи: соединители без тегов и копии соединителей, приклеенные к двум блокам
  for (const s of [...dupes, ...page.shapes.filter((x) => x.oneD && x.tag.pm_k === undefined)]) {
    if (ctx.known[skey(s)]) continue;
    const a = fnOfEnd(s, "begin");
    const b = fnOfEnd(s, "end");
    if (!a?.fn || !b?.fn || a.fn === b.fn) {
      warnings.push(`Новый соединитель ${s.id} на странице ${q(page.name)} пропущен: нужно приклеить оба конца к блокам функций`);
      continue;
    }
    // конец на верхней стороне блока — управление, иначе — вход
    const as = b.port && b.port.dirY > 0 ? "control" : "input";
    const res = linkFunctions(m, a.fn, b.fn, as, clean(s.text) || null);
    if (!res.ok) {
      ctx.created[skey(s)] = `${a.fn}>${b.fn}`;
      if (!ctx.known[skey(s)]) warnings.push(`Связь ${q(m.nodes.find((n) => n.id === a.fn)?.name ?? "")} → ${q(m.nodes.find((n) => n.id === b.fn)?.name ?? "")} уже существует`);
      continue;
    }
    m = res.model;
    ctx.created[skey(s)] = `${a.fn}>${b.fn}`;
    changes.push(`Новая стрелка: ${q(m.nodes.find((n) => n.id === a.fn)?.name ?? "")} → ${as === "control" ? "управление" : "вход"} ${q(m.nodes.find((n) => n.id === b.fn)?.name ?? "")}`);
  }
  return m;
}

/**
 * Накладывает на модель правки из файла Visio. Бросает ошибку, если файл не относится к этой сессии.
 */
export function applyVisio(model: M, doc: VDoc, sessionId: string, known: Record<string, string> = {}): ApplyResult {
  if (doc.meta.pm_fmt !== VSDX_FORMAT) throw new Error("Файл создан не этим приложением (или другой версией): нет служебных меток");
  if (doc.meta.pm_session && doc.meta.pm_session !== sessionId) throw new Error("Файл относится к другой сессии");
  const changes: string[] = [];
  const warnings: string[] = [];
  const created: Record<string, string> = {};
  const ctx: Ctx = { known, created };
  let m = model;
  for (const page of doc.pages) {
    const kind = page.meta.pm_page ?? "";
    if (page.meta.pm_ro) continue;
    if (kind === "bpmn") m = applyBpmn(m, page, ctx, changes, warnings);
    else if (kind.startsWith("idef0:")) m = applyIdef0(m, page, ctx, changes, warnings);
  }
  return { model: m, changes, warnings, created };
}
