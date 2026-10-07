import { describe, expect, it } from "vitest";
import { entryHistory } from "../src/pipeline/entryHistory.js";
import { carryOverManualEdits } from "../src/pipeline/carryOver.js";
import { ProcessLogicModel } from "../src/types/model.js";
import { purchaseModel } from "./fixtures.js";

const snap = (seq: number, model: ProcessLogicModel) => ({ seq, version: `0.${seq}`, ts: `2026-01-0${seq}T10:00:00Z`, author: "аналитик", note: `снимок ${seq}`, model });

describe("история записи справочника", () => {
  it("появление, правки полей и удаление", () => {
    const v1 = purchaseModel();
    const v2 = structuredClone(v1);
    v2.roles[0].name = "Заявитель";
    v2.roles[0].owner = "Отдел закупок";
    const v3 = structuredClone(v2);
    v3.roles = v3.roles.slice(1);
    const nothing = structuredClone(v1);
    nothing.roles = [];

    const h = entryHistory([snap(1, nothing), snap(2, v1), snap(3, v2), snap(4, v2), snap(5, v3)], "roles", "r1");
    expect(h.map((e) => [e.seq, e.event])).toEqual([[2, "created"], [3, "changed"], [5, "removed"]]);
    expect(h[1].changes).toEqual([
      { field: "name", from: "Инициатор", to: "Заявитель" },
      { field: "owner", from: null, to: "Отдел закупок" },
    ]);
  });

  it("исполнитель шага показывается названием роли той версии", () => {
    const v1 = purchaseModel();
    const v2 = structuredClone(v1);
    v2.nodes[0].role_id = "r2";
    const h = entryHistory([snap(1, v1), snap(2, v2)], "node", "a");
    expect(h[1].changes).toEqual([{ field: "role_id", from: "Инициатор", to: "Бухгалтер" }]);
  });

  it("описание и ответственный сохраняются при повторной обработке текста", () => {
    const prev = purchaseModel();
    prev.systems[0].description = "Учётная система";
    prev.systems[0].owner = "ИТ";
    prev.nodes.forEach((n) => (n.source = [{ fragment_id: "f1", quote: "q" }]));
    const next = purchaseModel();
    const { model } = carryOverManualEdits(prev, next);
    expect(model.systems.find((s) => s.name === "1С")).toMatchObject({ description: "Учётная система", owner: "ИТ" });
  });
});
