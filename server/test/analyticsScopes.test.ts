import { describe, expect, it } from "vitest";
import { analyzeBottlenecks } from "../src/pipeline/analytics.js";
import { ProcessLogicModel } from "../src/types/model.js";

/** B11 из отчёта 20.10: главный путь процесса не должен подменяться путём внутри одной операции. */
describe("аналитика по верхнему уровню процесса", () => {
  it("не берёт шаги операции за основной путь и не показывает шлюзы", () => {
    const model = ProcessLogicModel.parse({
      process: { id: "p", name: "Демо" },
      nodes: [
        { id: "start", type: "event", subtype: "start", name: "Начало" },
        { id: "op", type: "subprocess", name: "Обработать заявку" },
        { id: "end", type: "event", subtype: "end", name: "Конец" },
        { id: "os", type: "event", subtype: "start", name: "Начало операции", bpmn_scope: "op" },
        { id: "step", type: "task", name: "Проверить данные", bpmn_scope: "op", time_processing: "2 ч" },
        { id: "g", type: "gateway", subtype: "exclusive", name: "Данные верны?", bpmn_scope: "op" },
        { id: "oe", type: "event", subtype: "end", name: "Конец операции", bpmn_scope: "op" },
      ],
      flows: [
        { id: "f1", from: "start", to: "op" },
        { id: "f2", from: "op", to: "end" },
        { id: "f3", from: "os", to: "step" },
        { id: "f4", from: "step", to: "g" },
        { id: "f5", from: "g", to: "oe" },
      ],
    });
    const report = analyzeBottlenecks(model);
    expect(report.mainPath?.nodeNames).toEqual(["Начало", "Обработать заявку", "Конец"]);
    expect(report.mainPath?.nodeNames).not.toContain("Проверить данные");
    expect(report.mainPath?.nodeNames).not.toContain("Данные верны?");
  });
});
