import { describe, expect, it } from "vitest";
import { frameGeometry, frameTexts, withFrameHeight } from "../src/shared/idef0Frame.js";
import { generateIdef0 } from "../src/pipeline/idef0.js";
import { purchaseModel } from "./fixtures.js";

describe("рамка листа IDEF0", () => {
  const defaults = { node: "A0", title: "Закупка", no: "1.0" };

  it("штамп: подписи NODE / TITLE / NO. и автоматические значения; ручные надписи перекрывают, пустые — нет", () => {
    expect(frameTexts(undefined, defaults)).toEqual({ nodeLabel: "NODE:", node: "A0", titleLabel: "TITLE:", title: "Закупка", noLabel: "NO.:", no: "1.0" });
    expect(frameTexts({ texts: { title: "Моё название", nodeLabel: "УЗЕЛ:", no: "  " } }, defaults)).toMatchObject({ title: "Моё название", nodeLabel: "УЗЕЛ:", no: "1.0" });
  });

  it("лист округляется до клетки, штамп добавляется снизу, ячейки идут слева направо", () => {
    const g = frameGeometry({ w: 905, h: 431 }, undefined, defaults);
    expect(g.sheet).toEqual({ x: 0, y: 0, w: 920, h: 440 + 30 });
    expect(g.footer.y).toBe(440);
    expect(g.gridXs.length).toBeGreaterThan(40);
    expect(g.cells.map((c) => c.field)).toEqual(["nodeLabel", "node", "titleLabel", "title", "noLabel", "no"]);
    const xs = g.cells.map((c) => c.x);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
    expect(g.cells.at(-1)!.x + g.cells.at(-1)!.w).toBe(g.sheet.w);
  });

  it("лист, заданный вручную, стоит где поставили и не зависит от содержимого; сетка и штамп смещаются вместе с ним; пунктира нет", () => {
    const g = frameGeometry({ w: 900, h: 500 }, { x: 100, y: -40, w: 1300, h: 700 }, defaults);
    expect(g.sheet).toEqual({ x: 100, y: -40, w: 1300, h: 730 });
    expect(g.footer).toEqual({ x: 100, y: 660, w: 1300, h: 30 });
    expect(g.gridXs[0].at).toBe(120);
    expect(g.gridYs[0].at).toBe(-20);
    expect(g.cells[0].x).toBe(100);
    expect(g.cells.at(-1)!.x + g.cells.at(-1)!.w).toBe(1400);
    const small = frameGeometry({ w: 900, h: 500 }, { w: 50, h: 60 }, defaults);
    expect([small.sheet.w, small.sheet.h]).toEqual([200, 230]); // меньше минимума не бывает
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
    expect(vh).toBeGreaterThanOrEqual(930); // нижний край штампа 850 (+80 сверху)
    expect(svg).toContain('x="-60" y="-80" width="1400" height="930"');
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
    expect(base.decompositionSvg).toMatch(/stroke="#e3e6eb"/); // клетки
    expect(base.children[0].svg).toContain("A2");

    const m = purchaseModel();
    m.idef0_frames = { "": { grid: false, texts: { title: "Название <лист>", node: "ЛИСТ-1" } } };
    const noGrid = generateIdef0(m).decompositionSvg;
    expect(noGrid).not.toMatch(/stroke="#e3e6eb"/);
    expect(noGrid).toContain("ЛИСТ-1");
    expect(noGrid).toContain("Название &lt;лист&gt;"); // разметка экранируется

    m.idef0_frames = { "": { show: false } };
    const bare = generateIdef0(m).decompositionSvg;
    expect(bare).not.toContain("NODE:");
    expect(bare).toContain("<svg");
  });
});
