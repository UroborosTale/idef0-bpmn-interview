import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";
import { nanoid } from "nanoid";
import type { ProcessFlow, ProcessNode, Role } from "../types/model.js";
import type { SessionMeta } from "../repo.js";
import type { EventTrigger, TriggerType } from "../shared/events.js";
import { importedModel } from "./diagramImport.js";

/**
 * Импорт Visio (.vsdx → модель процесса, ТЗ Р10, М9.5). Файл — ZIP-пакет OPC: страницы лежат в visio/pages, имена
 * мастеров (какая фигура из какого трафарета) — в visio/masters. Разбираются:
 *  - фигуры страницы (в том числе внутри групп) → шаги, события и шлюзы; вид определяется по имени мастера
 *    («Task», «Decision», «Start Event», «Процесс»…), а для фигур без мастера — по геометрии (эллипс, ромб, прямоугольник);
 *  - соединители, приклеенные к фигурам (таблица Connect); неприклеенные концы привязываются к ближайшей фигуре;
 *  - дорожки и пулы (по имени мастера) → исполнители: шаг получает роль той дорожки, в которой лежит;
 *  - собственные выгрузки приложения (ячейки pm_*): точные виды, названия и дорожки.
 * Страницы IDEF0 пропускаются. Всё распознанное — черновик (гипотезы, где у фигуры нет текста): аналитик проверяет модель.
 */

const IN = 96; // дюйм Visio → пиксели

export interface VsdxBox {
  x: number;
  y: number; // верх, y вниз
  w: number;
  h: number;
}

export interface VsdxNode {
  key: string;
  shapeId: string;
  kind: "task" | "subprocess" | "gateway" | "event";
  /** Вид задачи (user, service…), шлюза (exclusive, parallel…) или события (start, end, intermediate); для события без явного вида — не задан. */
  subtype?: string;
  trigger?: EventTrigger;
  text: string;
  box: VsdxBox;
}
export interface VsdxContainer {
  /** id роли собственной выгрузки; у чужих файлов не задан. */
  laneId?: string;
  name: string;
  box: VsdxBox;
}
export interface VsdxEdge {
  from: string;
  to: string;
  label: string;
}
export interface VsdxPage {
  name: string;
  nodes: VsdxNode[];
  containers: VsdxContainer[];
  edges: VsdxEdge[];
}
export interface ParsedVsdx {
  pages: VsdxPage[];
  warnings: string[];
}

// --- чтение XML ---

type X = Record<string, any>;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  removeNSPrefix: true,
  trimValues: false, // в смешанном тексте (<cp/>Название<cp/>\nКод) перевод строки отделяет отрезки
  parseTagValue: false,
  parseAttributeValue: false,
  isArray: (name) => ["Shape", "Cell", "Row", "Section", "Connect", "Page", "Master", "Relationship"].includes(name),
});

const arr = <T>(v: T | T[] | undefined): T[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
const attr = (o: X | undefined, name: string): string | undefined => (o?.[`@_${name}`] === undefined ? undefined : String(o[`@_${name}`]));

function cells(o: X | undefined): Map<string, string> {
  const m = new Map<string, string>();
  for (const c of arr<X>(o?.Cell)) {
    const n = attr(c, "N");
    const v = attr(c, "V");
    if (n && v !== undefined) m.set(n, v);
  }
  return m;
}

const numOf = (m: Map<string, string>, name: string, d = 0): number => {
  const n = Number(m.get(name));
  return Number.isFinite(n) ? n : d;
};

/** Ячейки раздела User: имя строки → значение. */
function userCells(shape: X): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of arr<X>(shape.Section)) {
    if (attr(s, "N") !== "User") continue;
    for (const r of arr<X>(s.Row)) {
      const n = attr(r, "N");
      const v = cells(r).get("Value");
      if (n && v !== undefined) out[n] = v;
    }
  }
  return out;
}

/** Текст фигуры (смешанное содержимое: отрезки текста между разметкой <cp/>, <pp/>, <tp/>). */
function textOf(shape: X): string {
  const t = shape.Text;
  if (t === undefined || t === null) return "";
  const raw = typeof t === "string" ? t : arr<string>(t["#text"]).join("");
  return clean(raw);
}

/** Текст без лишних пробелов; переводы строки внутри названия — пробелы. */
const clean = (s: string) => s.replace(/\s+/g, " ").trim();
const norm = (s: string) => clean(s).toLowerCase().replace(/ё/g, "е");

