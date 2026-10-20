import { describe, expect, it } from "vitest";
import { buildParaphrase } from "../src/pipeline/verification.js";
import { demoModel } from "../src/reference/demo.js";

/**
 * A12 из отчёта 19.10: пересказ для владельца процесса портили строчные имена систем, заглавные буквы
 * посреди фразы, технические шлюзы в роли шагов и повторяющиеся абзацы.
 */
const texts = () => buildParaphrase(demoModel()).map((p) => p.text);

describe("верификация: пересказ без ошибок текста (A12)", () => {
  it("имена систем сохраняют регистр, шаги не начинаются с заглавной посреди фразы", () => {
    const all = texts();
    expect(all).toContain("Затем ERP «Закупки» проверит комплектность заявки.");
    expect(all.some((t) => /(^|\s)ер[пp]/iu.test(t))).toBe(false);
    expect(all.some((t) => t.startsWith("Сначала инициатор закупки заполнит"))).toBe(true);
    expect(all.some((t) => /Сначала \S+ [А-ЯЁ][а-яё]/.test(t))).toBe(false);
  });

  it("вступление: триггер и цель — со строчной, если это не имя", () => {
    const intro = texts()[0];
    expect(intro).toContain("когда выявлена потребность");
    expect(intro).toContain("цель — обеспечить");
    expect(intro).not.toMatch(/Выявлена|Обеспечить/);
  });

  it("технические шлюзы не называются шагами", () => {
    const all = texts();
    expect(all.some((t) => t.includes("Слияние потоков"))).toBe(false);
    expect(all.some((t) => /шаг «Слияние потоков»/.test(t))).toBe(false);
    expect(all.some((t) => t.startsWith("Дальше шаги идут параллельно: согласовать заявку по потребности, проверить наличие бюджета"))).toBe(true);
    expect(all.some((t) => t.startsWith("Дальше зависит от того, что наступит раньше:"))).toBe(true);
  });

  it("абзацы не повторяются, глаголы согласованы", () => {
    const all = texts();
    expect(new Set(all).size).toBe(all.length);
    expect(all).toContain("После этого специалист по закупкам сравнит предложения и выберет победителя.");
    expect(all.some((t) => /согласовает|подписает|зафиксировает|разослает/.test(t))).toBe(false);
    expect(all.some((t) => t.includes("выполнит шаг «Проведение"))).toBe(true);
  });
});
