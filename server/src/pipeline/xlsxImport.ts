import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";
import { nanoid } from "nanoid";
import type { DataEntity, ProcessFlow, ProcessNode, Role, SystemEntity } from "../types/model.js";
import type { SessionMeta } from "../repo.js";
import { importedModel } from "./diagramImport.js";
import { zipReader } from "../util/zipSafe.js";

/**
 * Модель из таблицы Excel (.xlsx, ТЗ Р10 «перечень элементов → создание модели»): одна строка — один шаг.
 * Книга читается как обычный ZIP с XML (jszip + fast-xml-parser): готовые библиотеки чтения .xlsx содержат
 * непропатченные уязвимости именно в разборе файлов, поэтому здесь они не используются.
 *
 * Столбцы находятся по заголовку (русские и английские названия; порядок и лишние столбцы не важны):
 *   № · Название (обязателен) · Тип · Исполнитель · Следующий шаг · Система · Вход · Выход · Срок · Комментарий
 * «Следующий шаг» — номера или названия шагов через «;» или перевод строки, условие ветки — в скобках: «5 (да); 7 (нет)».
 * Без этого столбца шаги соединяются подряд, в порядке строк.
 */

export interface TableSheet {
  name: string;
  rows: string[][];
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  removeNSPrefix: true,
  trimValues: false,
  parseTagValue: false,
  isArray: (name) => ["sheet", "si", "row", "c", "r", "t", "Relationship"].includes(name),
});

