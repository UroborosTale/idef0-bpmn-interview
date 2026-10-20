import { describe, expect, it } from "vitest";
import { buildRegulation } from "../src/pipeline/regulation.js";
import { isSystemRole } from "../src/pipeline/jobDescription.js";
import { emptyModel } from "../src/types/model.js";

/**
 * B14 из отчёта 19.10: ERP «Закупки» и ELMA365 заведены и системой, и ролью — в «Терминах» они попадали
 * в роли-участники, а для них формировалась должностная инструкция.
 */
function model() {
  const m = emptyModel({ id: "p", name: "Закупки" });
  m.roles.push({ id: "r1", name: "Специалист по закупкам", kind: "internal", source: [] } as never);
  m.roles.push({ id: "r2", name: "ERP «Закупки»", kind: "internal", source: [] } as never);
  m.systems.push({ id: "s1", name: "ERP «Закупки»", source: [] } as never);
  return m;
}

describe("система, заведённая ролью (B14)", () => {
  it("в терминах описана как система, а не как роль-участник", () => {
    const terms = buildRegulation(model()).filter((p) => p.section === "terms");
    expect(terms.some((p) => p.text.startsWith("ERP «Закупки» — информационная система"))).toBe(true);
    expect(terms.some((p) => p.text.startsWith("ERP") && p.text.includes("роль-участник"))).toBe(false);
    expect(terms.some((p) => p.text.startsWith("Специалист по закупкам —"))).toBe(true);
  });

  it("для системы должностная инструкция не формируется", () => {
    expect(isSystemRole(model(), "r2")).toBe(true);
    expect(isSystemRole(model(), "r1")).toBe(false);
  });
});
