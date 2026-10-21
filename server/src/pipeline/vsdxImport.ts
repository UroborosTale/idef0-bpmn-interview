import { FRAME_GRID, FRAME_H, FRAME_MIN_H, FRAME_MIN_W, type IdefFrame } from "../shared/idef0Frame.js";
import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";
import { nanoid } from "nanoid";
import { EventTriggerSchema, type ProcessFlow, type ProcessLogicModel, type ProcessNode, type Role } from "../types/model.js";
import type { SessionMeta } from "../repo.js";
import type { EventTrigger, TriggerType } from "../shared/events.js";
import { importedModel } from "./diagramImport.js";
import { zipReader } from "../util/zipSafe.js";
import { decodeVisioBpmn, type VisioBpmnInfo, type VisioProps } from "../shared/visioBpmn.js";

/**
 * Импорт Visio (.vsdx → модель процесса, ТЗ Р10, М9.5). Файл — ZIP-пакет OPC: страницы лежат в visio/pages, имена
 * мастеров (какая фигура из какого трафарета) — в visio/masters. Разбираются:
 *  - фигуры страницы (в том числе внутри групп) → шаги, события и шлюзы; вид определяется по имени мастера
 *    («Task», «Decision», «Start Event», «Процесс»…), а для фигур без мастера — по геометрии (эллипс, ромб, прямоугольник);
 *  - соединители, приклеенные к фигурам (таблица Connect); неприклеенные концы привязываются к ближайшей фигуре;
 *  - дорожки и пулы (по имени мастера) → исполнители: шаг получает роль той дорожки, в которой лежит;
 *  - собственные выгрузки приложения (ячейки pm_*): точные виды, названия и дорожки;
 *  - фигуры трафарета BPMN из Visio: тип задачи, шлюза, вид и триггер события, тип потока берутся из ячеек раздела
 *    Property (Bpmn*), а не из имени мастера (shared/visioBpmn.ts); свойства мастера подмешиваются под свойства фигуры.
 * Порядок определения вида: метки pm_* → свойства Bpmn* → имя мастера → геометрия.
 * Страницы IDEF0 пропускаются. Всё распознанное — черновик (гипотезы, где у фигуры нет текста): аналитик проверяет модель.
 */

