import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApp } from "./api.js";
import { REFERENCE_PROCESSES } from "../src/reference/index.js";
import { idef0PrintHtml, printSetup } from "../src/export/idef0Print.js";
import { purchaseModel } from "./fixtures.js";

delete process.env.AUTH_USERS;

let app: Awaited<ReturnType<typeof startApp>>;
let id = "";
let model: any;
beforeAll(async () => {
  app = await startApp();
  const s = (await app.call("POST", "/sessions/blank", { meta: { processName: "Печать листа" } })).body;
  model = REFERENCE_PROCESSES.demo.build();
  expect((await app.call("PUT", `/sessions/${s.id}/model`, model, { "X-Base-Updated-At": s.updatedAt })).status).toBe(200);
  id = s.id;
}, 60_000);
afterAll(() => app?.close());

describe("печать листа IDEF0", () => {
  it("страница печати: бумага и ориентация в @page, лист с рамкой и штампом растянут на страницу с сохранением пропорций", () => {
    const m = purchaseModel();
    const p = idef0PrintHtml(m, "decomposition")!;
    expect(p.paper).toBe("A4");
    expect(p.orientation).toBe("landscape");
    expect(p.html).toContain("@page { size: A4 landscape; margin: 0; }");
    expect(p.html).toContain("NODE:"); // штамп листа
    expect(p.html).toMatch(/<svg[^>]*width="100%" height="100%" preserveAspectRatio="xMidYMid meet"/);
    expect(p.html).toContain("width: 297mm; height: 210mm;"); // альбомный A4
    const portrait = idef0PrintHtml(m, "decomposition", { paper: "A3", orientation: "portrait" })!;
    expect(portrait.html).toContain("@page { size: A3 portrait; margin: 0; }");
    expect(portrait.html).toContain("width: 297mm; height: 420mm;");
  });

  it("бумага и ориентация по умолчанию берутся из формата листа диаграммы", () => {
    const m = purchaseModel();
    m.idef0_frames = { "": { x: 0, y: 0, w: 760, h: 1580 } }; // поле A3 книжное: 760 × 1580? — нет, это нестандартный размер
    expect(printSetup(m, "", "<svg width=\"800\" height=\"1200\">", {})).toEqual({ paper: "A4", orientation: "portrait" }); // нестандартный → A4, ориентация по пропорциям
    m.idef0_frames = { "": { x: 0, y: 0, w: 1580, h: 1080 } };
    expect(printSetup(m, "", "<svg width=\"1\" height=\"1\">", {})).toEqual({ paper: "A3", orientation: "landscape" });
    m.idef0_frames = { "": { x: 0, y: 0, w: 1080, h: 1580 } };
    expect(printSetup(m, "", "<svg width=\"1\" height=\"1\">", {})).toEqual({ paper: "A3", orientation: "portrait" });
    expect(printSetup(m, "", "<svg width=\"1\" height=\"1\">", { paper: "A2" }).paper).toBe("A2"); // явный выбор сильнее
  });

  it("маршруты: страница печати по коду диаграммы, проверка параметров, неизвестная диаграмма, PDF (или понятный отказ без Chromium)", async () => {
    const ok = await app.call("GET", `/sessions/${id}/export/idef0/decomposition.print.html?paper=A3`);
    expect(ok.status).toBe(200);
    expect(String(ok.body)).toContain("@page { size: A3 landscape; margin: 0; }");
    const child = (await app.call("GET", `/sessions/${id}/export/idef0/context.print.html`)).status;
    expect(child).toBe(200);
    expect((await app.call("GET", `/sessions/${id}/export/idef0/decomposition.print.html?paper=A0`)).status).toBe(400);
    expect((await app.call("GET", `/sessions/${id}/export/idef0/decomposition.print.html?orientation=diagonal`)).status).toBe(400);
    expect((await app.call("GET", `/sessions/${id}/export/idef0/нет-такой.print.html`)).status).toBe(404);
    expect((await app.call("GET", `/sessions/${id}/export/idef0/нет-такой.pdf`)).status).toBe(404);
    const pdf = await app.raw(`/sessions/${id}/export/idef0/decomposition.pdf?paper=A4`);
    expect([200, 501]).toContain(pdf.status);
    if (pdf.status === 200) {
      expect(pdf.body.subarray(0, 5).toString()).toBe("%PDF-");
      const text = pdf.body.toString("latin1");
      expect((text.match(/\/Type\s*\/Page[^s]/g) ?? []).length).toBe(1); // лист целиком на одной странице
      expect(/\/MediaBox\s*\[0 0 841\.9\d* 59[45]\.\d+\]/.test(text)).toBe(true); // A4 альбомная
    }
  }, 120_000);
});