type X = Record<string, any>;
const arr = <T>(v: T | T[] | undefined): T[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
const MAX_ROWS = 5000;
const MAX_COLS = 60;

/** Текст из <t> (строка или объект с атрибутами xml:space). */
const tText = (t: unknown): string => (typeof t === "string" ? t : typeof t === "object" && t !== null ? String((t as X)["#text"] ?? "") : "");
/** Строка общих строк или inline-строки: простой текст или несколько форматированных отрезков. */
const richText = (si: X): string => (si.t ? arr(si.t).map(tText).join("") : arr<X>(si.r).map((r) => arr(r.t).map(tText).join("")).join(""));

/** Номер столбца по ссылке ячейки «C12» → 2. */
function columnOf(ref: string): number {
  let n = 0;
  for (const ch of ref.replace(/[^A-Za-z]/g, "").toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Листы книги с таблицей значений (текст всех ячеек как строки). */
export async function parseXlsx(buffer: Buffer): Promise<TableSheet[]> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    throw new Error("Файл не открывается как .xlsx: нужна книга Excel 2007 и новее. Старый формат .xls сохраните как «Книга Excel (*.xlsx)».");
  }
  const read = zipReader(zip);
  const workbook = await read("xl/workbook.xml");
  if (!workbook) throw new Error("В файле нет книги Excel (xl/workbook.xml) — это не .xlsx.");

  const shared: string[] = [];
  const ss = await read("xl/sharedStrings.xml");
  if (ss) for (const si of arr<X>(parser.parse(ss).sst?.si)) shared.push(richText(si));

  const rels = new Map<string, string>();
  const relsXml = await read("xl/_rels/workbook.xml.rels");
  if (relsXml) for (const r of arr<X>(parser.parse(relsXml).Relationships?.Relationship)) rels.set(String(r["@_Id"]), String(r["@_Target"]));

  const sheets: TableSheet[] = [];
  for (const s of arr<X>(parser.parse(workbook).workbook?.sheets?.sheet)) {
    if (String(s["@_state"] ?? "") === "hidden") continue;
    const target = rels.get(String(s["@_id"] ?? ""));
    if (!target) continue;
    const xml = await read(`xl/${target.replace(/^\/?(xl\/)?/, "")}`);
    if (!xml) continue;
    const rows: string[][] = [];
    for (const row of arr<X>(parser.parse(xml).worksheet?.sheetData?.row)) {
      const idx = Number(row["@_r"]) - 1;
      if (!Number.isFinite(idx) || idx < 0 || idx >= MAX_ROWS) continue;
      const cells: string[] = [];
      for (const c of arr<X>(row.c)) {
        const col = columnOf(String(c["@_r"] ?? ""));
        if (col < 0 || col >= MAX_COLS) continue;
        const type = String(c["@_t"] ?? "");
        const v = c.v === undefined ? "" : tText(arr(c.v)[0] ?? c.v);
        cells[col] = type === "s" ? shared[Number(v)] ?? "" : type === "inlineStr" ? richText(c.is ?? {}) : type === "b" ? (v === "1" ? "да" : "нет") : v;
      }
      while (rows.length < idx) rows.push([]);
      rows[idx] = Array.from(cells, (x) => x ?? "");
    }
    sheets.push({ name: String(s["@_name"] ?? `Лист ${sheets.length + 1}`), rows });
  }
  if (sheets.length === 0) throw new Error("В книге нет ни одного видимого листа.");
  return sheets;
}

// --- таблица → модель ---

const clean = (s: string) => s.replace(/\s+/g, " ").trim();
const norm = (s: string) => clean(s).toLowerCase().replace(/ё/g, "е");
const parts = (s: string) => s.split(/[;\n]+/).map(clean).filter(Boolean);

type Column = "key" | "name" | "type" | "role" | "next" | "system" | "input" | "output" | "duration" | "note";
const HEADERS: [Column, RegExp][] = [
  ["next", /^(следующ|далее|переход|next|successor)/],
  ["name", /^(название|наименование|шаг|действие|операция|процедура|этап|элемент|name|step|activity|task)/],
  ["key", /^(№|#|номер|код|идентификатор|ключ|id(?![a-z])|no(?![a-z])|n(?![a-z]))/],
  ["type", /^(тип|вид|type|kind)/],
  ["role", /^(исполнитель|роль|ответственн|участник|должность|подразделение|role|performer|owner|actor)/],
  ["system", /^(система|ис(?![а-я])|информационн|приложение|system|application|tool)/],
  ["input", /^(вход|входн|документ на входе|input|in\b)/],
  ["output", /^(выход|результат|документ на выходе|output|out\b)/],
  ["duration", /^(срок|длительность|время|трудоемкость|duration|time|sla)/],
  ["note", /^(комментарий|примечание|описание|заметк|comment|note|description)/],
];

/** Какой столбец означает заголовок ячейки (проверка идёт по порядку: «Название шага» — название, а не следующий шаг). */
function columnFor(header: string): Column | null {
  const h = norm(header);
  if (!h) return null;
  return HEADERS.find(([, re]) => re.test(h))?.[0] ?? null;
}

interface Item {
  rowNo: number;
  key: string;
  name: string;
  type: string;
  role: string;
  next: string;
  systems: string[];
  inputs: string[];
  outputs: string[];
  duration: string;
  note: string;
}

/**
 * Лист с таблицей: в одной из первых 10 строк есть заголовок «Название». Из нескольких листов берётся тот, где
 * распознано больше столбцов (лист с инструкцией, где слово «Название» стоит в начале строки, проигрывает), при равенстве — первый.
 */
function findTable(sheets: TableSheet[]): { sheet: TableSheet; headerRow: number; columns: Map<Column, number> } | null {
  let best: { sheet: TableSheet; headerRow: number; columns: Map<Column, number> } | null = null;
  for (const sheet of sheets) {
    for (let r = 0; r < Math.min(10, sheet.rows.length); r++) {
      const columns = new Map<Column, number>();
      (sheet.rows[r] ?? []).forEach((cell, i) => {
        const col = columnFor(cell ?? "");
        if (col && !columns.has(col)) columns.set(col, i);
      });
      if (!columns.has("name")) continue;
      if (!best || columns.size > best.columns.size) best = { sheet, headerRow: r, columns };
      break;
    }
  }
  return best;
}

const EVENT = /событ|event|начал|старт|start|конец|заверш|финиш|end\b/;
const GATEWAY = /решени|шлюз|gateway|условие|развилк|decision|выбор/;

/** Модель процесса из листа Excel: шаги, события, шлюзы, потоки, исполнители, системы и документы. */
export function buildModelFromTable(sheets: TableSheet[], meta: SessionMeta) {
  const warnings: string[] = [];
  const found = findTable(sheets);
  if (!found) throw new Error("Не найден заголовок таблицы: в одной из первых строк листа должен быть столбец «Название» (или «Шаг», «Действие», «Операция»).");
  const { sheet, headerRow, columns } = found;
  const cell = (row: string[], col: Column) => (columns.has(col) ? clean(row[columns.get(col)!] ?? "") : "");

  const items: Item[] = [];
  const keys = new Map<string, Item>();
  for (let r = headerRow + 1; r < sheet.rows.length; r++) {
    const row = sheet.rows[r] ?? [];
    if (row.every((c) => !clean(c ?? ""))) continue;
    const name = cell(row, "name");
    if (!name) {
      warnings.push(`Строка ${r + 1}: нет названия — пропущена.`);
      continue;
    }
    const item: Item = {
      rowNo: r + 1,
      key: cell(row, "key") || String(items.length + 1),
      name,
      type: norm(cell(row, "type")),
      role: cell(row, "role"),
      next: columns.has("next") ? (row[columns.get("next")!] ?? "") : "",
      systems: parts(cell(row, "system")),
      inputs: parts(cell(row, "input")),
      outputs: parts(cell(row, "output")),
      duration: cell(row, "duration"),
      note: cell(row, "note"),
    };
    if (keys.has(norm(item.key))) warnings.push(`Строка ${r + 1}: номер «${item.key}» уже был в строке ${keys.get(norm(item.key))!.rowNo} — ссылки на него ведут к первой.`);
    else keys.set(norm(item.key), item);
    items.push(item);
  }
  if (items.length === 0) throw new Error("В таблице нет ни одной строки с названием шага.");
  if (items.length >= MAX_ROWS) warnings.push(`Прочитаны первые ${MAX_ROWS} строк.`);

  const roles: Role[] = [];
  const systems: SystemEntity[] = [];
  const data: DataEntity[] = [];
  /** Запись справочника с таким названием (без учёта регистра); если её ещё нет — создаётся с id вида «role_xxxxxxxx». */
  const intern = <T extends { id: string; name: string }>(list: T[], name: string, make: (id: string) => T, prefix: string): T => {
    let x = list.find((e) => norm(e.name) === norm(name));
    if (!x) list.push((x = make(`${prefix}_${nanoid(8)}`)));
    return x;
  };

  const idOf = new Map<Item, string>();
  const nodes: ProcessNode[] = items.map((it) => {
    const id = `imp_${nanoid(8)}`;
    idOf.set(it, id);
    const t = it.type;
    const isGateway = GATEWAY.test(t);
    const isEvent = !isGateway && EVENT.test(t);
    const type: ProcessNode["type"] = isGateway ? "gateway" : isEvent ? "event" : /подпроцесс|subprocess/.test(t) ? "subprocess" : "task";
    let subtype: string | undefined;
    if (isGateway) subtype = /паралл|parallel|\band\b/.test(t) ? "parallel" : /включ|inclusive|\bor\b/.test(t) ? "inclusive" : "exclusive";
    else if (isEvent) subtype = /конец|заверш|финиш|end\b/.test(t) ? "end" : /начал|старт|start/.test(t) ? "start" : "intermediate";
    else if (type === "task") subtype = /польз|user/.test(t) ? "user" : /сервис|service/.test(t) ? "service" : /ручн|manual/.test(t) ? "manual" : /отправ|send/.test(t) ? "send" : /получ|receive/.test(t) ? "receive" : /скрипт|script/.test(t) ? "script" : /бизнес.?правил|business/.test(t) ? "business_rule" : undefined;
    const role = it.role && type !== "event" && type !== "gateway" ? intern(roles, it.role, (id) => ({ id, name: it.role, kind: "internal" as const, source: [] }), "role") : null;
    return {
      id,
      type,
      subtype,
      name: it.name,
      role_id: role?.id ?? null,
      system_ids: it.systems.map((s) => intern(systems, s, (id) => ({ id, name: s, source: [] }), "sys").id),
      inputs: it.inputs.map((d) => intern(data, d, (id) => ({ id, name: d, kind: "document" as const, source: [] }), "data").id),
      outputs: it.outputs.map((d) => intern(data, d, (id) => ({ id, name: d, kind: "document" as const, source: [] }), "data").id),
      controls: [],
      duration: it.duration || null,
      frequency: null,
      idef0_parent: null,
      status: "confirmed",
      confidence: 0.9,
      source: [{ fragment_id: "table_import", quote: `${sheet.name}, строка ${it.rowNo}` }],
      ...(it.note ? { note: it.note } : {}),
      requirement_ids: [],
      tags: ["from_table_import"],
      confirmed_by: [],
    };
  });

  const byName = new Map<string, Item>();
  for (const it of items) if (!byName.has(norm(it.name))) byName.set(norm(it.name), it);
  const flows: ProcessFlow[] = [];
  const link = (from: Item, to: Item, condition: string | null, quote: string) => {
    if (from === to && !condition) return;
    flows.push({ id: `flow_${nanoid(8)}`, from: idOf.get(from)!, to: idOf.get(to)!, condition, source: [{ fragment_id: "table_import", quote }], confirmed_by: [] });
  };

  if (columns.has("next")) {
    for (const it of items) {
      for (const ref of parts(it.next)) {
        // сначала ссылка целиком: в названии шага могут быть скобки («Оплатить (частично)»); затем «5 (да)» или «Проверить заявку [нет]»
        const whole = keys.get(norm(ref)) ?? byName.get(norm(ref));
        if (whole) {
          link(it, whole, null, `${sheet.name}, строка ${it.rowNo}`);
          continue;
        }
        const m = /^(.*?)\s*[([]\s*([^()[\]]+?)\s*[)\]]$/.exec(ref);
        const [target, condition] = m ? [clean(m[1]), clean(m[2])] : [ref, null];
        const to = keys.get(norm(target)) ?? byName.get(norm(target));
        if (!to) warnings.push(`Строка ${it.rowNo}: следующий шаг «${target}» не найден ни по номеру, ни по названию — связь пропущена.`);
        else link(it, to, condition, `${sheet.name}, строка ${it.rowNo}`);
      }
    }
  } else {
    // нет столбца «Следующий шаг» — шаги идут подряд, конец процесса ничего не продолжает
    items.forEach((it, i) => {
      const next = items[i + 1];
      const isEnd = nodes[i].type === "event" && nodes[i].subtype === "end";
      if (next && !isEnd) link(it, next, null, `${sheet.name}, строка ${it.rowNo}`);
    });
    warnings.push("Столбца «Следующий шаг» нет — шаги соединены подряд, в порядке строк.");
  }

  const extra = (sheet.rows[headerRow] ?? []).filter((h, i) => clean(h ?? "") && ![...columns.values()].includes(i));
  if (extra.length) warnings.push(`Столбцы не распознаны и пропущены: ${extra.map((h) => `«${clean(h)}»`).join(", ")}.`);

  const model = importedModel(meta, { nodes, flows, roles });
  model.systems = systems;
  model.data = data;
  return { model, warnings };
}
