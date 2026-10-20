import { describe, expect, it } from "vitest";
import { buildRaci } from "../src/pipeline/raci.js";
import { emptyModel } from "../src/types/model.js";
import { b002Model } from "../src/reference/b002.js";
import { c025Model } from "../src/reference/c025.js";

/**
 * A10 из отчёта 19.10: автопостроение RACI не оставляло без ответственного подпроцессы верхнего уровня —
 * на модели без ошибок появлялись две ошибки «не имеет ответственного (A)».
 */
describe("автопостроение RACI", () => {
  for (const [name, build] of [["B002", b002Model], ["C025", c025Model]] as const) {
    it(`${name}: у каждой функции и подпроцесса есть A (в том числе у подпроцесса без своей роли)`, () => {
      const model = build();
      const raci = buildRaci(model);
      const hasA = new Set(raci.filter((r) => r.type === "A").map((r) => r.node_id));
      const functions = model.nodes.filter((n) => n.type === "task" || n.type === "subprocess");
      const missing = functions.filter((n) => !hasA.has(n.id)).map((n) => n.name);
      expect(missing).toEqual([]);
    });
  }

  it("роль подпроцесса берётся из декомпозиции, если у него своей нет", () => {
    const model = emptyModel({ id: "p", name: "Процесс" });
    model.roles.push({ id: "r1", name: "Специалист" } as never);
    model.nodes.push({ id: "sp", type: "subprocess", name: "Подпроцесс", source: [], status: "confirmed", confidence: 1 } as never);
    model.nodes.push({ id: "t1", type: "task", name: "Шаг", role_id: "r1", idef0_parent: "sp", source: [], status: "confirmed", confidence: 1 } as never);
    const raci = buildRaci(model);
    expect(raci.some((r) => r.node_id === "sp" && r.type === "R" && r.role_id === "r1")).toBe(true);
    expect(raci.some((r) => r.node_id === "sp" && r.type === "A")).toBe(true);
  });
});