const IN = 96; // дюйм Visio → пиксели
/** Имена, которые Visio даёт фигурам сам: «Sheet.5», «Shape3», «Лист.7», «Фигура.2». */
const AUTO_NAME = /^(sheet|shape|лист|фигура|форма)[.\s]*\d*$/;
const MAX_PAGES = 100;
const MAX_SHAPES = 6000; // на странице
const MAX_MASTERS = 200;

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
  /** Цикличность задачи или подпроцесса (BpmnLoopType). */
  loop?: "standard" | "parallel" | "sequential";
  /** Граничное событие, которое не прерывает задачу («Промежуточное (без прерывания)» в Visio). */
  nonInterrupting?: boolean;
  text: string;
  box: VsdxBox;
  /** id шага модели у собственной выгрузки (метка pm_id): по нему правки из Visio возвращаются в существующую модель. */
  pmId?: string;
  /** Фигура-заглушка собственной выгрузки (метка pm_k = synth): синтетические «Начало процесса» / «Завершение процесса»,
   *  которых в модели нет (bpmn.ts). Шагом из заглушки не делаем, иначе приём правок создал бы события из ничего. */
  synth?: boolean;
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
  /** Ветка «по умолчанию» (свойство BpmnConditionType). */
  isDefault?: boolean;
  /** id потока модели у собственной выгрузки (метка pm_id). */
  pmId?: string;
  /** id соединителя в Visio (по нему оболочка помечает новую стрелку id потока модели). */
  shapeId?: string;
  /** Начало и конец соединителя в координатах страницы (px, y вниз): по ним для IDEF0 определяется сторона блока. */
  begin?: [number, number];
  end?: [number, number];
}
export interface VsdxPage {
  name: string;
  /** Операция, диаграмму которой изображает страница собственной выгрузки (метка pm_scope); у общей схемы и чужих файлов не задана. */
  scope?: string;
  /** Страница нарисована нашим экспортом (метка pm_page = bpmn). */
  own?: boolean;
  /** Шаги и потоки, нарисованные при выгрузке (метка pm_manifest): по ним видно, что удалили в Visio. */
  manifest?: { nodes: string[]; flows: string[] };
  nodes: VsdxNode[];
  containers: VsdxContainer[];
  edges: VsdxEdge[];
  /** Рамка листа этой страницы (метка pm_k = sheet), если она есть. */
  sheet?: VsdxSheet;
  /** Соединители с одним неприклеенным концом (у страниц IDEF0): выход блока в пустое место или вход «снаружи». */
  loose?: VsdxEdge[];
  /** Блоки и стрелки IDEF0 с метками (для страниц IDEF0 собственной выгрузки). */
  idef0Marks?: VsdxIdef0Mark[];
}
/** Рамка листа на странице нашей выгрузки: что нарисовано при выгрузке (orig) и что стало в Visio (now), px, y вниз. */
export interface VsdxSheet {
  kind: "idef0" | "bpmn";
  key: string;
  orig: [number, number, number, number];
  now: { x: number; y: number; w: number; h: number };
}
/** Фигура страницы IDEF0 нашей выгрузки: блок функции (k = fn) или стрелка (k = arrow) с текущим текстом из Visio. */
export interface VsdxIdef0Mark {
  k: "fn" | "arrow";
  id: string;
  /** Код блока (для fn) — он стоит перед названием в тексте фигуры. */
  code?: string;
  /** Название при выгрузке. */
  was: string;
  /** Связь стрелки «вид|функция|сущность» (для arrow). */
  link?: string;
  text: string;
  shapeId: string;
  /** Положение фигуры (px, y вниз): по нему видно, к какой стороне блока приклеена новая стрелка. */
  box?: VsdxBox;
}
export interface VsdxIdef0Page {
  name: string;
  /** Код диаграммы из метки pm_page («idef0:A0» → «A0»). */
  code?: string;
  /** Функция, чью декомпозицию изображает страница (метка pm_parent); у верхней диаграммы не задана. */
  parent?: string;
  /** Контекстная диаграмма (метка pm_ctx): один блок процесса, новые блоки туда не рисуют. */
  context?: boolean;
  /** Страница выгружена как «только чтение» (метка pm_ro): правки из неё не принимаются. */
  readOnly?: boolean;
  marks: VsdxIdef0Mark[];
  /** Фигуры без меток модели, нарисованные в Visio: новые блоки функций. */
  nodes?: VsdxNode[];
  /** Соединители без меток модели: новые стрелки ICOM. */
  edges?: VsdxEdge[];
  /** Стрелки с одним неприклеенным концом: выход блока в пустое место или вход «снаружи». */
  loose?: VsdxEdge[];
  /** Что нарисовано при выгрузке (pm_manifest): функции и стрелки; нужны, чтобы увидеть удалённое. */
  manifest?: { fn: string[]; ar: string[] };
}
export interface ParsedVsdx {
  pages: VsdxPage[];
  /** Страницы IDEF0 собственной выгрузки: правки названий блоков и стрелок. */
  idef0: VsdxIdef0Page[];
  /** Листы со всех страниц, в том числе IDEF0 (их фигуры пока не читаются, а размер листа — да). */
  sheets: VsdxSheet[];
  /** Код процесса из метки pm_process_code (собственная выгрузка; F3). */
  processCode?: string;
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

/** Ячейки раздела Property: имя строки → значение и список допустимых значений (Format). */
function propCells(shape: X): VisioProps {
  const out: VisioProps = {};
  for (const s of arr<X>(shape.Section)) {
    if (attr(s, "N") !== "Property") continue;
    for (const r of arr<X>(s.Row)) {
      const n = attr(r, "N");
      if (!n) continue;
      const c = cells(r);
      const value = c.get("Value");
      if (value === undefined && !c.has("Format")) continue;
      out[n] = { ...(value !== undefined ? { value } : {}), ...(c.has("Format") ? { format: c.get("Format") } : {}) };
    }
  }
  return out;
}

/** Свойства экземпляра поверх свойств мастера — по ячейкам: строка экземпляра без значения оставляет значение мастера. */
function mergeProps(master: VisioProps | undefined, own: VisioProps): VisioProps {
  const out: VisioProps = { ...master };
  for (const [k, v] of Object.entries(own)) out[k] = { ...out[k], ...v };
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

/** Размеры, которые экземпляр наследует от мастера, пока не изменён вручную. */
const INHERITED_SIZE = ["Width", "Height", "LocPinX", "LocPinY"];

function boxOf(shape: X, origin: { x: number; y: number }, pageH: number, master?: Map<string, string>): { box: VsdxBox; pin: { x: number; y: number }; origin: { x: number; y: number } } {
  const c = cells(shape);
  if (master) for (const k of INHERITED_SIZE) if (!c.has(k) && master.has(k)) c.set(k, master.get(k)!);
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
  glyph?: "exclusive" | "parallel" | "inclusive" | "event_based" | "event_based_start" | "parallel_event_based" | "complex";
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
  [/parallel.?multiple|параллельн\S* множественн/, "parallel_multiple"],
  [/multiple|множественн/, "multiple"],
  [/compensation|компенсац/, "compensation"],
  [/link|ссылк/, "link"],
];

/** Триггер из метки pm_trg собственной выгрузки; испорченная метка не ошибка. */
function savedTrigger(raw: string | undefined): EventTrigger | undefined {
  if (!raw) return undefined;
  try {
    const r = EventTriggerSchema.safeParse(JSON.parse(raw));
    return r.success ? (r.data as EventTrigger) : undefined;
  } catch {
    return undefined;
  }
}

// --- разбор пакета ---

interface Shp {
  id: string;
  shape: X;
  parent: Shp | null;
  name: string; // имя мастера или фигуры, в нижнем регистре
  user: Record<string, string>;
  /** Свойства BPMN фигуры (раздел Property) поверх свойств её мастера, уже разобранные. */
  bpmn: VisioBpmnInfo;
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
  const read = zipReader(zip);
  const pagesXml = await read("visio/pages/pages.xml");
  if (!pagesXml || !(await read("visio/document.xml"))) throw new Error("В файле нет страниц Visio (visio/pages/pages.xml) — это не .vsdx.");
  if (Object.keys(zip.files).length > 2000) throw new Error("В пакете слишком много частей — файл отклонён.");

  const warnings: string[] = [];

  // мастера: id → имя
  const masterNames = new Map<string, string>();
  const masterProps = new Map<string, VisioProps>(); // id мастера → его свойства (значения по умолчанию для фигур-экземпляров)
  const masterSize = new Map<string, Map<string, string>>(); // id мастера → размер фигуры по умолчанию
  const mastersXml = await read("visio/masters/masters.xml");
  if (mastersXml) {
    const mrelsXml = (await read("visio/masters/_rels/masters.xml.rels")) ?? "";
    const mtargets = new Map<string, string>();
    for (const r of arr<X>(parser.parse(mrelsXml).Relationships?.Relationship)) {
      const id = attr(r, "Id");
      const target = attr(r, "Target");
      if (id && target) mtargets.set(id, target);
    }
    const masterList = arr<X>(parser.parse(mastersXml).Masters?.Master);
    for (let i = 0; i < masterList.length; i++) {
      const m = masterList[i];
      const id = attr(m, "ID");
      const name = attr(m, "NameU") ?? attr(m, "Name");
      if (id && name) masterNames.set(id, name);
      if (!id || i >= MAX_MASTERS) continue;
      const part = mtargets.get(attr(m.Rel, "id") ?? "");
      const mxml = part ? await read(`visio/masters/${part.replace(/^\/?(visio\/masters\/)?/, "")}`) : undefined;
      if (!mxml) continue;
      const top = arr<X>(parser.parse(mxml).MasterContents?.Shapes?.Shape)[0];
      const props = top ? propCells(top) : {};
      if (Object.keys(props).length) masterProps.set(id, props);
      if (top) {
        const tc = cells(top);
        const size = new Map(INHERITED_SIZE.filter((k) => tc.has(k)).map((k) => [k, tc.get(k)!] as const));
        if (size.size) masterSize.set(id, size);
      }
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
  const sheets: VsdxSheet[] = [];
  const idef0: VsdxIdef0Page[] = [];
  let skippedIdef0 = 0;
  let processCode: string | undefined;
  const pageList = arr<X>(parser.parse(pagesXml).Pages?.Page);
  if (pageList.length > MAX_PAGES) warnings.push(`В файле ${pageList.length} страниц — прочитаны первые ${MAX_PAGES}.`);
  for (let pi = 0; pi < Math.min(pageList.length, MAX_PAGES); pi++) {
    const p = pageList[pi];
    const name = attr(p, "NameU") ?? attr(p, "Name") ?? `Страница ${pi + 1}`;
    const sheet = cells(p.PageSheet);
    const pageH = numOf(sheet, "PageHeight", 8.5);
    const pageUser = p.PageSheet ? userCells(p.PageSheet) : {};
    if (pageUser.pm_process_code) processCode ??= pageUser.pm_process_code;
    const isIdef0 = (pageUser.pm_page ?? "").startsWith("idef0");
    if (isIdef0) skippedIdef0++;
    const target = targets.get(attr(p.Rel, "id") ?? "") ?? `page${pi + 1}.xml`;
    const xml = await read(`visio/pages/${target.replace(/^\/?(visio\/pages\/)?/, "")}`);
    if (!xml) {
      warnings.push(`Страница «${name}» не найдена в пакете — пропущена.`);
      continue;
    }
    const page = readPage(parser.parse(xml).PageContents ?? {}, pi, name, pageH, masterNames, { props: masterProps, size: masterSize }, warnings, isIdef0);
    if (page.sheet) sheets.push(page.sheet);
    if (isIdef0) {
      let manifest: VsdxIdef0Page["manifest"];
      try {
        const m = JSON.parse(pageUser.pm_manifest ?? "null") as { fn?: string[]; ar?: string[] } | null;
        if (m) manifest = { fn: m.fn ?? [], ar: m.ar ?? [] };
      } catch {
        /* повреждённая метка — как будто её нет */
      }
      idef0.push({
        name,
        ...(pageUser.pm_page && pageUser.pm_page !== "idef0" ? { code: String(pageUser.pm_page).replace(/^idef0:?/, "") } : {}),
        ...(pageUser.pm_parent ? { parent: pageUser.pm_parent } : {}),
        ...(pageUser.pm_ctx === "1" ? { context: true } : {}),
        ...(pageUser.pm_ro === "1" ? { readOnly: true } : {}),
        marks: page.idef0Marks ?? [],
        ...(page.nodes.length ? { nodes: page.nodes } : {}),
        ...(page.edges.length ? { edges: page.edges } : {}),
        ...(page.loose?.length ? { loose: page.loose } : {}),
        ...(manifest ? { manifest } : {}),
      });
      continue;
    }
    if (pageUser.pm_page === "bpmn") {
      page.own = true;
      if (pageUser.pm_scope) page.scope = pageUser.pm_scope;
      try {
        const m = JSON.parse(pageUser.pm_manifest ?? "null") as { n?: string[]; f?: string[] } | null;
        if (m) page.manifest = { nodes: m.n ?? [], flows: m.f ?? [] };
      } catch {
        /* повреждённая метка — как будто её нет */
      }
    }
    if (page.nodes.length) pages.push(page);
  }
  if (skippedIdef0) {
    const own = pages.some((p) => p.own) || idef0.some((p) => p.marks.length > 0);
    warnings.push(
      own
        ? `Страницы IDEF0 восстановлены по меткам модели (${skippedIdef0}).`
        : `Страницы IDEF0 пропущены (${skippedIdef0}): импортируются диаграммы BPMN и блок-схемы.`
    );
  }
  if (pages.length === 0) warnings.push("Не найдено ни одной фигуры, похожей на шаг процесса, событие или шлюз.");
  return { pages, sheets, idef0, ...(processCode ? { processCode } : {}), warnings };
}

function readPage(contents: X, pageIndex: number, pageName: string, pageH: number, masters: Map<string, string>, masterInfo: { props: Map<string, VisioProps>; size: Map<string, Map<string, string>> }, warnings: string[], idef0 = false): VsdxPage {
  // все фигуры страницы, включая вложенные в группы
  const all: Shp[] = [];
  let truncated = false;
  const byId = new Map<string, Shp>();
  const walk = (shapes: X[], parent: Shp | null, origin: { x: number; y: number }) => {
    for (const shape of shapes) {
      if (all.length >= MAX_SHAPES) {
        truncated = true;
        return;
      }
      const id = attr(shape, "ID");
      if (!id) continue;
      const masterId = attr(shape, "Master") ?? "";
      const b = boxOf(shape, origin, pageH, masterInfo.size.get(masterId));
      const master = masters.get(masterId);
      const s: Shp = {
        id,
        shape,
        parent,
        // фигура без мастера получает от Visio служебное имя «Sheet.5» — это не подсказка о виде, поэтому считается безымянной
        name: master ? norm(master) : AUTO_NAME.test(norm(attr(shape, "NameU") ?? attr(shape, "Name") ?? "")) ? "" : norm(attr(shape, "NameU") ?? attr(shape, "Name") ?? ""),
        user: userCells(shape),
        bpmn: decodeVisioBpmn(mergeProps(masterInfo.props.get(masterId), propCells(shape))),
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
  if (truncated) warnings.push(`На странице «${pageName}» больше ${MAX_SHAPES} фигур — прочитаны первые ${MAX_SHAPES}.`);

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
    return (c.has("BeginX") && c.has("EndX")) || glued.has(s.id) || s.user.pm_k === "flow" || s.user.pm_k === "synthflow" || s.bpmn.kind === "flow";
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
  const lost: string[] = []; // свойства Visio, которым нет места в модели (или не опознанные значения)
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
    const vb = s.bpmn;
    // у собственной выгрузки вид задаёт метка pm_* (pm_t — точный вид), а подтип, триггер и признаки — свойства
    // фигуры (их правят в «Данных фигуры» Visio)
    const savedKind = pk === "node" && ["task", "subprocess", "gateway", "event"].includes(s.user.pm_t ?? "") ? (s.user.pm_t as Kind) : undefined;
    const byProps: Kind | undefined = pk ? undefined : vb.kind === "pool" ? "lane" : vb.kind === "flow" ? "ignore" : vb.kind;
    let kind: Kind =
      savedKind ??
      (pk
        ? geo.diamond
          ? "gateway"
          : geo.ellipse
            ? "event"
            : "task"
        : // на странице IDEF0 блок функции — это прямоугольник с названием, и стрелки к нему могут быть ещё не проведены
          // (на BPMN без связей фигура считается примечанием и пропускается — там правило остаётся прежним)
          (byProps ?? (idef0 && !geo.diamond && !geo.ellipse ? "task" : classify(s.name, geo, connected.has(s.id), s.box))));
    // старые выгрузки без pm_t: подпроцесс отличает маркер «+» во второй секции геометрии
    if (!savedKind && pk && kind === "task" && arr<X>(s.shape.Section).some((x) => attr(x, "N") === "Geometry" && attr(x, "IX") === "1")) kind = "subprocess";
    if (kind === "lane") {
      lanes.push({ name: textDeep(s), box: s.box });
      nodeKinds.set(s.id, "lane");
      continue;
    }
    if (kind === "ignore" || kind === "data") continue;
    if (!s.box.w || !s.box.h) continue;
    // у собственной выгрузки название — текущий текст фигуры (его правят в Visio); метка pm_n — запасное, если текст стёрт
    const text = pk ? clean(textDeep(s) || (s.user.pm_n ?? "")) : textDeep(s);
    const node: VsdxNode = { key: `${pageIndex}:${s.id}`, shapeId: s.id, kind, text, box: s.box, ...(pk === "node" && s.user.pm_id ? { pmId: s.user.pm_id } : {}), ...(pk === "synth" ? { synth: true } : {}) };
    if (vb) lost.push(...vb.lost);
    if (kind === "task" || kind === "subprocess") {
      const sub = vb?.taskType ?? TASK_SUBTYPES.find(([re]) => re.test(s.name))?.[1];
      if (sub) node.subtype = sub;
      if (vb?.loop) node.loop = vb.loop;
    } else if (kind === "gateway") {
      const g = geo.glyph;
      node.subtype = vb?.gateway ?? g ?? (/комплексн|complex/.test(s.name) ? "complex" : /параллельн.*событ|parallel.*event/.test(s.name) ? "parallel_event_based" : /событ.*запуск|event.*start|создание нового экземпляра/.test(s.name) ? "event_based_start" : /parallel|параллел|\band\b|«и»/.test(s.name) ? "parallel" : /inclusive|включающ|\bor\b/.test(s.name) ? "inclusive" : /event.?based|событийн/.test(s.name) ? "event_based" : "exclusive");
    } else if (kind === "event") {
      if (vb?.position) node.subtype = vb.position;
      else if (/start|начал|старт/.test(s.name) || (!s.name && /^(начало|старт|start)/.test(norm(text)))) node.subtype = "start";
      else if (/\bend\b|конец|конечн|заверш|финиш|стоп/.test(s.name) || (!s.name && /^(конец|завершени|финиш|end)/.test(norm(text)))) node.subtype = "end";
      else if (/intermediate|промежуточн/.test(s.name)) node.subtype = "intermediate";
      const trig = EVENT_TRIGGERS.find(([re]) => re.test(s.name));
      // собственная выгрузка хранит параметры триггера в метке pm_trg; правка типа в «Данных фигуры» Visio сильнее метки
      const saved = pk ? savedTrigger(s.user.pm_trg) : undefined;
      if (saved && (vb.trigger === saved.type || !vb.position)) node.trigger = saved;
      else if (vb?.trigger) node.trigger = { type: vb.trigger, ...(vb.throwing && node.subtype === "intermediate" ? { direction: "throw" as const } : {}) };
      else if (trig) node.trigger = { type: trig[1] };
      if (vb?.nonInterrupting && vb.position === "intermediate") node.nonInterrupting = true;
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
  // стрелки IDEF0 с одним неприклеенным концом: «блок → пустое место» — это выход, «пустое место → блок» — вход
  const idef0Loose: VsdxEdge[] = [];
  const skippedFlows = { association: 0, message: 0 };
  for (const s of all) {
    if (!isConnector(s)) continue;
    // стрелки IDEF0 нашей выгрузки уже привязаны к сущностям модели (метка pm_k = arrow): их читает разбор IDEF0-меток,
    // иначе следующий приём правок создал бы по ним новые сущности
    if (idef0 && s.user.pm_k === "arrow") continue;
    const ft = s.bpmn.flowType;
    if (ft === "association" || ft === "message") {
      skippedFlows[ft]++;
      continue;
    }
    const c = cells(s.shape);
    // координаты концов: у соединителей на странице — абсолютные (в px, y вниз)
    const ends: { begin?: [number, number]; end?: [number, number] } = {
      ...(c.has("BeginX") && c.has("BeginY") ? { begin: [numOf(c, "BeginX") * IN, pageH * IN - numOf(c, "BeginY") * IN] as [number, number] } : {}),
      ...(c.has("EndX") && c.has("EndY") ? { end: [numOf(c, "EndX") * IN, pageH * IN - numOf(c, "EndY") * IN] as [number, number] } : {}),
    };
    const g = glued.get(s.id) ?? {};
    let from = nodeOf(g.begin);
    let to = nodeOf(g.end);
    // координаты концов: у соединителей на странице — абсолютные
    if (!from && c.has("BeginX")) from = nodeAt(numOf(c, "BeginX"), numOf(c, "BeginY"));
    if (!to && c.has("EndX")) to = nodeAt(numOf(c, "EndX"), numOf(c, "EndY"));
    if (!from || !to || from === to) {
      if (c.has("BeginX") || glued.has(s.id)) loose++;
      // у страниц IDEF0 берём и такие стрелки: один конец у блока, второй — в пустом месте (выход блока или вход «снаружи»)
      if (idef0 && from !== to && (from || to)) idef0Loose.push({ from: from ? `${pageIndex}:${from}` : "", to: to ? `${pageIndex}:${to}` : "", label: textOf(s.shape), shapeId: s.id, ...ends });
      continue;
    }
    // стрелка на начале, а не на конце — направление обратное
    if (numOf(c, "BeginArrow") > 0 && numOf(c, "EndArrow") === 0) [from, to] = [to, from];
    edges.push({ from: `${pageIndex}:${from}`, to: `${pageIndex}:${to}`, label: textOf(s.shape), shapeId: s.id, ...(s.bpmn.condition === "default" ? { isDefault: true } : {}), ...(s.user.pm_k === "flow" && s.user.pm_id ? { pmId: s.user.pm_id } : {}), ...ends });
  }
  if (loose) warnings.push(`На странице «${pageName}» ${loose} соедин. не привязаны к шагам — пропущены.`);
  if (skippedFlows.association) warnings.push(`На странице «${pageName}» ассоциации (${skippedFlows.association}) пропущены: они связывают шаги с примечаниями и данными, а не задают порядок.`);
  if (skippedFlows.message) warnings.push(`На странице «${pageName}» потоки сообщений (${skippedFlows.message}) пропущены: импорт пулов-участников не поддерживается, потоки добавьте в редакторе.`);
  if (lost.length) {
    const counts = new Map<string, number>();
    for (const l of lost) counts.set(l, (counts.get(l) ?? 0) + 1);
    warnings.push(`На странице «${pageName}» не перенесено в модель: ${[...counts].map(([k, n]) => (n > 1 ? `${k} (${n})` : k)).join(", ")}.`);
  }

  // рамка листа собственной выгрузки: её размер мог измениться в Visio
  let sheet: VsdxSheet | undefined;
  const sh = all.find((s) => s.user.pm_k === "sheet");
  if (sh) {
    const orig = (sh.user.pm_sr ?? "").split(",").map(Number);
    if (orig.length === 4 && orig.every(Number.isFinite) && (sh.user.pm_fd === "idef0" || sh.user.pm_fd === "bpmn")) {
      sheet = { kind: sh.user.pm_fd, key: sh.user.pm_fk ?? "", orig: orig as [number, number, number, number], now: { x: sh.box.x, y: sh.box.y, w: sh.box.w, h: sh.box.h } };
    }
  }
  const idef0Marks: VsdxIdef0Mark[] = [];
  for (const s of all) {
    const k = s.user.pm_k;
    if ((k !== "fn" && k !== "arrow") || !s.user.pm_id) continue;
    idef0Marks.push({ k, id: s.user.pm_id, ...(s.user.pm_c ? { code: s.user.pm_c } : {}), was: s.user.pm_n ?? "", ...(s.user.pm_a ? { link: s.user.pm_a } : {}), text: textDeep(s), shapeId: s.id, box: s.box });
  }
  return { name: pageName, nodes, containers: lanes, edges, ...(idef0Loose.length ? { loose: idef0Loose } : {}), ...(sheet ? { sheet } : {}), ...(idef0Marks.length ? { idef0Marks } : {}) };
}

// --- модель ---

const centre = (b: VsdxBox) => [b.x + b.w / 2, b.y + b.h / 2] as const;
const area = (b: VsdxBox) => b.w * b.h;
const contains = (outer: VsdxBox, inner: VsdxBox) => inner.x >= outer.x - 1 && inner.y >= outer.y - 1 && inner.x + inner.w <= outer.x + outer.w + 1 && inner.y + inner.h <= outer.y + outer.h + 1;

/**
 * A7: модель из собственной выгрузки Visio. Названия и иерархия функций — из меток pm_* страниц IDEF0,
 * шаги, дорожки, события и потоки — из страниц BPMN. Страница «BPMN» без pm_scope — общая схема, функцией не становится.
 */
function buildModelFromOwnVsdx(parsed: ParsedVsdx, meta: SessionMeta): { model: ProcessLogicModel; warnings: string[] } {
  const warnings = [...parsed.warnings];
  const nodes: ProcessNode[] = [];
  const byId = new Map<string, ProcessNode>();
  const roles: Role[] = [];
  const roleById = new Map<string, Role>();
  const ensure = (id: string, kind: ProcessNode["type"], name: string): ProcessNode => {
    let n = byId.get(id);
    if (!n) {
      n = {
        id,
        type: kind,
        name,
        role_id: null,
        system_ids: [],
        inputs: [],
        outputs: [],
        controls: [],
        duration: null,
        frequency: null,
        idef0_parent: null,
        bpmn_scope: null,
        status: "confirmed",
        confidence: 0.8,
        source: [{ fragment_id: "diagram_import", quote: "Visio: метки pm_*" }],
        requirement_ids: [],
        tags: ["from_diagram_import"],
        confirmed_by: [],
      };
      byId.set(id, n);
      nodes.push(n);
    }
    return n;
  };
  const roleFor = (id: string, name: string): Role => {
    let role = roleById.get(id);
    if (!role) {
      role = { id, name: clean(name) || `Дорожка ${roleById.size + 1}`, kind: "internal", source: [] };
      roleById.set(id, role);
      roles.push(role);
    }
    return role;
  };

  // функции IDEF0: название — текст блока без кода, родитель — функция, чья это декомпозиция
  for (const page of parsed.idef0) {
    if (page.context) continue; // A-0 изображает сам процесс, а не функцию
    for (const mark of page.marks) {
      if (mark.k !== "fn" || mark.id === "__context__") continue;
      const visible = mark.text.replace(/^\S+\s+/, "").trim();
      const name = visible || mark.was.trim() || "(без названия)";
      const n = ensure(mark.id, "task", name);
      n.name = name;
      n.idef0_parent = page.parent ?? null;
    }
  }


  const leavesOf = (page: VsdxPage) =>
    page.containers.filter((c) => !page.containers.some((o) => o !== c && area(o.box) < area(c.box) && contains(c.box, o.box)));
  const idByKey = new Map<string, string>();
  for (const page of parsed.pages) {
    for (const c of leavesOf(page)) if (c.laneId && c.laneId !== "__unassigned__") roleFor(c.laneId, c.name);
    for (const n of page.nodes) if (!n.synth && n.pmId) idByKey.set(n.key, n.pmId);
  }

  const flows: ProcessFlow[] = [];
  const flowById = new Map<string, ProcessFlow>();
  for (const page of parsed.pages) {
    const leaves = leavesOf(page);
    const incoming = new Set(page.edges.map((e) => e.to));
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
        return Math.min(Math.abs(ex - l), Math.abs(ex - r), Math.abs(ey - top), Math.abs(ey - bottom)) <= reach;
      });
      if (host) boundaryHost.set(ev.key, host.key);
    }

    for (const n of page.nodes) {
      if (n.synth || !n.pmId) continue;
      const node = ensure(n.pmId, n.kind, n.text || "(без названия)");
      if (n.text) node.name = n.text;
      node.type = n.kind;
      if (n.subtype) node.subtype = n.subtype;
      if (n.trigger) node.trigger = n.trigger;
      if (n.loop) node.loop = n.loop;
      if (page.scope) node.bpmn_scope = page.scope;
      if (n.kind === "task" || n.kind === "subprocess") {
        const [cx, cy] = centre(n.box);
        const lane = leaves.find((c) => cx >= c.box.x && cx <= c.box.x + c.box.w && cy >= c.box.y && cy <= c.box.y + c.box.h);
        if (lane) node.role_id = lane.laneId && lane.laneId !== "__unassigned__" ? roleFor(lane.laneId, lane.name).id : null;
      }
    }
    for (const [eventKey, hostKey] of boundaryHost) {
      const ev = byId.get(idByKey.get(eventKey) ?? "");
      const host = byId.get(idByKey.get(hostKey) ?? "");
      if (ev && host) {
        ev.attached_to = host.id;
        if (page.nodes.find((n) => n.key === eventKey)?.nonInterrupting) ev.interrupting = false;
      }
    }
    for (const e of page.edges) {
      const from = idByKey.get(e.from);
      const to = idByKey.get(e.to);
      if (!from || !to) continue;
      const id = e.pmId ?? `flow_${nanoid(8)}`;
      // производные связи общей схемы (DerivedFlow_N) нарисованы для читаемости и в модель не возвращаются
      if (id.startsWith("DerivedFlow_") || flowById.has(id)) continue;
      const flow: ProcessFlow = {
        id,
        from,
        to,
        condition: e.label || null,
        ...(e.isDefault ? { is_default: true } : {}),
        source: [{ fragment_id: "diagram_import", quote: `Visio: ${page.name}` }],
        confirmed_by: [],
      };
      flowById.set(id, flow);
      flows.push(flow);
    }
  }

  // у операции, которая не нарисована на дорожке, исполнитель берётся из её шагов (как в автопостроении RACI)
  for (const n of nodes) {
    if (n.role_id || (n.type !== "task" && n.type !== "subprocess")) continue;
    const counts = new Map<string, number>();
    for (const c of nodes) if (c.role_id && c.bpmn_scope === n.id) counts.set(c.role_id, (counts.get(c.role_id) ?? 0) + 1);
    const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (best) n.role_id = best[0];
  }

  const model = importedModel(meta.code ? meta : { ...meta, ...(parsed.processCode ? { code: parsed.processCode } : {}) }, { nodes, flows, roles });
  warnings.push(`Модель восстановлена из выгрузки Visio: функций и шагов — ${nodes.length}, потоков — ${flows.length}, дорожек — ${roles.length}.`);
  return { model, warnings };
}


/** Модель процесса из разобранного .vsdx: шаги, события, шлюзы, потоки, исполнители по дорожкам. */
export function buildModelFromParsedVsdx(parsed: ParsedVsdx, meta: SessionMeta) {
  // A7: собственная выгрузка несёт метки pm_* — по ним модель восстанавливается целиком (имена, иерархия,
  // шаги, дорожки и потоки), а не превращается в набор функций по названиям страниц.
  if (parsed.pages.some((p) => p.own) || parsed.idef0.some((p) => p.marks.length > 0)) return buildModelFromOwnVsdx(parsed, meta);
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
        ...(n.loop ? { loop: n.loop } : {}),
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
      if (ev && host) {
        ev.attached_to = host;
        if (page.nodes.find((n) => n.key === eventKey)?.nonInterrupting) ev.interrupting = false;
      }
    }

    const seen = new Set<string>();
    for (const e of page.edges) {
      const from = idByKey.get(e.from);
      const to = idByKey.get(e.to);
      if (!from || !to) continue;
      const k = `${from}|${to}|${e.label}`;
      if (seen.has(k)) continue;
      seen.add(k);
      flows.push({ id: `flow_${nanoid(8)}`, from, to, condition: e.label || null, ...(e.isDefault ? { is_default: true } : {}), source: [{ fragment_id: "diagram_import", quote: `${page.name}` }], confirmed_by: [] });
    }
  }

  if (unnamed) warnings.push(`У ${unnamed} фигур нет текста — они отмечены как гипотезы.`);
  if (operations > 0) warnings.push(`Страниц с диаграммами: ${parsed.pages.length} — каждая стала диаграммой операции (функция с названием страницы); исполнители с одинаковым названием объединены.`);
  if (nodes.length && flows.length === 0) warnings.push("Соединителей между фигурами не найдено — шаги импортированы без связей.");
  return { model: importedModel(meta, { nodes, flows, roles }), warnings };
}

// --- правки из Visio в существующую модель ---

export interface VsdxReconcileChanges {
  renamed: { nodeId: string; from: string; to: string }[];
  /** Новые шаги, нарисованные в Visio, и новые стрелки между шагами. */
  added: string[];
  addedFlows: string[];
  /** Условия стрелок, изменённые в Visio. */
  flowsRenamed: { flowId: string; from: string; to: string }[];
  /** Нарисованное при выгрузке, но не найденное в файле (удалено в Visio): модель не меняется, аналитик решает сам. */
  missing: string[];
  missingFlows: string[];
  /** Какая новая фигура Visio стала каким шагом (и какое новое соединение — каким потоком): по этим парам оболочка ставит на фигуры метки pm_id, иначе при следующем приёме правок они создались бы заново. */
  shapeMap: { page: string; shapeId: string; nodeId: string }[];
  flowMap: { page: string; shapeId: string; flowId: string }[];
}

/**
 * Применяет правки, сделанные в Visio, к существующей модели (файл — собственная выгрузка, фигуры опознаются по меткам pm_id):
 * переименованные шаги и условия стрелок, новые шаги (на странице своей операции, исполнитель — по дорожке) и стрелки.
 * Удалённые в Visio шаги и стрелки только перечисляются — как и при правках из .bpmn. Страницы чужих файлов не читаются.
 */
export function reconcileVsdxEdit(model: ProcessLogicModel, parsed: ParsedVsdx): { model: ProcessLogicModel; changes: VsdxReconcileChanges } {
  const out: ProcessLogicModel = JSON.parse(JSON.stringify(model));
  const changes: VsdxReconcileChanges = { renamed: [], added: [], addedFlows: [], flowsRenamed: [], missing: [], missingFlows: [], shapeMap: [], flowMap: [] };
  const nodeById = new Map(out.nodes.map((n) => [n.id, n] as const));
  const flowById = new Map(out.flows.map((f) => [f.id, f] as const));
  const seenNodes = new Set<string>();
  const seenFlows = new Set<string>();
  const flowKeys = new Set(out.flows.map((f) => `${f.from}|${f.to}`));
  const tag = (n: ProcessNode, t: string) => {
    if (!n.tags.includes(t)) n.tags = [...n.tags, t];
  };

  for (const page of parsed.pages.filter((p) => p.own)) {
    const idByKey = new Map<string, string>();
    const leaves = page.containers.filter((c) => c.laneId && !page.containers.some((o) => o !== c && area(o.box) < area(c.box) && contains(c.box, o.box)));
    for (const n of page.nodes) {
      const known = n.pmId ? nodeById.get(n.pmId) : undefined;
      if (known) {
        seenNodes.add(known.id);
        idByKey.set(n.key, known.id);
        if (n.text && n.text !== known.name) {
          changes.renamed.push({ nodeId: known.id, from: known.name, to: n.text });
          known.name = n.text;
          tag(known, "edited_externally");
        }
        continue;
      }
      // новая фигура, нарисованная в Visio: на странице операции или на общей схеме процесса.
      // У общей схемы метки pm_scope нет (vsdx.ts), и шаги такой диаграммы в модели идут без bpmn_scope
      // (types/model.ts) — поэтому отсутствие scope не повод отбрасывать фигуру: иначе в сессии без кода
      // процесса и без операций (режим «рисовать с нуля») нарисовать шаг в Visio негде.
      if (n.synth || n.pmId || (page.scope && !nodeById.has(page.scope))) continue; // заглушка выгрузки, чужая метка или ссылка на несуществующую операцию — не угадываем
      // новая фигура, нарисованная в Visio
      const [cx, cy] = centre(n.box);
      const lane = leaves.filter((c) => cx >= c.box.x && cx <= c.box.x + c.box.w && cy >= c.box.y && cy <= c.box.y + c.box.h).sort((a, b) => area(a.box) - area(b.box))[0];
      const role = lane?.laneId && out.roles.some((r) => r.id === lane.laneId) ? lane.laneId : null;
      // у шлюза из палитры Visio подпись — только значок («X», «+», «O»): это не название шага
      const text = n.kind === "gateway" && /^[X+O×]$/i.test(n.text) ? "" : n.text;
      const node: ProcessNode = {
        id: `imp_${nanoid(8)}`,
        type: n.kind,
        subtype: n.subtype ?? (n.kind === "event" ? "intermediate" : undefined),
        ...(n.trigger ? { trigger: n.trigger } : {}),
        ...(n.loop ? { loop: n.loop } : {}),
        name: text || "(без названия)",
        role_id: n.kind === "event" || n.kind === "gateway" ? null : role,
        system_ids: [],
        inputs: [],
        outputs: [],
        controls: [],
        duration: null,
        frequency: null,
        idef0_parent: null,
        bpmn_scope: page.scope ?? null,
        status: text ? "confirmed" : "hypothesis",
        confidence: text ? 0.8 : 0.4,
        source: [{ fragment_id: "diagram_import", quote: `${page.name}: ${n.shapeId}` }],
        requirement_ids: [],
        tags: ["from_diagram_import", "added_externally"],
        confirmed_by: [],
      };
      out.nodes.push(node);
      nodeById.set(node.id, node);
      seenNodes.add(node.id);
      idByKey.set(n.key, node.id);
      changes.added.push(node.id);
      changes.shapeMap.push({ page: page.name, shapeId: n.shapeId, nodeId: node.id });
    }

    for (const e of page.edges) {
      // производная связь общей схемы (DerivedFlow_N): нарисована для читаемости, но в модели её нет —
      // обратный приём не должен превращать её в настоящий поток
      if (e.pmId?.startsWith("DerivedFlow_")) continue;
      const flow = e.pmId ? flowById.get(e.pmId) : undefined;
      if (flow) {
        seenFlows.add(flow.id);
        if (e.label !== (flow.condition ?? "")) {
          changes.flowsRenamed.push({ flowId: flow.id, from: flow.condition ?? "", to: e.label });
          flow.condition = e.label || null;
        }
        continue;
      }
      const [from, to] = [idByKey.get(e.from), idByKey.get(e.to)];
      if (!from || !to || flowKeys.has(`${from}|${to}`)) continue;
      const added: ProcessFlow = { id: `flow_${nanoid(8)}`, from, to, condition: e.label || null, ...(e.isDefault ? { is_default: true } : {}), source: [{ fragment_id: "diagram_import", quote: page.name }], confirmed_by: [] };
      out.flows.push(added);
      flowKeys.add(`${from}|${to}`);
      changes.addedFlows.push(added.id);
      if (e.shapeId) changes.flowMap.push({ page: page.name, shapeId: e.shapeId, flowId: added.id });
    }

    for (const id of page.manifest?.nodes ?? []) if (!seenNodes.has(id) && nodeById.has(id)) changes.missing.push(id);
    for (const id of page.manifest?.flows ?? []) if (!seenFlows.has(id) && flowById.has(id)) changes.missingFlows.push(id);
  }
  return { model: out, changes };
}


/**
 * Размер и положение листа, изменённые в Visio (рамку листа растянули или подвинули), переносятся в настройки листа модели:
 * idef0_frames / bpmn_frames, ключ — функция или операция диаграммы. Поле листа — без штампа, поэтому высота рамки уменьшается
 * на высоту штампа. Возвращает число изменённых листов.
 */
export function applySheetEdits(model: ProcessLogicModel, sheets: VsdxSheet[]): number {
  let changed = 0;
  for (const sh of sheets) {
    const [ox, oy, ow, oh] = sh.orig;
    const moved = [sh.now.x - ox, sh.now.y - oy, sh.now.w - ow, sh.now.h - oh].some((d) => Math.abs(d) > 2);
    if (!moved) continue;
    const field = sh.kind === "idef0" ? "idef0_frames" : "bpmn_frames";
    const frames = (model[field] ??= {} as Record<string, IdefFrame>);
    const cur: IdefFrame = frames[sh.key] ?? {};
    // на клетку — как лист в редакторе; размер не меньше минимального
    const snap = (v: number) => Math.round(v / FRAME_GRID) * FRAME_GRID;
    cur.x = snap(sh.now.x);
    cur.y = snap(sh.now.y);
    cur.w = Math.max(FRAME_MIN_W, snap(sh.now.w));
    cur.h = Math.max(FRAME_MIN_H, snap(sh.now.h - FRAME_H));
    if (sh.kind === "bpmn") cur.show = true; // лист BPMN по умолчанию скрыт: раз его правили, он нужен
    frames[sh.key] = cur;
    changed++;
  }
  return changed;
}


/** Что изменилось на страницах IDEF0 в Visio. */
export interface Idef0EditChanges {
  /** Переименованные блоки функций. */
  functions: { nodeId: string; from: string; to: string }[];
  /** Переименованные стрелки: меняется название сущности (данные, регламента, роли, системы) — она общая для всех диаграмм. */
  arrows: { kind: string; entityId: string; from: string; to: string }[];
  /** Блоки и стрелки, удалённые в Visio (в модели остались). */
  missingFunctions: string[];
  missingArrows: string[];
  /** Новые функции, созданные по блокам, нарисованным в Visio (режим «рисовать с нуля»). */
  added: string[];
  /** Новые стрелки ICOM, созданные по соединителям из Visio. */
  addedArrows: { kind: string; nodeId: string; entityId: string }[];
  /** Фигура Visio → созданная функция: оболочка помечает фигуру метками модели. */
  shapeMap: { page: string; shapeId: string; nodeId: string }[];
  /** Соединитель Visio → созданная стрелка; link — метка pm_a («вид|функция|сущность»). */
  arrowMap: { page: string; shapeId: string; entityId: string; link: string }[];
  /** Сколько нарисованных фигур пропущено: без подписи, на контекстной странице, на странице «только чтение». */
  skipped: number;
}

/**
 * Правки страниц IDEF0 из Visio: название блока (текст «код название» без кода) и подпись стрелки возвращаются в модель. Новые фигуры
 * IDEF0 не создаются, удалённые только перечисляются (удаляет их applyDeletions по подтверждению).
 */
export function applyIdef0Edits(model: ProcessLogicModel, pages: VsdxIdef0Page[]): Idef0EditChanges {
  const out: Idef0EditChanges = { functions: [], arrows: [], missingFunctions: [], missingArrows: [], added: [], addedArrows: [], shapeMap: [], arrowMap: [], skipped: 0 };
  const seenFn = new Set<string>();
  const seenAr = new Set<string>();
  const nodeById = new Map(model.nodes.map((n) => [n.id, n] as const));
  const tag = (n: ProcessNode, t: string) => {
    if (!n.tags.includes(t)) n.tags = [...n.tags, t];
  };
  const entities = (kind: string): { id: string; name: string }[] | null =>
    kind === "input" || kind === "output" || kind === "link" || kind === "controlData" ? model.data : kind === "control" ? model.controls : kind === "role" ? model.roles : kind === "system" ? model.systems : null;
  for (const page of pages) {
    for (const m of page.marks) {
      if (m.k === "fn") {
        seenFn.add(m.id);
        const node = nodeById.get(m.id);
        if (!node) continue;
        let text = clean(m.text);
        if (m.code && text.startsWith(`${m.code} `)) text = text.slice(m.code.length + 1).trim();
        if (text && text !== clean(m.was) && text !== node.name) {
          out.functions.push({ nodeId: node.id, from: node.name, to: text });
          node.name = text;
          tag(node, "edited_externally");
        }
      } else {
        const [kind, , entityId] = (m.link ?? "").split("|");
        if (m.link) seenAr.add(m.link);
        const list = entities(kind);
        const entity = list?.find((e) => e.id === (entityId ?? m.id));
        if (!entity) continue;
        const text = clean(m.text);
        // подпись при выгрузке перенесена по словам: сравниваются слова, а не переводы строк
        if (text && text !== clean(m.was) && text !== entity.name) {
          out.arrows.push({ kind, entityId: entity.id, from: entity.name, to: text });
          entity.name = text;
        }
      }
    }
    // --- нарисованное в Visio (у этих фигур меток pm_* нет): блоки функций и стрелки ICOM ---
    const parentId = page.parent && nodeById.has(page.parent) ? page.parent : null;
    // контекстная диаграмма — один блок процесса, страница «только чтение» — утверждённая версия: там не создаём
    const drawable = !page.readOnly && !page.context && (!page.parent || parentId !== null);
    const boxById = new Map<string, VsdxBox>();
    for (const m of page.marks) if (m.k === "fn" && m.box) boxById.set(m.shapeId, m.box);
    const nodeIdByShape = new Map<string, string>();
    for (const m of page.marks) if (m.k === "fn") nodeIdByShape.set(m.shapeId, m.id);
    /** Сторона блока, у которой лежит конец стрелки: в IDEF0 сторона и задаёт вид связи (Порт: вход слева, управление сверху, выход справа, механизм снизу). */
    const sideAt = (box: VsdxBox | undefined, p?: [number, number]): "T" | "L" | "B" | "R" | null => {
      if (!box || !p) return null;
      if (p[0] < box.x - 16 || p[0] > box.x + box.w + 16 || p[1] < box.y - 16 || p[1] > box.y + box.h + 16) return null;
      const d: [("T" | "L" | "B" | "R"), number][] = [
        ["T", Math.abs(p[1] - box.y)],
        ["L", Math.abs(p[0] - box.x)],
        ["B", Math.abs(p[1] - (box.y + box.h))],
        ["R", Math.abs(p[0] - (box.x + box.w))],
      ];
      d.sort((a, b) => a[1] - b[1]);
      return d[0][0];
    };
    // сущности стрелок создаются по подписи, если такой ещё нет: данные — для входа/выхода/связи, регламент — для управления, роль — для механизма
    const dataByName = (name: string) => model.data.find((d) => d.name === name) ?? (() => { const d = { id: `d_${nanoid(6)}`, name, kind: "data" as const, source: [] }; model.data.push(d); return d; })();
    const controlByName = (name: string) => model.controls.find((c) => c.name === name) ?? (() => { const c = { id: `c_${nanoid(6)}`, name, kind: "rule" as const, source: [] }; model.controls.push(c); return c; })();
    const roleByName = (name: string) => model.roles.find((r) => r.name === name) ?? (() => { const r = { id: `r_${nanoid(6)}`, name, kind: "internal" as const, source: [] }; model.roles.push(r); return r; })();

    for (const n of page.nodes ?? []) {
      if (!drawable) {
        out.skipped++;
        continue;
      }
      const fn: ProcessNode = {
        id: `fn_${nanoid(8)}`,
        type: "task",
        name: clean(n.text) || "Новая функция",
        role_id: null,
        system_ids: [],
        inputs: [],
        outputs: [],
        controls: [],
        duration: null,
        frequency: null,
        idef0_parent: parentId,
        bpmn_scope: null,
        status: "confirmed",
        confidence: 0.8,
        source: [{ fragment_id: "diagram_import", quote: `${page.name}: ${n.shapeId}` }],
        requirement_ids: [],
        tags: ["from_diagram_import", "added_externally"],
        confirmed_by: [],
      };
      model.nodes.push(fn);
      nodeById.set(fn.id, fn);
      boxById.set(n.shapeId, n.box);
      nodeIdByShape.set(n.shapeId, fn.id);
      out.added.push(fn.id);
      out.shapeMap.push({ page: page.name, shapeId: n.shapeId, nodeId: fn.id });
    }

    for (const e of [...(page.edges ?? []), ...(page.loose ?? [])]) {
      const shapeOf = (k: string) => (k ? k.slice(k.indexOf(":") + 1) : "");
      const srcId = nodeIdByShape.get(shapeOf(e.from));
      const dstId = nodeIdByShape.get(shapeOf(e.to));
      const name = clean(e.label);
      const head = sideAt(boxById.get(shapeOf(e.to)), e.end);
      const tail = sideAt(boxById.get(shapeOf(e.from)), e.begin);
      // безымянной стрелке нечего дать в модель, а концы без блока (например, соединитель между примечаниями) не стрелка ICOM
      if (!drawable || !name || (!srcId && !dstId) || (!head && !tail)) {
        out.skipped++;
        continue;
      }
      const src = srcId ? nodeById.get(srcId) : undefined;
      const dst = dstId ? nodeById.get(dstId) : undefined;
      let kind: string;
      let entityId: string;
      let nodeId: string;
      if (dst && head) {
        nodeId = dst.id;
        if (head === "T") {
          const c = controlByName(name);
          dst.controls = [...dst.controls, c.id];
          kind = "control";
          entityId = c.id;
        } else if (head === "B") {
          const r = roleByName(name);
          dst.role_id = r.id;
          kind = "role";
          entityId = r.id;
        } else if (head === "L" && src && tail === "R") {
          // «выход → вход»: одна и та же сущность у источника в выходах, у потребителя во входах
          const d = dataByName(name);
          src.outputs = [...src.outputs, d.id];
          dst.inputs = [...dst.inputs, d.id];
          kind = "link";
          entityId = d.id;
        } else if (head === "L") {
          const d = dataByName(name);
          dst.inputs = [...dst.inputs, d.id];
          kind = "input";
          entityId = d.id;
        } else {
          // голова у правой стороны блока: стрелка из него выходит
          const d = dataByName(name);
          dst.outputs = [...dst.outputs, d.id];
          kind = "output";
          entityId = d.id;
        }
      } else if (src && tail === "R") {
        // выход в пустое место (второй конец ни к чему не приклеен)
        const d = dataByName(name);
        src.outputs = [...src.outputs, d.id];
        kind = "output";
        entityId = d.id;
        nodeId = src.id;
      } else {
        out.skipped++;
        continue;
      }
      out.addedArrows.push({ kind, nodeId, entityId });
      if (e.shapeId) out.arrowMap.push({ page: page.name, shapeId: e.shapeId, entityId, link: `${kind}|${nodeId}|${entityId}` });
    }

    for (const id of page.manifest?.fn ?? []) if (!seenFn.has(id) && nodeById.has(id)) out.missingFunctions.push(id);
    for (const l of page.manifest?.ar ?? []) if (!seenAr.has(l)) out.missingArrows.push(l);
  }
  return out;
}

/**
 * Удаляет из модели то, что в Visio нарисовано при выгрузке, а потом удалено: шаги (с граничными событиями и стрелками к ним),
 * функции IDEF0 (с вложенными функциями и шагами их диаграмм) и стрелки BPMN. Стрелки IDEF0 снимаются со связанных функций (данные,
 * регламенты, роли и системы остаются в справочниках). Возвращает, сколько объектов удалено.
 */
export function applyDeletions(model: ProcessLogicModel, nodeIds: string[], flowIds: string[], arrowLinks: string[] = []): { nodes: number; flows: number; arrows: number } {
  const doomed = new Set(nodeIds);
  // вложенные: потомки функции, шаги её диаграммы и граничные события удаляемых задач
  for (let grew = true; grew; ) {
    grew = false;
    for (const n of model.nodes) {
      if (doomed.has(n.id)) continue;
      if ((n.idef0_parent && doomed.has(n.idef0_parent)) || (n.bpmn_scope && doomed.has(n.bpmn_scope)) || (n.attached_to && doomed.has(n.attached_to))) {
        doomed.add(n.id);
        grew = true;
      }
    }
  }
  const before = { nodes: model.nodes.length, flows: model.flows.length };
  const goneFlows = new Set(flowIds);
  model.nodes = model.nodes.filter((n) => !doomed.has(n.id));
  model.flows = model.flows.filter((f) => !goneFlows.has(f.id) && !doomed.has(f.from) && !doomed.has(f.to));
  let arrows = 0;
  for (const link of arrowLinks) {
    const [kind, nodeId, entityId] = link.split("|");
    const n = model.nodes.find((x) => x.id === nodeId);
    if (!n || !entityId) continue;
    const drop = (list: string[] | undefined) => (list ? list.filter((x) => x !== entityId) : list);
    const was = JSON.stringify([n.inputs, n.outputs, n.controls, n.system_ids, n.control_data_ids, n.role_id]);
    if (kind === "input" || kind === "link") n.inputs = drop(n.inputs) ?? [];
    else if (kind === "output") n.outputs = drop(n.outputs) ?? [];
    else if (kind === "control") n.controls = drop(n.controls) ?? [];
    else if (kind === "controlData" || kind === "controlLink") n.control_data_ids = drop(n.control_data_ids);
    else if (kind === "system") n.system_ids = drop(n.system_ids) ?? [];
    else if (kind === "role" && n.role_id === entityId) n.role_id = null;
    if (JSON.stringify([n.inputs, n.outputs, n.controls, n.system_ids, n.control_data_ids, n.role_id]) !== was) arrows++;
  }
  return { nodes: before.nodes - model.nodes.length, flows: before.flows - model.flows.length, arrows };
}