// --- геометрия ---

function boxOf(shape: X, origin: { x: number; y: number }, pageH: number): { box: VsdxBox; pin: { x: number; y: number }; origin: { x: number; y: number } } {
  const c = cells(shape);
  const w = numOf(c, "Width");
  const h = numOf(c, "Height");
  const lx = numOf(c, "LocPinX", w / 2);
  const ly = numOf(c, "LocPinY", h / 2);
  const pin = { x: origin.x + numOf(c, "PinX"), y: origin.y + numOf(c, "PinY") };
  const angle = numOf(c, "Angle");
  const [cos, sin] = [Math.cos(angle), Math.sin(angle)];
  // центр фигуры относительно точки привязки, повёрнутый вместе с фигурой
  const [dx, dy] = [w / 2 - lx, h / 2 - ly];
  const centre = { x: pin.x + dx * cos - dy * sin, y: pin.y + dx * sin + dy * cos };
  const [bw, bh] = Math.abs(sin) > 0.7 ? [h, w] : [w, h];
  return {
    box: { x: (centre.x - bw / 2) * IN, y: (pageH - (centre.y + bh / 2)) * IN, w: bw * IN, h: bh * IN },
    pin,
    origin: { x: pin.x - lx, y: pin.y - ly },
  };
}

interface Geometry {
  ellipse: boolean;
  diamond: boolean;
  /** Значок внутри шлюза собственной выгрузки (вторая секция геометрии). */
  glyph?: "exclusive" | "parallel" | "inclusive" | "event_based";
}

function geometryOf(shape: X): Geometry {
  const c = cells(shape);
  const w = numOf(c, "Width", 1);
  const h = numOf(c, "Height", 1);
  const secs = arr<X>(shape.Section).filter((s) => attr(s, "N") === "Geometry");
  const main = secs.find((s) => attr(s, "IX") === "0") ?? secs[0];
  const out: Geometry = { ellipse: false, diamond: false };
  if (main) {
    const rows = arr<X>(main.Row);
    const types = rows.map((r) => attr(r, "T"));
    out.ellipse = types.includes("Ellipse") || types.filter((t) => t === "ArcTo" || t === "EllipticalArcTo").length >= 2;
    const pts = rows
      .filter((r) => attr(r, "T") === "MoveTo" || attr(r, "T") === "LineTo")
      .map((r) => {
        const rc = cells(r);
        return [numOf(rc, "X"), numOf(rc, "Y")] as const;
      });
    const uniq = pts.filter((p, i) => pts.findIndex((q) => Math.abs(q[0] - p[0]) < 1e-4 && Math.abs(q[1] - p[1]) < 1e-4) === i);
    if (!out.ellipse && uniq.length === 4 && w > 0 && h > 0) {
      const mids = [[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]];
      out.diamond = mids.every(([mx, my]) => uniq.some(([px, py]) => Math.abs(px - mx) < w * 0.12 && Math.abs(py - my) < h * 0.12));
    }
  }
  const extra = secs.find((s) => attr(s, "IX") === "1");
  if (extra && out.diamond) {
    const rows = arr<X>(extra.Row);
    const ellipses = rows.filter((r) => attr(r, "T") === "Ellipse").length;
    if (ellipses >= 2) out.glyph = "event_based";
    else if (ellipses === 1) out.glyph = "inclusive";
    else {
      // два отрезка: оси — «плюс» (параллельный), диагонали — «крест» (исключающий)
      const segs: number[][] = [];
      let prev: number[] | null = null;
      for (const r of rows) {
        const rc = cells(r);
        const p = [numOf(rc, "X"), numOf(rc, "Y")];
        if (attr(r, "T") === "LineTo" && prev) segs.push([p[0] - prev[0], p[1] - prev[1]]);
        prev = p;
      }
      if (segs.length) out.glyph = segs.every(([sx, sy]) => Math.abs(sx) < 1e-3 || Math.abs(sy) < 1e-3) ? "parallel" : "exclusive";
    }
  }
  return out;
}

// --- вид фигуры ---

type Kind = "task" | "subprocess" | "gateway" | "event" | "lane" | "data" | "ignore";

