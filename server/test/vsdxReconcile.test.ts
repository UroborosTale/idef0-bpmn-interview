import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { buildVsdx } from "../src/export/vsdx.js";
import { parseVsdx, reconcileVsdxEdit } from "../src/pipeline/vsdxImport.js";
import { structuredModel } from "./fixtures.js";

/** Правка файла так, как её делает Visio: меняется содержимое страницы внутри пакета. */
async function edit(buf: Buffer, page: number, fn: (xml: string) => string): Promise<Buffer> {
  const zip = await JSZip.loadAsync(buf);
  const name = `visio/pages/page${page}.xml`;
  zip.file(name, fn(await zip.file(name)!.async("string")), { createFolders: false });
  return zip.generateAsync({ type: "nodebuffer" });
}

/** Номер страницы файла по её названию. */
async function pageNo(buf: Buffer, title: string): Promise<number> {
  const xml = await (await JSZip.loadAsync(buf)).file("visio/pages/pages.xml")!.async("string");
  const names = [...xml.matchAll(/<Page ID="\d+" NameU="([^"]+)"/g)].map((m) => m[1]);
  const i = names.indexOf(title);
  if (i < 0) throw new Error(`нет страницы ${title}: ${names.join(", ")}`);
  return i + 1;
}

describe("правки из Visio в существующую модель", () => {
  it("файл без правок ничего не меняет", async () => {
    const m = structuredModel();
    const parsed = await parseVsdx(await buildVsdx(m));
    const { model, changes } = reconcileVsdxEdit(m, parsed);
    expect(changes).toEqual({ renamed: [], added: [], addedFlows: [], flowsRenamed: [], missing: [], missingFlows: [] });
    expect(model.nodes.map((n) => n.name)).toEqual(m.nodes.map((n) => n.name));
    expect(model.flows).toHaveLength(m.flows.length);
  });

  it("переименование шага и условия стрелки в Visio возвращается в модель; метка pm_n больше не перекрывает текст", async () => {
    const m = structuredModel();
    const buf = await buildVsdx(m);
    const task = m.nodes.find((n) => n.bpmn_scope === "o1" && n.type === "task")!;
    const page = await pageNo(buf, "BPMN B002.01.01");
    const edited = await edit(buf, page, (xml) => xml.replace(`<Text>${task.name}</Text>`, "<Text>Новое название из Visio</Text>"));
    const { model, changes } = reconcileVsdxEdit(m, await parseVsdx(edited));
    expect(changes.renamed).toEqual([{ nodeId: task.id, from: task.name, to: "Новое название из Visio" }]);
    expect(model.nodes.find((n) => n.id === task.id)!.name).toBe("Новое название из Visio");
    expect(model.nodes.find((n) => n.id === task.id)!.tags).toContain("edited_externally");
    expect(m.nodes.find((n) => n.id === task.id)!.name).toBe(task.name); // исходная модель не тронута
  });

  it("удалённая в Visio фигура только перечисляется, модель не теряет шаг", async () => {
    const m = structuredModel();
    const buf = await buildVsdx(m);
    const task = m.nodes.find((n) => n.bpmn_scope === "o1" && n.type === "task")!;
    const page = await pageNo(buf, "BPMN B002.01.01");
    const edited = await edit(buf, page, (xml) => {
      // вырезаем фигуру шага: от начала <Shape> до его конца, по метке pm_id
      const at = xml.indexOf(`<Row N="pm_id"><Cell N="Value" V="${task.id}"`);
      expect(at).toBeGreaterThan(0);
      const from = xml.lastIndexOf("<Shape ID=", at);
      return xml.slice(0, from) + xml.slice(xml.indexOf("</Shape>", at) + "</Shape>".length);
    });
    const { model, changes } = reconcileVsdxEdit(m, await parseVsdx(edited));
    expect(changes.missing).toContain(task.id);
    expect(model.nodes.some((n) => n.id === task.id)).toBe(true);
  });
});
