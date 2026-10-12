import { describe, expect, it } from "vitest";
import { frameGeometry, frameTexts } from "../src/shared/idef0Frame.js";
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

  it("размер листа можно задать вручную, но меньше содержимого он не бывает; пунктира нет", () => {
    const g = frameGeometry({ w: 900, h: 500 }, { w: 1300, h: 700 }, defaults);
    expect(g.sheet).toEqual({ x: 0, y: 0, w: 1300, h: 730 });
    expect(g.footer.y).toBe(700);
    const small = frameGeometry({ w: 900, h: 500 }, { w: 300, h: 300 }, defaults);
    expect(small.sheet).toEqual({ x: 0, y: 0, w: 900, h: 530 });
    expect("guideX" in g).toBe(false);
    expect(generateIdef0(purchaseModel()).decompositionSvg).not.toContain("stroke-dasharray");
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
