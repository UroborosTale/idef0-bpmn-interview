import { describe, expect, it } from "vitest";
import { detectGaps } from "../src/pipeline/gaps.js";
import { demoModel } from "../src/reference/demo.js";
import { emptyModel } from "../src/types/model.js";

/**
 * A11 из отчёта 19.10: на иерархической модели движок спрашивал про подпроцессы и операции то, что уже описано
 * в декомпозиции, и считал пробелами законные конструкции BPMN (слияние, параллельный шлюз, ссылку, внешний продукт).
 * Демо C090 задумано без замечаний — после правки у него не должно быть ни одного пробела.
 */
const node = (id: string, extra: Record<string, unknown> = {}) =>
  ({
    id,
    type: "task",
    name: id,
    role_id: "r1",
    bpmn_scope: "o1",
    inputs: [],
    outputs: [],
    controls: [],
    system_ids: [],
    status: "confirmed",
    confidence: 1,
    source: [],
    ...extra,
  }) as never;
const flow = (from: string, to: string, condition: string | null = null) =>
  ({ id: `${from}-${to}`, from, to, condition, source: [], confirmed_by: [] }) as never;
const found = (m: ReturnType<typeof emptyModel>, rule: string, id?: string) =>
  detectGaps(m).filter((g) => g.rule === rule && (id === undefined || g.element_id === id));

describe("пробелы на иерархической модели", () => {
  it("не спрашивает исполнителя и продолжение у функции с декомпозицией", () => {
    const m = emptyModel({ id: "p", name: "Процесс" });
    m.nodes.push(node("s1", { bpmn_scope: null, role_id: null }), node("t1", { idef0_parent: "s1" }));
    expect(found(m, "missing_executor", "s1")).toEqual([]);
    expect(found(m, "dangling_flow", "s1")).toEqual([]);
  });

  it("ICOM-правило действует только на функциях IDEF0, а не на шагах BPMN", () => {
    const m = emptyModel({ id: "p", name: "Процесс" });
    m.nodes.push(node("step", { bpmn_scope: "o1" }), node("fn", { bpmn_scope: null }));
    expect(found(m, "idef0_missing_control", "step")).toEqual([]);
    expect(found(m, "idef0_missing_output", "step")).toEqual([]);
    expect(found(m, "idef0_missing_control", "fn")).toHaveLength(1);
    expect(found(m, "idef0_missing_output", "fn")).toHaveLength(1);
  });

  it("слияние и параллельный шлюз — не ветвление без условия", () => {
    const m = emptyModel({ id: "p", name: "Процесс" });
    m.nodes.push(
      node("and", { type: "gateway", subtype: "parallel", bpmn_scope: "o1" }),
      node("merge", { type: "gateway", subtype: "exclusive", bpmn_scope: "o1" }),
      node("split", { type: "gateway", subtype: "exclusive", bpmn_scope: "o1" }),
      node("a"), node("b"), node("c")
    );
    m.flows.push(flow("and", "a"), flow("and", "b"), flow("merge", "c"), flow("split", "a"), flow("split", "b"));
    expect(found(m, "gateway_missing_condition", "and")).toEqual([]);
    expect(found(m, "gateway_missing_condition", "merge")).toEqual([]);
    expect(found(m, "gateway_missing_condition", "split")).toHaveLength(1);
  });

  it("событие-ссылка не считается тупиком: продолжение — парное событие", () => {
    const m = emptyModel({ id: "p", name: "Процесс" });
    m.nodes.push(
      node("jump", { type: "event", subtype: "intermediate", trigger: { type: "link", direction: "throw", name: "Повторить" } }),
      node("wait", { type: "event", subtype: "intermediate", trigger: { type: "timer", direction: "catch" } })
    );
    expect(found(m, "dangling_flow", "jump")).toEqual([]);
    expect(found(m, "dangling_flow", "wait")).toHaveLength(1);
  });

  it("внешний поставщик и внешний потребитель документа — не пробел", () => {
    const m = emptyModel({ id: "p", name: "Процесс" });
    m.data.push(
      { id: "d_in", name: "Внешний вход", supplier: "Подразделение-заказчик" } as never,
      { id: "d_out", name: "Внешний выход", consumer: "Бухгалтерия" } as never,
      { id: "d_in2", name: "Вход без источника" } as never,
      { id: "d_out2", name: "Выход без потребителя" } as never
    );
    m.nodes.push(node("t", { inputs: ["d_in", "d_in2"], outputs: ["d_out", "d_out2"] }));
    expect(found(m, "orphan_input_document").map((g) => g.question)).toHaveLength(1);
    expect(found(m, "orphan_output_document").map((g) => g.question)).toHaveLength(1);
    expect(found(m, "orphan_input_document")[0].question).toMatch(/Вход без источника/);
    expect(found(m, "orphan_output_document")[0].question).toMatch(/Выход без потребителя/);
  });

  it("F4: последний шаг операции с продолжением операции не считается тупиком", () => {
    const m = emptyModel({ id: "p", name: "Процесс" });
    m.nodes.push(
      node("op", { bpmn_scope: null }),
      node("step", { bpmn_scope: "op" }),
      node("end", { type: "event", subtype: "end", bpmn_scope: "op" }),
      node("next", { bpmn_scope: null })
    );
    m.flows.push(flow("op", "next"));
    expect(found(m, "dangling_flow", "step")).toEqual([]);
  });

  it("демо C090 остаётся без пробелов", () => {
    expect(detectGaps(demoModel())).toEqual([]);
  });
});
