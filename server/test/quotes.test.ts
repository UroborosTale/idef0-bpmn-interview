import { describe, expect, it } from "vitest";
import { quoted } from "../src/shared/quote.js";
import { buildJobDescription } from "../src/pipeline/jobDescription.js";
import { ProcessLogicModel } from "../src/types/model.js";

describe("вложенные кавычки", () => {
  it("внутри «ёлочек» — „лапки“, без двойных закрывающих", () => {
    expect(quoted("ООО «РУ КМЗ»")).toBe("«ООО „РУ КМЗ“»");
    expect(quoted("без кавычек")).toBe("«без кавычек»");
  });

  it("должностная инструкция не даёт «…»» на вложенном названии", () => {
    const model = ProcessLogicModel.parse({
      process: { id: "p", name: "Организация «РУ КМЗ»" },
      roles: [{ id: "r1", name: "Руководитель «Смены»" }],
      nodes: [{ id: "t1", type: "task", name: "Проверить заявку", role_id: "r1" }],
    });
    const text = buildJobDescription(model, "r1").map((p) => p.text).join(" ");
    expect(text).toContain("«Организация „РУ КМЗ“»");
    expect(text).toContain("«Руководитель „Смены“»");
    expect(text).not.toContain("»»");
  });
});
