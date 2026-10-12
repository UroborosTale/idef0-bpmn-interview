import JSZip from "jszip";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseVsdx } from "../src/pipeline/vsdxImport.js";
import { parseXlsx } from "../src/pipeline/xlsxImport.js";
import { zipReader } from "../src/util/zipSafe.js";
import { startApp } from "./api.js";

delete process.env.AUTH_USERS;

const MB = 1024 * 1024;
/** Повторяющиеся данные сжимаются в доли процента: «архив-бомба» в сотни раз больше своего размера в архиве. */
const filler = (megabytes: number) => "<Shape ID=\"1\"><Cell N=\"PinX\" V=\"1\"/></Shape>".repeat(Math.ceil((megabytes * MB) / 46));
const ns = `xmlns="http://schemas.microsoft.com/office/visio/2012/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`;

async function bombVsdx(megabytes: number) {
  const zip = new JSZip();
  zip.file("visio/document.xml", `<VisioDocument ${ns}/>`);
  zip.file("visio/pages/pages.xml", `<Pages ${ns}><Page ID="0" NameU="P"><PageSheet><Cell N="PageHeight" V="8"/></PageSheet><Rel r:id="rId1"/></Page></Pages>`);
  zip.file("visio/pages/_rels/pages.xml.rels", `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="x" Target="page1.xml"/></Relationships>`);
  zip.file("visio/pages/page1.xml", `<PageContents ${ns}><Shapes>${filler(megabytes)}</Shapes></PageContents>`);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

describe("загруженные архивы: защита от «бомб»", () => {
  it(".vsdx, распаковывающийся в десятки мегабайт, отклоняется сразу и понятным сообщением", async () => {
    const buf = await bombVsdx(30);
    expect(buf.length).toBeLessThan(1 * MB); // в архиве — доли мегабайта
    const t = Date.now();
    await expect(parseVsdx(buf)).rejects.toThrow(/слишком большой после распаковки.*page1\.xml/);
    expect(Date.now() - t).toBeLessThan(2000);
  });

  it(".xlsx: то же для листа и для общих строк", async () => {
    const ns2 = `xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`;
    const make = async (sheet: string, shared?: string) => {
      const zip = new JSZip();
      zip.file("xl/workbook.xml", `<workbook ${ns2}><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`);
      zip.file("xl/_rels/workbook.xml.rels", `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="x" Target="worksheets/sheet1.xml"/></Relationships>`);
      zip.file("xl/worksheets/sheet1.xml", sheet);
      if (shared) zip.file("xl/sharedStrings.xml", shared);
      return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    };
    const rows = `<worksheet ${ns2}><sheetData>${'<row r="1"><c r="A1" t="inlineStr"><is><t>x</t></is></c></row>'.repeat(Math.ceil((30 * MB) / 60))}</sheetData></worksheet>`;
    await expect(parseXlsx(await make(rows))).rejects.toThrow(/слишком большой после распаковки/);
    const sst = `<sst ${ns2}>${"<si><t>строка</t></si>".repeat(Math.ceil((30 * MB) / 24))}</sst>`;
    await expect(parseXlsx(await make(`<worksheet ${ns2}><sheetData/></worksheet>`, sst))).rejects.toThrow(/слишком большой после распаковки.*sharedStrings/);
  });

  it("пределу не мешает обычный файл; общий бюджет считается по всем прочитанным частям", async () => {
    const zip = new JSZip();
    zip.file("a.xml", "x".repeat(600));
    zip.file("b.xml", "y".repeat(600));
    const loaded = await JSZip.loadAsync(await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
    const read = zipReader(loaded, { entry: 1000, total: 1000 });
    expect(await read("a.xml")).toHaveLength(600);
    expect(await read("нет-такой.xml")).toBeNull();
    await expect(read("b.xml")).rejects.toThrow(/слишком большой/); // 600 + 600 > общего бюджета 1000
    // независимое чтение с новым бюджетом проходит
    expect(await zipReader(loaded, { entry: 1000, total: 5000 })("b.xml")).toHaveLength(600);
  });

  it("заголовку не верим: заниженный в архиве размер не отменяет предел при чтении потоком", async () => {
    const zip = new JSZip();
    zip.file("big.xml", "z".repeat(50_000));
    const loaded = await JSZip.loadAsync(await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
    const entry = loaded.file("big.xml") as unknown as { _data: { uncompressedSize: number } };
    entry._data.uncompressedSize = 10; // «лживый» заголовок
    await expect(zipReader(loaded, { entry: 1000 })("big.xml")).rejects.toThrow(/слишком большой/);
  });
});

describe("загрузка архива-бомбы через API", () => {
  let app: Awaited<ReturnType<typeof startApp>>;
  beforeAll(async () => {
    app = await startApp();
  });
  afterAll(() => app.close());

  it("сервер отвечает 400 с пояснением и остаётся работоспособным", async () => {
    const content = (await bombVsdx(30)).toString("base64");
    const r = await app.call("POST", "/diagram-import/new", { format: "vsdx", content, meta: { processName: "Бомба", modelType: "AS-IS", decompositionDepth: 2, notations: ["BPMN"] } });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/слишком большой после распаковки/);
    expect((await app.call("GET", "/sessions")).status).toBe(200);
  });
});
