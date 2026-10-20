import { describe, expect, it } from "vitest";
import { mockExtractChunk } from "../src/llm/mockProvider.js";

/**
 * B1 из отчёта 19.10: офлайн-извлечение давало роли-мусор («Служба и», «Отдел при», «Hr») и
 * шаблонные повторяющиеся имена («проверить данные») вместо объекта из фразы.
 */
const ctx = { processName: "Найм", modelType: "AS-IS" as const };
const frag = (id: string, text: string) => [{ id, speaker: "owner", text }];

describe("офлайн-извлечение (B1)", () => {
  it("не берёт служебные слова и глаголы в названия ролей, сохраняет HR-менеджера", () => {
    const out = mockExtractChunk(
      frag("f1", "Служба и отдел при проверке. Служба проверяют документы. HR-менеджер организует подбор кандидатов."),
      ctx
    );
    const names = out.roles.map((r) => r.name);
    expect(names).not.toContain("Служба и");
    expect(names).not.toContain("Отдел при");
    expect(names).not.toContain("Служба проверяют");
    expect(names).not.toContain("Hr");
    expect(names).toContain("HR-менеджер");
  });

  it("имя шага берёт объект из фразы, а повтор того же действия не дублируется", () => {
    const out = mockExtractChunk(
      [...frag("f1", "Охранник проверяет комплектность заявки."), ...frag("f2", "Охранник проверяет комплектность заявки.")],
      ctx
    );
    expect(out.nodes).toHaveLength(1);
    expect(out.nodes[0].name).toBe("Проверить комплектность заявки");
  });
});
