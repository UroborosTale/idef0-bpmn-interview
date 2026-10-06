import { describe, expect, it } from "vitest";
import { fragmentText } from "../src/pipeline/fragment.js";
import { runPipeline } from "../src/pipeline/run.js";
import { MockProvider } from "../src/llm/provider.js";

const INTERVIEW = `Аналитик: Как начинается процесс?
Владелец: Менеджер получает заявку от клиента по почте и регистрирует её в CRM.
Аналитик: Что дальше?
Владелец: Юрист проверяет договор на соответствие шаблону. Если есть замечания, юрист возвращает договор менеджеру на доработку.
Владелец: Если замечаний нет, финансовый директор согласовывает договор, после чего менеджер подписывает договор с клиентом.
Владелец: Бухгалтер регистрирует договор в 1С.`;

describe("конвейер на офлайн-провайдере", () => {
  it("строит модель, диаграммы и проверки из текста", async () => {
    const fragments = fragmentText(INTERVIEW);
    expect(fragments.length).toBe(6);
    const out = await runPipeline("p1", fragments, { processName: "Согласование договора", modelType: "AS-IS", decompositionDepth: 2, notations: ["IDEF0", "BPMN"] }, { provider: new MockProvider() });
    expect(out.model.nodes.length).toBeGreaterThan(2);
    expect(out.model.roles.length).toBeGreaterThan(0);
    expect(out.bpmnXml).toContain("bpmn:definitions");
    expect(out.idef0.decompositionSvg).toContain("<svg");
    // у каждого извлечённого шага есть ссылка на фрагмент текста
    const ids = new Set(fragments.map((f) => f.id));
    for (const n of out.model.nodes) for (const s of n.source) expect(ids.has(s.fragment_id)).toBe(true);
  });
});
