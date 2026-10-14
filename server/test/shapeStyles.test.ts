import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { buildVsdx } from "../src/export/vsdx.js";
import { DEFAULT_STYLES, ownStyle, styleKindOf, styleOf } from "../src/shared/shapeStyles.js";
import { ProcessLogicModel } from "../src/types/model.js";
import { branchingModel } from "./fixtures.js";

async function pagesXml(m: ProcessLogicModel): Promise<string> {
  const zip = await JSZip.loadAsync(await buildVsdx(m));
  const names = Object.keys(zip.files).filter((n) => /^visio\/pages\/page\d+\.xml$/.test(n));
  return (await Promise.all(names.map((n) => zip.file(n)!.async("string")))).join(" ");
}

describe("оформление фигур по видам", () => {
  it("без стилей — значения по умолчанию; свои значения накладываются, неверные игнорируются", () => {
    expect(styleOf(undefined, "task")).toEqual(DEFAULT_STYLES.task);
    const m = { shape_styles: { task: { fill: "#ffeecc", text: "красный", font_size: 99 }, event_end: { line: "#112233", font_size: 14 } } };
    expect(styleOf(m, "task")).toEqual({ ...DEFAULT_STYLES.task, fill: "#ffeecc" });
    expect(styleOf(m, "event_end")).toEqual({ ...DEFAULT_STYLES.event_end, line: "#112233", font_size: 14 });
    expect(styleOf(m, "gateway")).toEqual(DEFAULT_STYLES.gateway);
    expect(ownStyle(m, "task")).toEqual({ fill: "#ffeecc" });
    expect(ownStyle(undefined, "task")).toEqual({});
  });

  it("вид стиля шага: задача, подпроцесс, шлюз и вид события; граничное — промежуточное", () => {
    expect(styleKindOf({ type: "task" })).toBe("task");
    expect(styleKindOf({ type: "subprocess" })).toBe("subprocess");
    expect(styleKindOf({ type: "gateway", subtype: "parallel" })).toBe("gateway");
    expect(styleKindOf({ type: "event", subtype: "start" })).toBe("event_start");
    expect(styleKindOf({ type: "event", subtype: "end" })).toBe("event_end");
    expect(styleKindOf({ type: "event", subtype: "intermediate" })).toBe("event_intermediate");
    expect(styleKindOf({ type: "event", subtype: "start" }, true)).toBe("event_intermediate");
    expect(styleKindOf({ type: "other" })).toBeNull();
  });

  it("схема модели: стили принимаются, неверный цвет и размер, неизвестный вид — нет", () => {
    const base = JSON.parse(JSON.stringify(branchingModel()));
    expect(ProcessLogicModel.safeParse({ ...base, shape_styles: { task: { fill: "#aabbcc", font_size: 14 } } }).success).toBe(true);
    expect(ProcessLogicModel.safeParse({ ...base, shape_styles: { task: { fill: "красный" } } }).success).toBe(false);
    expect(ProcessLogicModel.safeParse({ ...base, shape_styles: { task: { font_size: 40 } } }).success).toBe(false);
    expect(ProcessLogicModel.safeParse({ ...base, shape_styles: { circle: { fill: "#aabbcc" } } }).success).toBe(false);
    expect(branchingModel().shape_styles).toBeUndefined();
  });

  it("VSDX: цвета вида ложатся на фигуры BPMN и блоки IDEF0, остальные виды не меняются", async () => {
    const plain = await pagesXml(branchingModel());
    expect(plain).not.toContain("#ffeecc");
    const m = branchingModel();
    m.shape_styles = { task: { fill: "#ffeecc", line: "#aa0000", text: "#0000bb", font_size: 15 }, idef0_block: { fill: "#ddeedd" }, event_end: { fill: "#ccddff" } };
    const xml = await pagesXml(m);
    expect(xml).toContain("#ffeecc"); // заливка задач
    expect(xml).toContain("#aa0000"); // линия задач
    expect(xml).toContain("#0000bb"); // цвет текста задач
    expect(xml).toContain("#ddeedd"); // блоки IDEF0
    expect(xml).toContain("#ccddff"); // конечное событие
    // шрифт задач 15 px = 0,15625 дюйма
    expect(xml).toContain(`<Cell N="Size" V="${Math.round(((15 * 0.75) / 72) * 1e5) / 1e5}"/>`);
    // у шлюза и начального события цвета по умолчанию — палитра Business Studio
    expect(xml).toContain("#99ff66");
    expect(xml).toContain("#ffff99");
  });
});