const RE = {
  lane: /swim ?lane|\blane\b|\bpool\b|дорожк|(?<![а-я])пул(?![а-я])|cross.?functional|кросс.?функц/,
  skip: /annotation|callout|\bnote\b|\blabel\b|заметк|аннотац|подпись|заголовок|\btitle\b|phase|separator|фаза|разделител|legend|легенд|\bgroup\b|(?<![а-я])группа(?![а-я])|dynamic connector|connector|соединител|\bflow\b|поток|arrow|стрелк|sheet|лист|border|рамк/,
  data: /database|datastore|data store|data object|\bdata\b|document|документ|данн|хранилищ|база/,
  gateway: /gateway|decision|шлюз|решени|ветвлени|развилк/,
  event: /event|событ|terminator|терминатор|start\/end|начал|конец|старт|финиш|заверш/,
  subprocess: /sub.?process|call activity|predefined|подпроцесс|предопределенн/,
  task: /task|process|activity|action|задач|процесс|действи|операци|шаг|rectangle|прямоугольник|box/,
};

function classify(name: string, geo: Geometry, hasConnections: boolean, size: VsdxBox): Kind {
  if (RE.lane.test(name)) return "lane";
  if (RE.gateway.test(name) || (!name && geo.diamond)) return "gateway";
  if (RE.event.test(name)) return "event";
  if (RE.subprocess.test(name)) return "subprocess";
  if (RE.data.test(name)) return "data";
  if (RE.skip.test(name)) return "ignore";
  if (RE.task.test(name)) return "task";
  // без подсказки в имени — по форме; связанная фигура всегда шаг
  if (geo.diamond) return "gateway";
  if (geo.ellipse && size.w <= 80 && size.h <= 80) return "event";
  return hasConnections ? "task" : "ignore";
}

const TASK_SUBTYPES: [RegExp, string][] = [
  [/user ?task|пользовательск/, "user"],
  [/service ?task|сервисн/, "service"],
  [/manual ?task|ручн/, "manual"],
  [/send ?task|отправк/, "send"],
  [/receive ?task|получени/, "receive"],
  [/script ?task|скрипт/, "script"],
  [/business ?rule|бизнес.?правил/, "business_rule"],
];
const EVENT_TRIGGERS: [RegExp, TriggerType][] = [
  [/message|сообщени/, "message"],
  [/timer|таймер|время/, "timer"],
  [/signal|сигнал/, "signal"],
  [/error|ошибк/, "error"],
  [/escalation|эскалац/, "escalation"],
  [/conditional|условн/, "conditional"],
  [/terminate|терминат|завершение процесса/, "terminate"],
];

// --- разбор пакета ---

interface Shp {
  id: string;
  shape: X;
  parent: Shp | null;
  name: string; // имя мастера или фигуры, в нижнем регистре
  user: Record<string, string>;
  box: VsdxBox;
  pin: { x: number; y: number };
  isGroup: boolean;
}

