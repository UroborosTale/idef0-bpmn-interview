import { describe, expect, it } from "vitest";
import { frameGeometry, frameTexts, withFrameHeight, FRAME_H } from "../src/shared/idef0Frame.js";
import { generateIdef0 } from "../src/pipeline/idef0.js";
import { purchaseModel } from "./fixtures.js";
import type { ProcessLogicModel } from "../src/types/model.js";

describe("рамка листа IDEF0", () => {
  const defaults = { node: "A0", title: "Закупка", no: "1.0" };

  it("штамп: подписи NODE / TITLE / NO. и автоматические значения; ручные надписи перекрывают, пустые — нет", () => {
    expect(frameTexts(undefined, defaults)).toEqual({ nodeLabel: "NODE:", node: "A0", titleLabel: "TITLE:", title: "Закупка", noLabel: "NO.:", no: "1.0" });
    expect(frameTexts({ texts: { title: "Моё название", nodeLabel: "УЗЕЛ:", no: "  " } }, defaults)).toMatchObject({ title: "Моё название", nodeLabel: "УЗЕЛ:", no: "1.0" });
  });

  it("лист округляется до клетки, штамп добавляется снизу, ячейки идут слева направо", () => {
    const g = frameGeometry({ w: 905, h: 431 }, undefined, defaults);
    expect(g.sheet).toEqual({ x: 0, y: 0, w: 920, h: 440 + FRAME_H });
    expect(g.footer.y).toBe(440);
    expect(g.gridXs.length).toBeGreaterThan(40); // клетки по 20 px (5 мм), как у Business Studio
    expect(g.cells.map((c) => c.field)).toEqual(["nodeLabel", "node", "titleLabel", "title", "noLabel", "no"]);
    const xs = g.cells.map((c) => c.x);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
    expect(g.cells.at(-1)!.x + g.cells.at(-1)!.w).toBe(g.sheet.w);
  });

  it("лист, заданный вручную, стоит где поставили и не зависит от содержимого; сетка и штамп смещаются вместе с ним; пунктира нет", () => {
    const g = frameGeometry({ w: 900, h: 500 }, { x: 100, y: -40, w: 1300, h: 700 }, defaults);
    expect(g.sheet).toEqual({ x: 100, y: -40, w: 1300, h: 700 + FRAME_H });
    expect(g.footer).toEqual({ x: 100, y: 660, w: 1300, h: FRAME_H });
    expect(g.gridXs[0].at).toBe(120);
    expect(g.gridYs[0].at).toBe(-20);
    expect(g.cells[0].x).toBe(100);
    expect(g.cells.at(-1)!.x + g.cells.at(-1)!.w).toBe(1400);
    const small = frameGeometry({ w: 900, h: 500 }, { w: 50, h: 60 }, defaults);
    expect([small.sheet.w, small.sheet.h]).toEqual([440, 200 + FRAME_H]); // меньше минимума не бывает: по ширине помещается штамп
    for (const c of small.cells) expect(c.w).toBeGreaterThan(0); // ячейки штампа не схлопываются и не налезают
    expect([...small.cells].every((c, i, a) => i === 0 || c.x >= a[i - 1].x + a[i - 1].w - 0.5)).toBe(true);
    expect("guideX" in g).toBe(false);
    expect(withFrameHeight({ w: 900, h: 500 }, { x: 800, w: 600, h: 400 })).toEqual({ w: 1400, h: 500 }); // «мир» охватывает и диаграмму, и лист
    expect(generateIdef0(purchaseModel()).decompositionSvg).not.toContain("stroke-dasharray");
  });

  it("SVG сдвинутого листа охватывает и лист, и содержимое", () => {
    const m = purchaseModel();
    m.idef0_frames = { "": { x: -60, y: -80, w: 1400, h: 900 } };
    const svg = generateIdef0(m).decompositionSvg;
    const [vx, vy, vw, vh] = svg.match(/viewBox="([^"]+)"/)![1].split(" ").map(Number);
    expect([vx, vy]).toEqual([-60, -80]);
    expect(vw).toBeGreaterThanOrEqual(1400); // правый край листа 1340 (+60 слева)
    expect(vh).toBeGreaterThanOrEqual(900 + FRAME_H); // нижний край штампа 832 (+80 сверху)
    expect(svg).toContain(`x="-60" y="-80" width="1400" height="${900 + FRAME_H}"`);
  });

  it("лист с очень далёкими блоками не плодит миллионы линий сетки", () => {
    const g = frameGeometry({ w: 5e8, h: 3e8 }, undefined, defaults);
    expect(g.gridXs.length).toBeLessThanOrEqual(400);
    expect(g.gridYs.length).toBeLessThanOrEqual(400);
  });

  it("SVG выгрузки по умолчанию с рамкой, сеткой и штампом; настройки модели скрывают сетку и рамку и меняют надписи", () => {
    const base = generateIdef0(purchaseModel());
    expect(base.decompositionSvg).toContain("NODE:");
    expect(base.decompositionSvg).toContain("NO.:");
    expect(base.decompositionSvg).toMatch(/stroke="#e4e4e4"/); // клетки
    expect(base.children[0].svg).toContain("A2");

    const m = purchaseModel();
    m.idef0_frames = { "": { grid: false, texts: { title: "Название <лист>", node: "ЛИСТ-1" } } };
    const noGrid = generateIdef0(m).decompositionSvg;
    expect(noGrid).not.toMatch(/stroke="#e4e4e4"/);
    expect(noGrid).toContain("ЛИСТ-1");
    expect(noGrid).toContain("Название &lt;лист&gt;"); // разметка экранируется

    m.idef0_frames = { "": { show: false } };
    const bare = generateIdef0(m).decompositionSvg;
    expect(bare).not.toContain("NODE:");
    expect(bare).toContain("<svg");
  });
});

