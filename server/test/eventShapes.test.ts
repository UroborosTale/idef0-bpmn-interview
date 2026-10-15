import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { buildEventShapesVsdx } from "../src/export/vsdx.js";

describe("фигуры событий для палитры оболочки", () => {
  it("по странице на каждое сочетание положения и типа; на странице одна фигура без меток модели, со значком триггера", async () => {
    const zip = await JSZip.loadAsync(await buildEventShapesVsdx());
    const pagesXml = await zip.file("visio/pages/pages.xml")!.async("string");
    const names = [...pagesXml.matchAll(/<Page [^>]*NameU="([^"]+)"/g)].map((m) => m[1]);
    expect(names).toEqual([
      "start:none", "start:message", "start:timer", "start:conditional", "start:signal", "start:multiple", "start:parallel_multiple",
      "intermediate:none", "intermediate:message", "intermediate:timer", "intermediate:conditional", "intermediate:link", "intermediate:signal", "intermediate:multiple", "intermediate:parallel_multiple",
      "end:none", "end:message", "end:escalation", "end:error", "end:compensation", "end:signal", "end:multiple", "end:terminate",
    ]);
    const files = Object.keys(zip.files).filter((f) => /^visio\/pages\/page\d+\.xml$/.test(f));
    expect(files).toHaveLength(names.length);
    for (const f of files) {
      const xml = await zip.file(f)!.async("string");
      expect(xml.match(/<Shape /g)?.length, f).toBeGreaterThanOrEqual(1); // у залитых значков вторая фигура — заливка (в оболочке группируется)
      expect(xml.match(/<Shape /g)!.length, f).toBeLessThanOrEqual(3);
      expect(xml, f).not.toContain("pm_id"); // меток модели нет: их ставит приём правок
    }
    // у события-таймера в геометрии больше одного пути (круг и значок), у простого начального — один
    const geoCount = async (n: string) => {
      const f = files[names.indexOf(n)];
      return ((await zip.file(f)!.async("string")).match(/<Section N="Geometry"/g) ?? []).length;
    };
    expect(await geoCount("intermediate:timer")).toBeGreaterThan(await geoCount("start:none"));
  });
});

describe("лист-образец значков событий", () => {
  it("строится и содержит все триггеры", async () => {
    const { buildEventIconSheet } = await import("../src/export/vsdx.js");
    const zip = await JSZip.loadAsync(await buildEventIconSheet());
    const xml = await zip.file("visio/pages/page1.xml")!.async("string");
    expect(xml.match(/<Shape /g)!.length).toBeGreaterThan(40);
  });
});
