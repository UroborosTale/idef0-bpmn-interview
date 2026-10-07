import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { buildVsdx } from "../src/export/vsdx.js";
import { branchingModel, purchaseModel } from "./fixtures.js";

async function open(model = branchingModel()) {
  const zip = await JSZip.loadAsync(await buildVsdx(model));
  const text = (name: string) => zip.file(name)!.async("string");
  return { zip, text };
}

describe("экспорт в VSDX", () => {
  it("пакет содержит обязательные части и страницу на каждую диаграмму", async () => {
    const { zip, text } = await open(purchaseModel());
    for (const part of ["[Content_Types].xml", "_rels/.rels", "visio/document.xml", "visio/windows.xml", "visio/pages/pages.xml"]) expect(zip.file(part), part).toBeTruthy();
    const pages = await text("visio/pages/pages.xml");
    expect([...pages.matchAll(/<Page ID="\d+" NameU="([^"]+)"/g)].map((m) => m[1])).toEqual(["BPMN", "IDEF0 A-0", "IDEF0 A0", "IDEF0 A2"]);
  });

  it("стрелки — соединители, приклеенные к фигурам", async () => {
    const { text } = await open();
    const bpmn = await text("visio/pages/page1.xml");
    const connectors = [...bpmn.matchAll(/NameU="Connector\.\d+"/g)].length;
    expect(connectors).toBeGreaterThanOrEqual(7);
    expect([...bpmn.matchAll(/<Connect FromSheet=/g)].length).toBe(connectors * 2);
  });

  it("страницы — корректный XML с экранированием текста", async () => {
    const m = branchingModel();
    m.nodes[1].name = "Проверить <договор> & «приложения»";
    const { zip } = await open(m);
    const { XMLParser } = await import("fast-xml-parser");
    for (const f of Object.keys(zip.files).filter((n) => n.endsWith(".xml") || n.endsWith(".rels"))) {
      const xml = await zip.file(f)!.async("string");
      expect(new XMLParser({ ignoreAttributes: false }).parse(xml), f).toBeTruthy();
    }
  });
});