export async function parseVsdx(buffer: Buffer): Promise<ParsedVsdx> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    throw new Error("Файл не открывается как .vsdx: это должен быть пакет Visio 2013 и новее. Старый формат .vsd сохраните в Visio как «Рисунок Visio (*.vsdx)».");
  }
  const read = async (name: string) => {
    const f = zip.file(name);
    return f ? await f.async("string") : null;
  };
  const pagesXml = await read("visio/pages/pages.xml");
  if (!pagesXml || !(await read("visio/document.xml"))) throw new Error("В файле нет страниц Visio (visio/pages/pages.xml) — это не .vsdx.");
  if (Object.keys(zip.files).length > 2000) throw new Error("В пакете слишком много частей — файл отклонён.");

  const warnings: string[] = [];

  // мастера: id → имя
  const masterNames = new Map<string, string>();
  const mastersXml = await read("visio/masters/masters.xml");
  if (mastersXml) {
    for (const m of arr<X>(parser.parse(mastersXml).Masters?.Master)) {
      const id = attr(m, "ID");
      const name = attr(m, "NameU") ?? attr(m, "Name");
      if (id && name) masterNames.set(id, name);
    }
  }

  // страница → часть пакета
  const relsXml = (await read("visio/pages/_rels/pages.xml.rels")) ?? "";
  const targets = new Map<string, string>();
  for (const r of arr<X>(parser.parse(relsXml).Relationships?.Relationship)) {
    const id = attr(r, "Id");
    const target = attr(r, "Target");
    if (id && target) targets.set(id, target);
  }

  const pages: VsdxPage[] = [];
  let skippedIdef0 = 0;
  const pageList = arr<X>(parser.parse(pagesXml).Pages?.Page);
  for (let pi = 0; pi < pageList.length; pi++) {
    const p = pageList[pi];
    const name = attr(p, "NameU") ?? attr(p, "Name") ?? `Страница ${pi + 1}`;
    const sheet = cells(p.PageSheet);
    const pageH = numOf(sheet, "PageHeight", 8.5);
    const pageUser = p.PageSheet ? userCells(p.PageSheet) : {};
    if ((pageUser.pm_page ?? "").startsWith("idef0")) {
      skippedIdef0++;
      continue;
    }
    const target = targets.get(attr(p.Rel, "id") ?? "") ?? `page${pi + 1}.xml`;
    const xml = await read(`visio/pages/${target.replace(/^\/?(visio\/pages\/)?/, "")}`);
    if (!xml) {
      warnings.push(`Страница «${name}» не найдена в пакете — пропущена.`);
      continue;
    }
    const page = readPage(parser.parse(xml).PageContents ?? {}, pi, name, pageH, masterNames, warnings);
    if (page.nodes.length) pages.push(page);
  }
  if (skippedIdef0) warnings.push(`Страницы IDEF0 пропущены (${skippedIdef0}): импортируются диаграммы BPMN и блок-схемы.`);
  if (pages.length === 0) warnings.push("Не найдено ни одной фигуры, похожей на шаг процесса, событие или шлюз.");
  return { pages, warnings };
}

