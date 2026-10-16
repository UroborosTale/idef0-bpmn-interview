import { describe, expect, it } from "vitest";
import { extractModel } from "../src/pipeline/extract.js";
import { scopeView } from "../src/shared/scope.js";
import type { ExtractionChunkResult, LLMProvider } from "../src/llm/types.js";

/**
 * ФТ-3: структура модели из интервью. Раньше все действия становились блоками верхнего уровня (плоская модель),
 * и операции приходилось собирать вручную. Теперь операции из ответа LLM становятся блоками IDEF0, действия
 * с operation_name — шагами диаграммы своей операции (bpmn_scope), а связи между операциями идут на общую схему.
 */

const fragments = [
  { id: "f1", speaker: "owner", text: "Менеджер получает заявку от клиента. Потом менеджер согласует условия с клиентом." },
  { id: "f2", speaker: "owner", text: "Юрист проверяет договор. Затем директор подписывает договор." },
];

const chunk: ExtractionChunkResult = {
  roles: [],
  systems: [],
  data: [],
  controls: [],
  operations: [
    { name: "Обработка заявки", source_fragment_id: "f1", quote: "Менеджер получает заявку от клиента", confidence: 0.8 },
    { name: "Подписание договора", source_fragment_id: "f2", quote: "директор подписывает договор", confidence: 0.8 },
  ],
  nodes: [
    { type: "task", name: "получить заявку", operation_name: "Обработка заявки", order_hint: 1, source_fragment_id: "f1", quote: "Менеджер получает заявку от клиента", confidence: 0.9 },
    { type: "task", name: "согласовать условия", operation_name: "Обработка заявки", order_hint: 2, source_fragment_id: "f1", quote: "согласует условия с клиентом", confidence: 0.9 },
    { type: "task", name: "проверить договор", operation_name: "Подписание договора", order_hint: 3, source_fragment_id: "f2", quote: "Юрист проверяет договор", confidence: 0.9 },
    { type: "task", name: "подписать договор", operation_name: "Подписание договора", order_hint: 4, source_fragment_id: "f2", quote: "директор подписывает договор", confidence: 0.9 },
  ],
  flows: [
    { from_order_hint: 1, to_order_hint: 2, source_fragment_id: "f1", quote: "Менеджер получает заявку от клиента" },
    { from_order_hint: 2, to_order_hint: 3, source_fragment_id: "f2", quote: "Юрист проверяет договор" },
    { from_order_hint: 3, to_order_hint: 4, source_fragment_id: "f2", quote: "директор подписывает договор" },
  ],
  statements: [],
  process_hints: {},
};

const stub = (result: ExtractionChunkResult): LLMProvider => ({ name: "stub", extractChunk: async () => result });

