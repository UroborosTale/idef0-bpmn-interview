import { describe, expect, it } from "vitest";
import { carryOverManualEdits, keepGapStatuses } from "../src/pipeline/carryOver.js";
import { applyAnsweredGaps } from "../src/pipeline/gaps.js";
import { purchaseModel } from "./fixtures.js";

/**
 * D1/D2 из отчёта 20.10: ответ на пробел пересобирал модель и терял ручное имя и исполнителя,
 * а текст ответа не переживал пересборку.
 */
describe("ответ на пробел и повторная сборка", () => {
  it("сохраняет ручное имя и исполнителя шага, найденного по цитате, а не по новому названию", () => {
    const prev = purchaseModel();
    const old = prev.nodes.find((n) => n.id === "a")!;
    old.name = "Оформить заявку (РУЧНАЯ ПРАВКА)";
    old.role_id = "r2";
    old.source = [{ fragment_id: "f1", quote: "Инициатор оформляет заявку" }];
    const next = purchaseModel();
    const fresh = next.nodes.find((n) => n.id === "a")!;
    fresh.name = "Оформить заявку";
    fresh.role_id = null;
    fresh.source = [{ fragment_id: "f1", quote: "Инициатор оформляет заявку" }];
    const { model } = carryOverManualEdits(prev, next);
    const kept = model.nodes.find((n) => n.source[0]?.quote === "Инициатор оформляет заявку")!;
    expect(kept.name).toBe("Оформить заявку (РУЧНАЯ ПРАВКА)");
    expect(kept.role_id).toBe("r2");
  });

  it("переносит ответ даже при изменившемся имени шага и сразу назначает исполнителя", () => {
    const model = purchaseModel();
    const node = model.nodes.find((n) => n.id === "a")!;
    node.role_id = null;
    model.gaps = [
      {
        id: "g1",
        rule: "missing_executor",
        priority: "critical",
        element_id: "a",
        question: "Кто выполняет действие «Закрыть запрос»?",
        status: "open",
        asked_count: 0,
      },
    ];
    const n = applyAnsweredGaps(model, [{ question: "Кто выполняет действие «Закрыть запрос (РУЧНАЯ ПРАВКА)»?", answerText: "Бухгалтер" }]);
    expect(n).toBe(1);
    expect(model.gaps[0]).toMatchObject({ status: "answered", answer: "Бухгалтер" });
    expect(node.role_id).toBe("r2");
  });

  it("keepGapStatuses сохраняет текст ответа при пересборке", () => {
    const gaps = keepGapStatuses(
      [{ id: "g1", rule: "missing_executor", priority: "critical", element_id: "a", question: "Кто выполняет?", status: "answered", asked_count: 1, answer: "Бухгалтер" }],
      [{ id: "g9", rule: "missing_executor", priority: "critical", element_id: "b", question: "Кто выполняет?", status: "open", asked_count: 0 }]
    );
    expect(gaps[0]).toMatchObject({ status: "answered", answer: "Бухгалтер" });
  });
});
