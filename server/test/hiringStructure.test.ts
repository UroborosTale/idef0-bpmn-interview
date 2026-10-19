import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fragmentText } from "../src/pipeline/fragment.js";
import type { ExtractionChunkResult, LLMProvider } from "../src/llm/types.js";
import type { ProcessNode } from "../src/types/model.js";

/**
 * Регрессия сборки структуры из интервью на реальном документе «Приём сотрудника на работу»
 * (13 этапов основного сценария, 12 исключительных сценариев). Извлечение зафиксировано:
 * hiring.extraction.json собран из hiring.table.mjs конвертером build-extraction.mjs (разметка выполнена агентом,
 * а не LLM) — поэтому тест проверяет не качество модели, а конвейер: подпроцессы → операции → шаги диаграмм,
 * связи между операциями и отсутствие пустых блоков. Ожидание из разметки: 4 подпроцесса, 13 операций, 59 шагов.
 */
const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "hiring");
const empty: ExtractionChunkResult = { roles: [], systems: [], data: [], controls: [], operations: [], subprocesses: [], nodes: [], flows: [], statements: [], process_hints: {} };

function fixtureProvider(result: ExtractionChunkResult): LLMProvider {
  let calls = 0;
  return { name: "fixture", extractChunk: async () => (calls++ === 0 ? result : empty) };
}

describe("структура из интервью: приём сотрудника на работу", () => {
  it("даёт 4 подпроцесса, 13 операций и 59 шагов, без пустых блоков и межоперационных связей между шагами", async () => {
    process.env.PM_CHUNK_SIZE = "1000"; // документ целиком одной частью — как в фиксированной разметке
    const { extractModel } = await import("../src/pipeline/extract.js");
    const text = fs.readFileSync(path.join(fixtureDir, "hiring.md"), "utf-8");
    const extraction = JSON.parse(fs.readFileSync(path.join(fixtureDir, "hiring.extraction.json"), "utf-8")) as ExtractionChunkResult;
    const model = await extractModel(fragmentText(text), fixtureProvider(extraction), {
      processId: "test_hiring",
      processName: "Приём сотрудника на работу",
      modelType: "AS-IS",
      decompositionDepth: 2,
    });

    const isFn = (n: ProcessNode) => (n.type === "task" || n.type === "subprocess") && !n.bpmn_scope;
    const subs = model.nodes.filter((n) => isFn(n) && !n.idef0_parent);
    const ops = model.nodes.filter((n) => isFn(n) && !!n.idef0_parent);
    const steps = model.nodes.filter((n) => n.bpmn_scope);

    expect(subs.map((n) => n.name)).toEqual([
      "Инициирование и согласование вакансии",
      "Подбор кандидатов",
      "Отбор и принятие решения",
      "Оформление и выход на работу",
    ]);
    expect(ops).toHaveLength(13);
    expect(steps).toHaveLength(59);

    for (const op of ops) expect(steps.filter((s) => s.bpmn_scope === op.id).length, `операция «${op.name}» без шагов`).toBeGreaterThan(0);
    for (const sub of subs) expect(ops.filter((o) => o.idef0_parent === sub.id).length, `подпроцесс «${sub.name}» мельче двух операций`).toBeGreaterThanOrEqual(2);
    // на общей схеме остаются только подпроцессы: все шаги разошлись по диаграммам операций
    expect(model.nodes.filter((n) => !n.bpmn_scope && !isFn(n))).toEqual([]);

    // переходы этапов перенесены на уровень операций, прямых связей между шагами разных операций нет
    const opIds = new Set(ops.map((o) => o.id));
    expect(model.flows.filter((f) => opIds.has(f.from) && opIds.has(f.to)).length).toBeGreaterThanOrEqual(10);
    const scopeOf = new Map(steps.map((s) => [s.id, s.bpmn_scope as string] as const));
    expect(model.flows.filter((f) => scopeOf.has(f.from) && scopeOf.has(f.to) && scopeOf.get(f.from) !== scopeOf.get(f.to))).toEqual([]);

    // ветвления сохранены: шлюзы с исходами и условия на связях
    expect(model.nodes.filter((n) => n.type === "gateway").length).toBeGreaterThanOrEqual(5);
    expect(model.flows.filter((f) => f.condition).length).toBeGreaterThanOrEqual(10);
    expect(model.data.length).toBeGreaterThanOrEqual(10);
  });
});