function readPage(contents: X, pageIndex: number, pageName: string, pageH: number, masters: Map<string, string>, warnings: string[]): VsdxPage {
  // все фигуры страницы, включая вложенные в группы
  const all: Shp[] = [];
  const byId = new Map<string, Shp>();
  const walk = (shapes: X[], parent: Shp | null, origin: { x: number; y: number }) => {
    for (const shape of shapes) {
      const id = attr(shape, "ID");
      if (!id) continue;
      const b = boxOf(shape, origin, pageH);
      const master = masters.get(attr(shape, "Master") ?? "");
      const s: Shp = {
        id,
        shape,
        parent,
        name: norm(master ?? attr(shape, "NameU") ?? attr(shape, "Name") ?? ""),
        user: userCells(shape),
        box: b.box,
        pin: b.pin,
        isGroup: attr(shape, "Type") === "Group",
      };
      all.push(s);
      byId.set(id, s);
      if (shape.Shapes) walk(arr<X>(shape.Shapes.Shape), s, b.origin);
    }
  };
  walk(arr<X>(contents.Shapes?.Shape), null, { x: 0, y: 0 });
  if (all.length > 6000) warnings.push(`На странице «${pageName}» больше 6000 фигур — разобраны не все.`);

  // соединители: фигуры с началом и концом (одномерные) и всё, что упомянуто в Connect как «от»
  const connects = arr<X>(contents.Connects?.Connect);
  const glued = new Map<string, { begin?: string; end?: string }>();
  for (const c of connects) {
    const from = attr(c, "FromSheet");
    const to = attr(c, "ToSheet");
    const cell = attr(c, "FromCell");
    if (!from || !to) continue;
    const g = glued.get(from) ?? {};
    if (cell === "BeginX" || cell === "BeginY") g.begin = to;
    else if (cell === "EndX" || cell === "EndY") g.end = to;
    glued.set(from, g);
  }
  const isConnector = (s: Shp) => {
    const c = cells(s.shape);
    return (c.has("BeginX") && c.has("EndX")) || glued.has(s.id) || s.user.pm_k === "flow" || s.user.pm_k === "synthflow";
  };
  // фигуры, к которым приклеен соединитель, и их предки (приклеиваться можно к части группы)
  const connected = new Set<string>();
  for (const g of glued.values()) {
    for (const t of [g.begin, g.end]) for (let s: Shp | null | undefined = t ? byId.get(t) : undefined; s; s = s.parent) connected.add(s.id);
  }

  // ближайший предок-фигура, которая сама станет узлом, — к ней приклеиваются соединители
  const nodeKinds = new Map<string, Kind>();
  const lanes: VsdxContainer[] = [];
  const nodes: VsdxNode[] = [];
  const laneNames = new Map<string, string>(); // собственная выгрузка: id роли → название из подписи дорожки

  for (const s of all) if (s.user.pm_k === "lanelabel" && s.user.pm_id) laneNames.set(s.user.pm_id, s.user.pm_n ?? textOf(s.shape));

  const insideNode = (s: Shp) => {
    for (let p = s.parent; p; p = p.parent) if (nodeKinds.has(p.id) && nodeKinds.get(p.id) !== "lane") return true;
    return false;
  };
  const textDeep = (s: Shp): string => {
    const own = textOf(s.shape);
    if (own) return own;
    for (const sub of arr<X>(s.shape.Shapes?.Shape)) {
      const t = textDeep({ ...s, shape: sub });
      if (t) return t;
    }
    return "";
  };

  for (const s of all) {
    if (isConnector(s) || insideNode(s)) continue;
    const pk = s.user.pm_k;
    if (pk) {
      // собственная выгрузка: оформление и подписи пропускаются, шаги и дорожки — по меткам
      if (pk === "lane") {
        lanes.push({ laneId: s.user.pm_id, name: laneNames.get(s.user.pm_id ?? "") ?? "", box: s.box });
        nodeKinds.set(s.id, "lane");
        continue;
      }
      if (pk !== "node" && pk !== "synth") continue;
    }
    const geo = geometryOf(s.shape);
    let kind: Kind = pk ? (geo.diamond ? "gateway" : geo.ellipse ? "event" : "task") : classify(s.name, geo, connected.has(s.id), s.box);
    // подпроцесс собственной выгрузки отличает маркер «+» во второй секции геометрии
    if (pk && kind === "task" && arr<X>(s.shape.Section).some((x) => attr(x, "N") === "Geometry" && attr(x, "IX") === "1")) kind = "subprocess";
    if (kind === "lane") {
      lanes.push({ name: textDeep(s), box: s.box });
      nodeKinds.set(s.id, "lane");
      continue;
    }
    if (kind === "ignore" || kind === "data") continue;
    if (!s.box.w || !s.box.h) continue;
    const text = pk ? clean(s.user.pm_n ?? textDeep(s)) : textDeep(s);
    const node: VsdxNode = { key: `${pageIndex}:${s.id}`, shapeId: s.id, kind, text, box: s.box };
    if (kind === "task") {
      const sub = TASK_SUBTYPES.find(([re]) => re.test(s.name));
      if (sub) node.subtype = sub[1];
    } else if (kind === "gateway") {
      const g = geo.glyph;
      node.subtype = g ?? (/parallel|параллел|\band\b/.test(s.name) ? "parallel" : /inclusive|включающ|\bor\b/.test(s.name) ? "inclusive" : /event.?based|событийн/.test(s.name) ? "event_based" : "exclusive");
    } else if (kind === "event") {
      if (/start|начал|старт/.test(s.name) || (!s.name && /^(начало|старт|start)/.test(norm(text)))) node.subtype = "start";
      else if (/\bend\b|конец|конечн|заверш|финиш|стоп/.test(s.name) || (!s.name && /^(конец|завершени|финиш|end)/.test(norm(text)))) node.subtype = "end";
      else if (/intermediate|промежуточн/.test(s.name)) node.subtype = "intermediate";
      const trig = EVENT_TRIGGERS.find(([re]) => re.test(s.name));
      if (trig) node.trigger = { type: trig[1] };
    }
    nodes.push(node);
    nodeKinds.set(s.id, kind);
  }

  // узел, к которому относится приклеенная фигура (она сама или её предок)
  const nodeOf = (id: string | undefined): string | null => {
    for (let s: Shp | null | undefined = id ? byId.get(id) : undefined; s; s = s.parent) if (nodes.some((n) => n.shapeId === s!.id)) return s.id;
    return null;
  };
  // неприклеенный конец — ближайший узел, в габарит которого (с запасом) попадает точка
  const nodeAt = (x: number, y: number): string | null => {
    const [px, py] = [x * IN, (pageH - y) * IN];
    let best: { id: string; d: number } | null = null;
    for (const n of nodes) {
      const [cx, cy] = [n.box.x + n.box.w / 2, n.box.y + n.box.h / 2];
      const inside = px >= n.box.x - 14 && px <= n.box.x + n.box.w + 14 && py >= n.box.y - 14 && py <= n.box.y + n.box.h + 14;
      const d = Math.hypot(px - cx, py - cy);
      if (inside && (!best || d < best.d)) best = { id: n.shapeId, d };
    }
    return best?.id ?? null;
  };

  const edges: VsdxEdge[] = [];
  let loose = 0;
  for (const s of all) {
    if (!isConnector(s)) continue;
    const c = cells(s.shape);
    const g = glued.get(s.id) ?? {};
    let from = nodeOf(g.begin);
    let to = nodeOf(g.end);
    // координаты концов: у соединителей на странице — абсолютные
    if (!from && c.has("BeginX")) from = nodeAt(numOf(c, "BeginX"), numOf(c, "BeginY"));
    if (!to && c.has("EndX")) to = nodeAt(numOf(c, "EndX"), numOf(c, "EndY"));
    if (!from || !to || from === to) {
      if (c.has("BeginX") || glued.has(s.id)) loose++;
      continue;
    }
    // стрелка на начале, а не на конце — направление обратное
    if (numOf(c, "BeginArrow") > 0 && numOf(c, "EndArrow") === 0) [from, to] = [to, from];
    edges.push({ from: `${pageIndex}:${from}`, to: `${pageIndex}:${to}`, label: textOf(s.shape) });
  }
  if (loose) warnings.push(`На странице «${pageName}» ${loose} соедин. не привязаны к шагам — пропущены.`);

  return { name: pageName, nodes, containers: lanes, edges };
}

