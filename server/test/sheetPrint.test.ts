import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApp } from "./api.js";
import { cleanSheetSvg, sheetPrintHtml, sheetPrintSetup } from "../src/shared/sheetPrint.js";
import { bpmnFrameShown, frameShown } from "../src/shared/idef0Frame.js";

delete process.env.AUTH_USERS;

let app: Awaited<ReturnType<typeof startApp>>;
let id = "";
beforeAll(async () => {
  app = await startApp();
  id = (await app.call("POST", "/sessions/blank", { meta: { processName: "Лист BPMN" } })).body.id;
}, 60_000);
afterAll(() => app?.close());

const SHEET = '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800"><g data-frame=""><rect x="0" y="0" width="1100" height="760" fill="none" stroke="#000"/></g></svg>';

describe("печать листа по рисунку с экрана", () => {
  it("рамка листа: у IDEF0 показана по умолчанию, у BPMN — скрыта", () => {
    expect(frameShown(undefined)).toBe(true);
    expect(bpmnFrameShown(undefined)).toBe(false);
    expect(bpmnFrameShown({ show: true })).toBe(true);
  });

  it("бумага: явная, иначе формат листа, заданного вручную, иначе A4 по пропорциям рисунка", () => {
    expect(sheetPrintSetup(undefined, { w: 1200, h: 800 }, {})).toEqual({ paper: "A4", orientation: "landscape" });
    expect(sheetPrintSetup(undefined, { w: 800, h: 1200 }, {})).toEqual({ paper: "A4", orientation: "portrait" });
    expect(sheetPrintSetup({ w: 1580, h: 1080 }, { w: 1, h: 1 }, {})).toEqual({ paper: "A3", orientation: "landscape" });
    expect(sheetPrintSetup({ w: 1580, h: 1080 }, { w: 1, h: 1 }, { paper: "A2", orientation: "portrait" })).toEqual({ paper: "A2", orientation: "portrait" });
  });

  it("страница печати: @page и лист растянут с сохранением пропорций; название экранируется", () => {
    const html = sheetPrintHtml(SHEET, "Закупка <A&B>", "A3", "portrait");
    expect(html).toContain("@page { size: A3 portrait; margin: 0; }");
    expect(html).toContain("width: 297mm; height: 420mm;");
    expect(html).toMatch(/<svg[^>]*width="100%" height="100%" preserveAspectRatio="xMidYMid meet"/);
    expect(html).toContain("Закупка &lt;A&amp;B&gt;");
  });

  it("присланный рисунок очищается: без сценариев, обработчиков, вставок HTML и внешних ссылок; не SVG — отказ", () => {
    const dirty =
      '<?xml version="1.0"?><svg width="10" height="10"><script>alert(1)</script><foreignObject><div>x</div></foreignObject>' +
      '<rect onclick="alert(1)" onload=\'x()\' width="5" height="5" marker-end="url(#arrow)"/><image href="http://169.254.169.254/x"/>' +
      '<a href="https://example.com"><text>t</text></a><use xlink:href="file:///etc/passwd"/></svg>';
    const clean = cleanSheetSvg(dirty)!;
    expect(clean.startsWith("<svg")).toBe(true);
    for (const bad of ["script", "foreignObject", "onclick", "onload", "169.254", "example.com", "file://", "<image", "<use"]) expect(clean).not.toContain(bad);
    expect(clean).toContain('marker-end="url(#arrow)"'); // внутренние ссылки рисунка остаются
    expect(cleanSheetSvg("<html><body>нет</body></html>")).toBeNull();
    expect(cleanSheetSvg("<svg><rect/>")).toBeNull();
  });

  it("маршрут: проверка тела, PDF листа (или понятный отказ без Chromium)", async () => {
    const url = `/sessions/${id}/export/sheet.pdf`;
    expect((await app.call("POST", url, { svg: "<html/>", paper: "A4", orientation: "landscape" })).status).toBe(400);
    expect((await app.call("POST", url, { svg: SHEET, paper: "A0", orientation: "landscape" })).status).toBe(400);
    expect((await app.call("POST", url, { svg: SHEET, paper: "A4", orientation: "diagonal" })).status).toBe(400);
    expect((await app.call("POST", `/sessions/нет-такой/export/sheet.pdf`, { svg: SHEET, paper: "A4", orientation: "landscape" })).status).toBe(404);
    const pdf = await app.call("POST", url, { svg: SHEET, title: "Схема процесса", paper: "A4", orientation: "landscape" });
    expect([200, 501]).toContain(pdf.status);
    if (pdf.status === 200) expect(String(pdf.body).startsWith("%PDF-")).toBe(true);
  }, 120_000);
});
