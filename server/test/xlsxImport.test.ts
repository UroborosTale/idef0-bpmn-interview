import JSZip from "jszip";
import * as XLSX from "xlsx";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildModelFromTable, parseXlsx } from "../src/pipeline/xlsxImport.js";
import { stepsTemplateXlsx } from "../src/pipeline/xlsxTemplate.js";
import { validateModel } from "../src/pipeline/validate.js";
import { startApp } from "./api.js";

delete process.env.AUTH_USERS;

const meta = { processName: "Из таблицы", modelType: "AS-IS" as const, decompositionDepth: 2, notations: ["IDEF0", "BPMN"] as ("IDEF0" | "BPMN")[] };

/** Книга Excel из строк (как её сохранил бы Excel: общие строки, листы по порядку). */
const book = (...sheets: [string, string[][]][]): Buffer => {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of sheets) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
};
const load = async (buf: Buffer) => buildModelFromTable(await parseXlsx(buf), meta);

describe("импорт из таблицы Excel (.xlsx)", () => {
  it("образец из шаблона превращается в модель: шаги, события, шлюз, потоки с условиями, исполнители, системы, документы", async () => {
    const { model, warnings } = await load(stepsTemplateXlsx());
    const node = (name: string) => model.nodes.find((n) => n.name === name)!;
    expect(model.nodes).toHaveLength(6);
    expect(node("Заявка поступила")).toMatchObject({ type: "event", subtype: "start" });
    expect(node("Заявка согласована")).toMatchObject({ type: "event", subtype: "end" });
    expect(node("Заявка полная?")).toMatchObject({ type: "gateway", subtype: "exclusive" });
    expect(node("Оформить заявку")).toMatchObject({ type: "task", duration: "1 ч" });
    // потоки: «5 (да); 2 (нет)» — две ветки шлюза с условиями; остальные — по номерам
    const flows = (from: string) => model.flows.filter((f) => f.from === node(from).id).map((f) => `${model.nodes.find((n) => n.id === f.to)!.name}|${f.condition ?? ""}`).sort();
    expect(flows("Заявка полная?")).toEqual(["Оформить заявку|нет", "Согласовать заявку|да"]);
    expect(flows("Оформить заявку")).toEqual(["Проверить комплектность заявки|"]);
    expect(model.flows).toHaveLength(6);
    // справочники: одна запись на название, шаги ссылаются на неё
    expect(model.roles.map((r) => r.name).sort()).toEqual(["Инициатор", "Руководитель", "Секретарь"]);
    expect(model.roles.find((r) => r.id === node("Оформить заявку").role_id)!.name).toBe("Инициатор");
    expect(node("Заявка полная?").role_id).toBeNull(); // у шлюза исполнителя нет
    expect(model.systems.map((s) => s.name)).toEqual(["1С"]);
    expect(model.data.map((d) => d.name).sort()).toEqual(["Заявка", "Решение о закупке"]); // «Заявка» — и выход, и вход, запись одна
    expect(node("Согласовать заявку").inputs).toEqual(node("Проверить комплектность заявки").inputs);
    expect(node("Заявка полная?").note).toBe("Условие ветки — в скобках");
    expect(model.nodes.every((n) => n.status === "confirmed" && n.tags.includes("from_table_import"))).toBe(true);
    expect(warnings).toEqual([]);
    expect(validateModel(model).filter((i) => i.severity === "error")).toEqual([]);
  });

  it("лист с таблицей выбирается сам, инструкция на другом листе не мешает", async () => {
    const sheets = await parseXlsx(stepsTemplateXlsx());
    expect(sheets.map((s) => s.name)).toEqual(["Шаги", "Как заполнять"]);
  });

  it("английские заголовки, шапка не в первой строке, пустые строки, лишние столбцы, ссылки по названию", async () => {
    const { model, warnings } = await load(
      book([
        "Process",
        [
          ["Описание процесса", "", "", ""],
          [""],
          ["Step", "Role", "Next", "Owner comment", "Type"],
          ["Receive order", "Sales", "Check stock", "важно", "start event"],
          [""],
          ["Check stock", "Warehouse", "Ship; Cancel (нет)", "", "decision"],
          ["Ship", "Warehouse", "", "", "service task"],
          ["Cancel", "Sales", "", "", ""],
        ],
      ])
    );
    const node = (name: string) => model.nodes.find((n) => n.name === name)!;
    expect(model.nodes).toHaveLength(4);
    expect(node("Receive order")).toMatchObject({ type: "event", subtype: "start" });
    expect(node("Ship")).toMatchObject({ type: "task", subtype: "service" });
    expect(node("Check stock").type).toBe("gateway");
    const out = model.flows.filter((f) => f.from === node("Check stock").id).map((f) => `${model.nodes.find((n) => n.id === f.to)!.name}|${f.condition ?? ""}`).sort();
    expect(out).toEqual(["Cancel|нет", "Ship|"]);
    expect(model.roles.map((r) => r.name).sort()).toEqual(["Sales", "Warehouse"]);
    expect(warnings.join(" ")).toMatch(/«Owner comment»/); // нераспознанный столбец назван в предупреждении
  });

  it("без столбца «Следующий шаг» шаги идут подряд, конец ничего не продолжает", async () => {
    const { model, warnings } = await load(book(["Шаги", [["Название", "Тип"], ["Начало работы", "начало"], ["Сделать раз", ""], ["Сделать два", ""], ["Готово", "конец"], ["Лишнее после конца", ""]]]));
    expect(model.flows).toHaveLength(3);
    const names = (id: string) => model.nodes.find((n) => n.id === id)!.name;
    expect(model.flows.map((f) => `${names(f.from)}→${names(f.to)}`)).toEqual(["Начало работы→Сделать раз", "Сделать раз→Сделать два", "Сделать два→Готово"]);
    expect(warnings.join(" ")).toMatch(/Столбца «Следующий шаг» нет/);
  });

  it("предупреждения: строка без названия, неизвестная ссылка, повторный номер", async () => {
    const { model, warnings } = await load(
      book(["Шаги", [["№", "Название", "Следующий шаг"], ["1", "Первый", "9; 2"], ["2", "", ""], ["1", "Повтор номера", ""], ["4", "Четвёртый", "Первый"]]])
    );
    expect(model.nodes.map((n) => n.name)).toEqual(["Первый", "Повтор номера", "Четвёртый"]);
    const w = warnings.join("\n");
    expect(w).toMatch(/Строка 3: нет названия/);
    expect(w).toMatch(/Строка 4: номер «1» уже был в строке 2/);
    expect(w).toMatch(/следующий шаг «9» не найден/);
    // «2» теперь не существует (строка пропущена), а «Четвёртый → Первый» найден по названию
    expect(model.flows.map((f) => `${f.from === model.nodes[2].id ? "Четвёртый" : "?"}→${f.to === model.nodes[0].id ? "Первый" : "?"}`)).toEqual(["Четвёртый→Первый"]);
  });

  it("книга, собранная вручную: inline-строки, булевы значения, скрытый лист пропускается", async () => {
    const zip = new JSZip();
    const ns = `xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`;
    zip.file("xl/workbook.xml", `<workbook ${ns}><sheets><sheet name="Скрытый" sheetId="1" state="hidden" r:id="rId1"/><sheet name="Шаги" sheetId="2" r:id="rId2"/></sheets></workbook>`);
    zip.file("xl/_rels/workbook.xml.rels", `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="x" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="x" Target="/xl/worksheets/sheet2.xml"/></Relationships>`);
    zip.file("xl/worksheets/sheet1.xml", `<worksheet ${ns}><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Название</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Из скрытого листа</t></is></c></row></sheetData></worksheet>`);
    zip.file(
      "xl/worksheets/sheet2.xml",
      `<worksheet ${ns}><sheetData>` +
        `<row r="1"><c r="B1" t="inlineStr"><is><t>Название</t></is></c><c r="D1" t="inlineStr"><is><t>Срок</t></is></c></row>` +
        // ячейка A пустая (пропущена в XML): названия лежат во втором столбце; текст из нескольких отрезков форматирования
        `<row r="2"><c r="B2" t="inlineStr"><is><r><t>Принять </t></r><r><t>заказ</t></r></is></c><c r="D2"><v>3</v></c></row>` +
        `<row r="3"><c r="B3" t="str"><v>Отправить счёт</v></c><c r="D3" t="b"><v>1</v></c></row>` +
        `</sheetData></worksheet>`
    );
    const sheets = await parseXlsx(await zip.generateAsync({ type: "nodebuffer" }));
    expect(sheets.map((s) => s.name)).toEqual(["Шаги"]);
    const { model } = buildModelFromTable(sheets, meta);
    expect(model.nodes.map((n) => [n.name, n.duration])).toEqual([["Принять заказ", "3"], ["Отправить счёт", "да"]]);
  });

  it("ошибки: не книга Excel, нет заголовка, пустая таблица", async () => {
    await expect(parseXlsx(Buffer.from("это не книга"))).rejects.toThrow(/не открывается как \.xlsx/);
    const zip = new JSZip();
    zip.file("hello.txt", "x");
    await expect(parseXlsx(await zip.generateAsync({ type: "nodebuffer" }))).rejects.toThrow(/не \.xlsx/);
    await expect(load(book(["Лист", [["Что-то", "Другое"], ["a", "b"]]]))).rejects.toThrow(/Не найден заголовок таблицы/);
    await expect(load(book(["Лист", [["Название"], [""]]]))).rejects.toThrow(/нет ни одной строки/);
  });
});

