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

  it("гиперссылки и показ параметров объекта: раздел Hyperlink и подписи вокруг фигуры", async () => {
    const m = branchingModel();
    const task = m.nodes.find((n) => n.type === "task" && n.bpmn_scope !== undefined) ?? m.nodes.find((n) => n.type === "task")!;
    task.hyperlinks = [{ address: "https://example.org/reg", description: "Регламент" }];
    task.duration = "3 дня";
    task.param_display = { p3: { param: "duration", prefix: "Срок ", title: false }, n1: { param: "duration", title: true } };
    const { zip } = await open(m);
    const all = (await Promise.all(Object.keys(zip.files).filter((f) => /^visio\/pages\/page\d+\.xml$/.test(f)).map((f) => zip.file(f)!.async("string")))).join("");
    expect(all).toContain('<Section N="Hyperlink">');
    expect(all).toContain("https://example.org/reg");
    expect(all).toContain("Срок 3 дня");
    expect(all).toContain("Длительность: 3 дня");
  });
});
