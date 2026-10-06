import { describe, expect, it } from "vitest";
import { buildVsdx } from "../src/export/vsdx.js";
import { applyVisio, readVsdx, type VDoc, type VPage, type VShape } from "../src/export/vsdx-import.js";
import { branchingModel, purchaseModel } from "./fixtures.js";

const SID = "sess_test";

async function roundtrip(model = branchingModel()) {
  const doc = await readVsdx(await buildVsdx(model, { pm_session: SID, pm_base: "t0" }));
  return { model, doc };
}
const page = (doc: VDoc, kind: string) => doc.pages.find((p) => p.meta.pm_page === kind)!;
const shapeOf = (p: VPage, k: string, id: string) => p.shapes.find((s) => s.tag.pm_k === k && s.tag.pm_id === id)!;
const nextShapeId = (p: VPage) => Math.max(...p.shapes.map((s) => s.id)) + 1;

describe("VSDX: выгрузка и чтение правок", () => {
  it("страницы, метки и приклейки на месте", async () => {
    const { doc } = await roundtrip(purchaseModel());
    expect(doc.meta.pm_session).toBe(SID);
    expect(doc.pages.map((p) => p.meta.pm_page)).toEqual(["bpmn", "idef0:A-0", "idef0:A0", "idef0:A2"]);
    const bpmn = page(doc, "bpmn");
    const flows = bpmn.shapes.filter((s) => s.tag.pm_k === "flow");
    expect(flows).toHaveLength(2);
    for (const f of flows) expect(bpmn.glue.filter((g) => g.from === f.id)).toHaveLength(2);
  });

  it("файл без правок ничего не меняет", async () => {
    for (const m of [branchingModel(), purchaseModel()]) {
      const { doc } = await roundtrip(m);
      const r = applyVisio(m, doc, SID);
      expect(r.changes).toEqual([]);
      expect(r.model).toEqual(m);
    }
  });

  it("перенос в другую дорожку меняет исполнителя и позицию", async () => {
    const { model, doc } = await roundtrip();
    const p = page(doc, "bpmn");
    const s = shapeOf(p, "node", "t3");
    const lane = p.shapes.find((x) => x.tag.pm_k === "lane" && x.tag.pm_id === "r2")!;
    s.y = lane.y + 40;
    const r = applyVisio(model, doc, SID);
    const t3 = r.model.nodes.find((n) => n.id === "t3")!;
    expect(t3.role_id).toBe("r2");
    expect(t3.layout).toEqual({ x: Math.round(s.x), y: Math.round(s.y) });
  });

  it("переименование, удаление связи, копия фигуры и новый соединитель", async () => {
    const { model, doc } = await roundtrip();
    const p = page(doc, "bpmn");
    shapeOf(p, "node", "t1").text = "Проверить договор юристом";
    const f6 = shapeOf(p, "flow", "f6");
    p.shapes = p.shapes.filter((s) => s !== f6);
    const t4 = shapeOf(p, "node", "t4");
    const copy: VShape = { ...t4, id: nextShapeId(p), text: "отправить счёт", x: t4.x + 150 };
    p.shapes.push(copy);
    const conn: VShape = { ...f6, id: nextShapeId(p), tag: {}, text: "" };
    p.shapes.push(conn);
    p.glue.push({ from: conn.id, end: "begin", to: shapeOf(p, "node", "t3").id }, { from: conn.id, end: "end", to: copy.id });

    const r = applyVisio(model, doc, SID);
    expect(r.model.nodes.find((n) => n.id === "t1")!.name).toBe("Проверить договор юристом");
    expect(r.model.flows.some((f) => f.id === "f6")).toBe(false);
    const added = r.model.nodes.find((n) => n.name === "отправить счёт")!;
    expect(added).toBeDefined();
    expect(added.role_id).toBe("r2");
    expect(r.model.flows.some((f) => f.from === "t3" && f.to === added.id)).toBe(true);

    // повторное чтение того же файла не создаёт дубликатов
    const again = applyVisio(r.model, doc, SID, r.created);
    expect(again.model.nodes).toHaveLength(r.model.nodes.length);
    expect(again.model.flows).toHaveLength(r.model.flows.length);
  });

  it("IDEF0: удаление блока убирает и вложенные функции, удаление стрелки отсоединяет данные", async () => {
    const { model, doc } = await roundtrip(purchaseModel());
    const a0 = page(doc, "idef0:A0");
    a0.shapes = a0.shapes.filter((s) => !(s.tag.pm_k === "fn" && s.tag.pm_id === "b"));
    const ctl = a0.shapes.find((s) => s.tag.pm_a === "control|a|c1")!;
    a0.shapes = a0.shapes.filter((s) => s !== ctl);
    const r = applyVisio(model, doc, SID);
    expect(r.model.nodes.map((n) => n.id).sort()).toEqual(["a", "c"]);
    expect(r.model.nodes.find((n) => n.id === "a")!.controls).toEqual([]);
  });

  it("чужой файл отвергается", async () => {
    const { model, doc } = await roundtrip();
    expect(() => applyVisio(model, doc, "другая")).toThrow(/другой сессии/);
    expect(() => applyVisio(model, { ...doc, meta: {} }, SID)).toThrow();
  });
});