describe("рамка листа в других выгрузках", () => {
  it("draw.io: рамка и штамп — отдельные ячейки, id узлов PLM остаются только у функций; скрытая рамка не выгружается", async () => {
    const { idef0ToDrawio } = await import("../src/pipeline/idef0.js");
    const m = purchaseModel();
    const xml = idef0ToDrawio(m, generateIdef0(m));
    expect(xml).toContain('id="FRAME_sheet"');
    expect(xml).toContain('id="FRAME_stamp"');
    expect(xml).toContain('id="FRAME_nodeLabel" value="NODE:"');
    expect(xml).toContain('id="FRAME_node" value="A2"'); // страница вложенной диаграммы A2
    expect(xml.match(/id="IDEF0_/g)!.length).toBeGreaterThan(0);
    m.idef0_frames = { "": { show: false }, b: { texts: { title: "Лист <2>" } } };
    const custom = idef0ToDrawio(m, generateIdef0(m));
    expect(custom.match(/id="FRAME_sheet"/g)).toHaveLength(1); // осталась только у диаграммы A2
    expect(custom).toContain('value="Лист &lt;2&gt;"');
  });

  it("VSDX: на страницах IDEF0 есть штамп с надписями, на BPMN нет; рамка есть и при ручном листе; скрытая — убирается", async () => {
    const JSZip = (await import("jszip")).default;
    const { buildVsdx } = await import("../src/export/vsdx.js");
    const pageXml = async (model: ReturnType<typeof purchaseModel>, n: number) => {
      const zip = await JSZip.loadAsync(await buildVsdx(model));
      return zip.file(`visio/pages/page${n}.xml`)!.async("string");
    };
    const m = purchaseModel();
    expect(await pageXml(m, 3)).toContain("NODE:"); // IDEF0 A0
    expect(await pageXml(m, 1)).not.toContain("NODE:"); // BPMN
    m.idef0_frames = { "": { x: 20, y: 20, w: 1200, h: 800, texts: { title: "Мой лист" } } };
    expect(await pageXml(m, 3)).toContain("Мой лист");
    m.idef0_frames = { "": { show: false } };
    expect(await pageXml(m, 3)).not.toContain("NODE:");
  });

  it("VSDX: лист BPMN по умолчанию не выгружается; включённый — штамп с кодом и названием операции, ручной лист растит страницу; при чтении правок лист пропускается", async () => {
    const JSZip = (await import("jszip")).default;
    const { buildVsdx } = await import("../src/export/vsdx.js");
    const { buildModelFromParsedVsdx, parseVsdx } = await import("../src/pipeline/vsdxImport.js");
    const { structuredModel } = await import("./fixtures.js");
    /** Страницы файла по именам: разметка и ширина в дюймах. */
    const pages = async (model: ProcessLogicModel) => {
      const zip = await JSZip.loadAsync(await buildVsdx(model));
      const list = await zip.file("visio/pages/pages.xml")!.async("string");
      const out = new Map<string, { xml: string; width: number }>();
      for (const [i, p] of [...list.matchAll(/<Page ID="\d+" NameU="([^"]+)".*?<Cell N="PageWidth" V="([\d.]+)"/g)].entries()) out.set(p[1], { xml: await zip.file(`visio/pages/page${i + 1}.xml`)!.async("string"), width: Number(p[2]) });
      return out;
    };
    const m = structuredModel();
    const op = "BPMN B002.01.01"; // диаграмма операции o1
    const plain = await pages(m);
    expect([...plain].filter(([, p]) => p.xml.includes("NODE:")).every(([name]) => name.startsWith("IDEF0"))).toBe(true); // штамп только у IDEF0
    expect(plain.get(op)!.xml).not.toContain("NODE:");

    m.bpmn_frames = { o1: { show: true } };
    const framed = await pages(m);
    expect(framed.get(op)!.xml).toContain("NODE:");
    expect(framed.get(op)!.xml).toContain("B002.01.01 Актуализация реестра процессов");
    expect(framed.get("BPMN")!.xml).not.toContain("NODE:"); // у общей схемы лист свой и выключен
    expect(framed.get(op)!.width).toBeGreaterThanOrEqual(plain.get(op)!.width);

    m.bpmn_frames = { o1: { show: true, x: 40, y: 40, w: 2240, h: 1560, texts: { title: "Лист <операции>" } }, "": { show: true } };
    const manual = await pages(m);
    expect(manual.get(op)!.xml).toContain("Лист &lt;операции&gt;");
    expect(manual.get(op)!.width).toBeCloseTo((40 + 2240) / 96, 3);
    expect(manual.get("BPMN")!.xml).toContain("B002.00.00 Управление процессами");

    // лист — оформление: шаги, стрелки и дорожки при чтении файла те же, что без него
    const meta = { processName: "Импорт", modelType: "AS-IS" as const, decompositionDepth: 2, notations: ["IDEF0", "BPMN"] as ("IDEF0" | "BPMN")[] };
    const back = async (model: ProcessLogicModel) => buildModelFromParsedVsdx(await parseVsdx(await buildVsdx(model)), meta).model;
    const [a, b] = [await back(structuredModel()), await back(m)];
    expect(b.nodes.map((n) => n.name).sort()).toEqual(a.nodes.map((n) => n.name).sort());
    expect(b.flows).toHaveLength(a.flows.length);
    expect(b.roles.map((r) => r.name).sort()).toEqual(a.roles.map((r) => r.name).sort());
  });
});