describe("структура модели из интервью", () => {
  it("операции становятся блоками, их действия — диаграммами операций, переход между операциями — на общей схеме", async () => {
    const m = await extractModel(fragments, stub(chunk), { processId: "s1", processName: "Продажа", modelType: "AS-IS" });

    // блоки общей схемы — операции, а не отдельные действия
    const ops = m.nodes.filter((n) => !n.bpmn_scope && (n.type === "task" || n.type === "subprocess"));
    expect(ops.map((n) => n.name)).toEqual(["Обработка заявки", "Подписание договора"]);
    expect(ops[0].idef0_parent).toBeNull();

    // действия принадлежат своим операциям
    const steps = m.nodes.filter((n) => n.bpmn_scope);
    expect(steps).toHaveLength(4);
    expect(steps.filter((s) => s.bpmn_scope === ops[0].id).map((s) => s.name)).toEqual(["получить заявку", "согласовать условия"]);
    expect(steps.filter((s) => s.bpmn_scope === ops[1].id).map((s) => s.name)).toEqual(["проверить договор", "подписать договор"]);

    // связи: внутри операции остались между её шагами, переход между операциями перенесён на уровень операций
    const inner = m.flows.filter((f) => f.source.length > 0 && steps.some((s) => s.id === f.from) && steps.some((s) => s.id === f.to));
    expect(inner).toHaveLength(2);
    expect(m.flows.some((f) => f.from === ops[0].id && f.to === ops[1].id)).toBe(true);
    // между шагами разных операций прямых связей не осталось
    const cross = m.flows.filter((f) => {
      const a = steps.find((s) => s.id === f.from);
      const b = steps.find((s) => s.id === f.to);
      return a && b && a.bpmn_scope !== b.bpmn_scope;
    });
    expect(cross).toEqual([]);

    // виды диаграмм: общая схема — операции, диаграмма операции — только её шаги
    expect(scopeView(m, null).nodes.map((n) => n.name)).toEqual(["Обработка заявки", "Подписание договора"]);
    expect(scopeView(m, ops[0].id).nodes.map((n) => n.name)).toEqual(["получить заявку", "согласовать условия"]);
  });

  it("операция без действий блоком не становится", async () => {
    const ghost: ExtractionChunkResult = {
      ...chunk,
      operations: [...(chunk.operations ?? []), { name: "Итоговый документ", source_fragment_id: "f2", quote: "Юрист проверяет договор", confidence: 0.5 }],
    };
    const m = await extractModel(fragments, stub(ghost), { processId: "s3", processName: "Продажа", modelType: "AS-IS" });
    expect(m.nodes.some((n) => n.name === "Итоговый документ")).toBe(false);
    expect(m.nodes.filter((n) => n.bpmn_scope)).toHaveLength(4);
    expect(m.nodes.filter((n) => !n.bpmn_scope && (n.type === "task" || n.type === "subprocess")).map((n) => n.name)).toEqual(["Обработка заявки", "Подписание договора"]);
  });

  it("глубина декомпозиции 2: операции становятся детьми подпроцесса", async () => {
    const deep: ExtractionChunkResult = {
      ...chunk,
      subprocesses: [{ name: "Оформление заявки", source_fragment_id: "f1", quote: "Менеджер получает заявку от клиента", confidence: 0.8 }],
      operations: (chunk.operations ?? []).map((o) => ({ ...o, subprocess_name: "Оформление заявки" })),
    };
    const m = await extractModel(fragments, stub(deep), { processId: "s4", processName: "Продажа", modelType: "AS-IS", decompositionDepth: 2 });
    const sub = m.nodes.find((n) => n.name === "Оформление заявки")!;
    expect(sub).toBeTruthy();
    expect(sub.idef0_parent).toBeNull();
    expect(m.nodes.filter((n) => !n.bpmn_scope && n.idef0_parent === sub.id).map((n) => n.name)).toEqual(["Обработка заявки", "Подписание договора"]);
    expect(m.nodes.filter((n) => n.bpmn_scope)).toHaveLength(4); // диаграммы операций на месте

    // глубина 1 — подпроцессов нет, операции остаются блоками уровня 0
    const shallow = await extractModel(fragments, stub(deep), { processId: "s5", processName: "Продажа", modelType: "AS-IS", decompositionDepth: 1 });
    expect(shallow.nodes.some((n) => n.name === "Оформление заявки")).toBe(false);
    expect(shallow.nodes.filter((n) => !n.bpmn_scope && n.type === "task").map((n) => n.idef0_parent)).toEqual([null, null]);
  });

  it("без операций модель остаётся плоской, как раньше", async () => {
    const flat: ExtractionChunkResult = { ...chunk, operations: [], nodes: chunk.nodes.map((n) => ({ ...n, operation_name: null })) };
    const m = await extractModel(fragments, stub(flat), { processId: "s2", processName: "Продажа", modelType: "AS-IS" });
    expect(m.nodes.some((n) => n.bpmn_scope)).toBe(false);
    expect(m.nodes.map((n) => n.name)).toEqual(["получить заявку", "согласовать условия", "проверить договор", "подписать договор"]);
  });
});