describe("импорт из Excel через API", () => {
  let app: Awaited<ReturnType<typeof startApp>>;
  beforeAll(async () => {
    app = await startApp();
  });
  afterAll(() => app.close());
  const m = { processName: "Согласование из таблицы", modelType: "AS-IS", decompositionDepth: 2, notations: ["IDEF0", "BPMN"] };

  it("образец скачивается и сразу импортируется: сессия готова, диаграммы построены, справочники заполнены", async () => {
    const t = await app.raw("/diagram-import/template.xlsx");
    expect(t.status).toBe(200);
    const r = await app.call("POST", "/diagram-import/new", { format: "xlsx", content: t.body.toString("base64"), meta: m });
    expect(r.status).toBe(201);
    const s = r.body.session;
    expect(s.status).toBe("ready");
    expect(s.model.nodes).toHaveLength(6);
    expect(s.model.roles).toHaveLength(3);
    expect(s.model.systems).toHaveLength(1);
    expect(s.bpmnXml).toContain("<bpmn:definitions");
    const versions = (await app.call("GET", `/sessions/${s.id}/versions`)).body;
    expect(versions.map((v: { note: string }) => v.note)).toEqual(["Импорт из диаграммы (xlsx)"]);
  });

  it("не таблица — 400 с пояснением", async () => {
    const r = await app.call("POST", "/diagram-import/new", { format: "xlsx", content: Buffer.from("текст").toString("base64"), meta: m });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/\.xlsx/);
  });
});
