import { describe, expect, it } from "vitest";
import { purchaseModel } from "../../test/fixtures";
import { buildIdef0 } from "../idef0-editor/geometry";
import { deleteNode } from "../bpmn-editor/model-ops";
import { arrowEntry, selectionExists } from "./selection";
import { bpmnDoc, dictDoc, docIsStale, docTitle, idef0Doc, reportDoc } from "./docs";

describe("выделение в студии", () => {
  it("существует, пока объект есть в модели", () => {
    const m = purchaseModel();
    expect(selectionExists(m, null)).toBe(false);
    expect(selectionExists(m, { kind: "node", id: "b1" })).toBe(true);
    expect(selectionExists(m, { kind: "flow", id: "f2" })).toBe(true);
    expect(selectionExists(m, { kind: "entry", dict: "systems", id: "s1" })).toBe(true);
    expect(selectionExists(m, { kind: "entry", dict: "kpi", id: "s1" })).toBe(false);
    const gone = deleteNode(m, "b");
    expect(selectionExists(gone, { kind: "node", id: "b1" })).toBe(false); // вложенная функция удалена вместе с родителем
    expect(selectionExists(gone, { kind: "flow", id: "f2" })).toBe(false);
  });

  it("стрелка IDEF0 перестаёт существовать, когда её убрали", async () => {
    const { removeArrow } = await import("../idef0-editor/ops");
    const m = purchaseModel();
    for (const arrow of buildIdef0(m, null).arrows) {
      expect(selectionExists(m, { kind: "arrow", arrow }), arrow.key).toBe(true);
      expect(selectionExists(removeArrow(m, arrow), { kind: "arrow", arrow }), arrow.key).toBe(false);
    }
  });

  it("стрелка IDEF0 ведёт к записи своего справочника", () => {
    const arrows = buildIdef0(purchaseModel(), null).arrows;
    const by = (kind: string) => arrows.find((a) => a.kind === kind)!;
    expect(arrowEntry(by("control"))).toEqual({ dict: "controls", id: "c1" });
    expect(arrowEntry(by("system"))).toEqual({ dict: "systems", id: "s1" });
    expect(arrowEntry(by("role")).dict).toBe("roles");
    expect(arrowEntry(by("link")).dict).toBe("data");
    expect(arrowEntry(by("controlLink"))).toEqual({ dict: "data", id: "d3" });
  });
});

describe("вкладки-документы", () => {
  it("заголовки и ключи", () => {
    const m = purchaseModel();
    expect(docTitle(bpmnDoc(), m)).toBe("BPMN");
    expect(docTitle(idef0Doc(null), m)).toBe("IDEF0 A0");
    expect(docTitle(idef0Doc("b"), m)).toBe("IDEF0 A2");
    expect(docTitle(dictDoc("risks"), m)).toBe("Риски");
    expect(docTitle(reportDoc("raci"), m)).toBe("Матрица RACI");
    expect(idef0Doc("b").key).toBe("idef0:b");
  });

  it("вкладка декомпозиции устаревает, когда функцию удалили", () => {
    const m = purchaseModel();
    expect(docIsStale(idef0Doc("b"), m)).toBe(false);
    expect(docIsStale(idef0Doc("b"), deleteNode(m, "b"))).toBe(true);
    expect(docIsStale(idef0Doc(null), deleteNode(m, "b"))).toBe(false);
  });
});
