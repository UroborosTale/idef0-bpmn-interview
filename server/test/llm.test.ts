import { describe, expect, it } from "vitest";
import { normalizeChunk, quoteMatches } from "../src/llm/schema.js";
import { LLMHttpError, withRetry } from "../src/llm/http.js";
import { extractModel, normKey } from "../src/pipeline/extract.js";
import { runPipeline } from "../src/pipeline/run.js";
import { MockProvider } from "../src/llm/provider.js";
import type { LLMProvider } from "../src/llm/types.js";
import { fragmentText } from "../src/pipeline/fragment.js";

const frags = [
  { id: "f1", speaker: "owner", text: "Менеджер получает заявку от клиента по почте." },
  { id: "f2", speaker: "owner", text: "Юрист проверяет договор на соответствие шаблону." },
];

describe("проверка ответа LLM", () => {
  it("отбрасывает элементы неверной формы и приводит типы", () => {
    const { result, check } = normalizeChunk(
      {
        roles: [{ name: "Юрист", kind: "boss", source_fragment_id: "f2", quote: "Юрист проверяет договор", confidence: "0.9" }, { kind: "internal" }],
        nodes: [
          { type: "task", name: "проверить договор", order_hint: "1", source_fragment_id: "f2", quote: "проверяет договор на соответствие", confidence: 0.9, input_names: ["договор", 5, ""] },
          { type: "робот", name: "x", order_hint: 2, source_fragment_id: "f2", quote: "" },
        ],
        flows: "не массив",
      },
      frags
    );
    expect(result.roles).toHaveLength(1);
    expect(result.roles[0].kind).toBe("internal");
    expect(result.roles[0].confidence).toBe(0.9);
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].order_hint).toBe(1);
    expect(result.nodes[0].input_names).toEqual(["договор"]);
    expect(result.flows).toEqual([]);
    expect(check.dropped).toBe(2);
  });

  it("исправляет чужой id фрагмента по цитате и понижает уверенность у выдуманной цитаты", () => {
    const { result, check } = normalizeChunk(
      {
        nodes: [
          { type: "task", name: "получить заявку", order_hint: 1, source_fragment_id: "f99", quote: "получает заявку от клиента", confidence: 0.9 },
          { type: "task", name: "подписать акт", order_hint: 2, source_fragment_id: "f1", quote: "директор подписывает акт сверки", confidence: 0.95 },
        ],
      },
      frags
    );
    expect(result.nodes[0].source_fragment_id).toBe("f1");
    expect(result.nodes[0].confidence).toBe(0.9);
    expect(result.nodes[1].confidence).toBeLessThanOrEqual(0.4);
    expect(check.unverified).toBe(1);
  });

  it("цитата сверяется без учёта регистра, ё и пунктуации", () => {
    expect(quoteMatches("ЮРИСТ проверяет — договор", "Юрист проверяет договор на соответствие")).toBe(true);
    expect(quoteMatches("счёт", "выставляет счет клиенту")).toBe(true);
    expect(quoteMatches("совсем другое", "выставляет счет клиенту")).toBe(false);
  });
});

describe("повторы вызовов LLM", () => {
  it("повторяет 429 и 5xx, затем возвращает результат", async () => {
    let calls = 0;
    const r = await withRetry(async () => {
      calls++;
      if (calls < 3) throw new LLMHttpError("занято", calls === 1 ? 429 : 503);
      return "ok";
    }, { retries: 3, baseDelayMs: 1 });
    expect(r).toBe("ok");
    expect(calls).toBe(3);
  });

  it("не повторяет ошибки запроса (400, 401)", async () => {
    let calls = 0;
    await expect(withRetry(async () => {
      calls++;
      throw new LLMHttpError("неверный ключ", 401);
    }, { retries: 3, baseDelayMs: 1 })).rejects.toThrow("неверный ключ");
    expect(calls).toBe(1);
  });
});

describe("извлечение", () => {
  it("склеивает падежные формы одной сущности", () => {
    expect(normKey("Договор")).toBe(normKey("договора"));
    expect(normKey("заявку")).toBe(normKey("Заявка"));
    expect(normKey("счёт")).toBe(normKey("счет"));
    expect(normKey("договор")).not.toBe(normKey("заявка"));
  });

  const text = Array.from({ length: 40 }, (_, i) => `Владелец: Сотрудник ${i + 1} выполняет шаг номер ${i + 1}.`).join("\n");

  it("сбой части текста не теряется молча: он попадает в проверки модели", async () => {
    const mock = new MockProvider();
    let call = 0;
    const flaky: LLMProvider = {
      name: "flaky",
      extractChunk: async (f, c) => {
        if (call++ === 1) throw new Error("timeout");
        return mock.extractChunk(f, c);
      },
    };
    const out = await runPipeline("p", fragmentText(text), { processName: "Тест", modelType: "AS-IS", decompositionDepth: 2, notations: ["BPMN"] }, { provider: flaky });
    expect(out.report.failedChunks).toHaveLength(1);
    expect(out.validation.some((v) => v.rule === "extract_chunk_failed")).toBe(true);
  });

  it("если не обработана ни одна часть — ошибка, а не пустая модель", async () => {
    const broken: LLMProvider = { name: "broken", extractChunk: async () => { throw new Error("401 неверный ключ"); } };
    await expect(extractModel(fragmentText(text), broken, { processId: "p", processName: "Тест", modelType: "AS-IS" })).rejects.toThrow(/неверный ключ/);
  });
});