// --- модель ---

const centre = (b: VsdxBox) => [b.x + b.w / 2, b.y + b.h / 2] as const;
const area = (b: VsdxBox) => b.w * b.h;
const contains = (outer: VsdxBox, inner: VsdxBox) => inner.x >= outer.x - 1 && inner.y >= outer.y - 1 && inner.x + inner.w <= outer.x + outer.w + 1 && inner.y + inner.h <= outer.y + outer.h + 1;

/** Модель процесса из разобранного .vsdx: шаги, события, шлюзы, потоки, исполнители по дорожкам. */
export function buildModelFromParsedVsdx(parsed: ParsedVsdx, meta: SessionMeta) {
  const warnings = [...parsed.warnings];
  const roles: Role[] = [];
  const roleByName = new Map<string, Role>();
  const roleFor = (name: string): Role => {
    const k = norm(name);
    let r = roleByName.get(k);
    if (!r) {
      r = { id: `role_${nanoid(8)}`, name: clean(name), kind: "internal", source: [] };
      roleByName.set(k, r);
      roles.push(r);
    }
    return r;
  };

  const nodes: ProcessNode[] = [];
  const flows: ProcessFlow[] = [];
  const idByKey = new Map<string, string>();
  let unnamedLanes = 0;
  let unnamed = 0;

  // Страница — отдельная диаграмма. Если их несколько, каждая становится диаграммой операции (функции с названием страницы):
  // проверки потока (старт, конец, достижимость) идут по диаграммам, а слитые в одну схему страницы мешали бы друг другу.
  let operations = 0;
  for (const page of parsed.pages) {
    let scope: string | null = null;
    // у собственных выгрузок страницы называются «BPMN <код операции>» — префикс лишний
    const opName = clean(page.name.replace(/^BPMN\s+/i, "")) || page.name;
    if (parsed.pages.length > 1) {
      scope = `imp_${nanoid(8)}`;
      operations++;
      nodes.push({
        id: scope,
        type: "task",
        name: opName,
        role_id: null,
        system_ids: [],
        inputs: [],
        outputs: [],
        controls: [],
        duration: null,
        frequency: null,
        idef0_parent: null,
        status: "confirmed",
        confidence: 0.7,
        source: [{ fragment_id: "diagram_import", quote: `Страница: ${page.name}` }],
        requirement_ids: [],
        tags: ["from_diagram_import"],
        confirmed_by: [],
      });
    }
    // исполнители — только дорожки «нижнего уровня»: пул, внутри которого лежат другие дорожки, исполнителя не задаёт
    const leaves = page.containers.filter((c) => !page.containers.some((o) => o !== c && area(o.box) < area(c.box) && contains(c.box, o.box)));
    const laneRole = new Map<VsdxContainer, Role | null>();
    for (const c of leaves) {
      if (c.laneId === "__unassigned__") {
        laneRole.set(c, null);
        continue;
      }
      laneRole.set(c, roleFor(c.name || `Дорожка ${++unnamedLanes}`));
    }

    const incoming = new Set(page.edges.map((e) => e.to));
    const outgoing = new Set(page.edges.map((e) => e.from));
    // граничное событие: ничего не входит, центр лежит на краю задачи или подпроцесса
    const boundaryHost = new Map<string, string>();
    for (const ev of page.nodes) {
      if (ev.kind !== "event" || incoming.has(ev.key)) continue;
      const [ex, ey] = centre(ev.box);
      const reach = Math.max(ev.box.w, ev.box.h) / 2 + 4;
      const host = page.nodes.find((t) => {
        if (t.kind !== "task" && t.kind !== "subprocess") return false;
        const [l, r, top, bottom] = [t.box.x, t.box.x + t.box.w, t.box.y, t.box.y + t.box.h];
        if (ex < l - reach || ex > r + reach || ey < top - reach || ey > bottom + reach) return false;
        const toEdge = Math.min(Math.abs(ex - l), Math.abs(ex - r), Math.abs(ey - top), Math.abs(ey - bottom));
        return toEdge <= reach;
      });
      if (host) boundaryHost.set(ev.key, host.key);
    }
    for (const n of page.nodes) {
      const id = `imp_${nanoid(8)}`;
      idByKey.set(n.key, id);
      const [cx, cy] = centre(n.box);
      const lane = leaves
        .filter((c) => cx >= c.box.x && cx <= c.box.x + c.box.w && cy >= c.box.y && cy <= c.box.y + c.box.h)
        .sort((a, b) => area(a.box) - area(b.box))[0];
      const role = lane ? laneRole.get(lane) ?? null : null;

      let subtype = n.subtype;
      let name = n.text;
      if (n.kind === "event") {
        // вид события без явного указания — по месту в потоке
        if (!subtype) subtype = boundaryHost.has(n.key) ? "intermediate" : !incoming.has(n.key) ? "start" : !outgoing.has(n.key) ? "end" : "intermediate";
        if (boundaryHost.has(n.key) && subtype === "start") subtype = "intermediate";
        if (!name) name = subtype === "start" ? "Начало процесса" : subtype === "end" ? "Процесс завершён" : "Событие";
      }
      const named = !!name;
      if (!name) {
        name = "(без названия)";
        unnamed++;
      }
      nodes.push({
        id,
        type: n.kind,
        subtype,
        ...(n.trigger ? { trigger: n.trigger } : {}),
        name,
        role_id: n.kind === "event" || n.kind === "gateway" ? null : role?.id ?? null,
        system_ids: [],
        inputs: [],
        outputs: [],
        controls: [],
        duration: null,
        frequency: null,
        idef0_parent: null,
        bpmn_scope: scope,
        status: named || n.kind === "event" ? "confirmed" : "hypothesis",
        confidence: named ? 0.8 : n.kind === "event" ? 0.6 : 0.4,
        source: [{ fragment_id: "diagram_import", quote: `${page.name}: ${n.shapeId}` }],
        requirement_ids: [],
        tags: ["from_diagram_import"],
        confirmed_by: [],
      });
    }

    for (const [eventKey, hostKey] of boundaryHost) {
      const ev = nodes.find((n) => n.id === idByKey.get(eventKey));
      const host = idByKey.get(hostKey);
      if (ev && host) ev.attached_to = host;
    }

    const seen = new Set<string>();
    for (const e of page.edges) {
      const from = idByKey.get(e.from);
      const to = idByKey.get(e.to);
      if (!from || !to) continue;
      const k = `${from}|${to}|${e.label}`;
      if (seen.has(k)) continue;
      seen.add(k);
      flows.push({ id: `flow_${nanoid(8)}`, from, to, condition: e.label || null, source: [{ fragment_id: "diagram_import", quote: `${page.name}` }], confirmed_by: [] });
    }
  }

  if (unnamed) warnings.push(`У ${unnamed} фигур нет текста — они отмечены как гипотезы.`);
  if (operations > 0) warnings.push(`Страниц с диаграммами: ${parsed.pages.length} — каждая стала диаграммой операции (функция с названием страницы); исполнители с одинаковым названием объединены.`);
  if (nodes.length && flows.length === 0) warnings.push("Соединителей между фигурами не найдено — шаги импортированы без связей.");
  return { model: importedModel(meta, { nodes, flows, roles }), warnings };
}
