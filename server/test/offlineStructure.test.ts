import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { MockProvider } from "../src/llm/provider.js";
import { extractModel } from "../src/pipeline/extract.js";
import { detectGaps } from "../src/pipeline/gaps.js";
import { fragmentText } from "../src/pipeline/fragment.js";
import type { Fragment } from "../src/types/model.js";

const frag = (id: string, text: string): Fragment => ({ id, index: Number(id.slice(1)) - 1, speaker: "owner", text });

/** B1/B3/D4: офлайн-режим строит глубину 2, события и исполнителей, а не одну лестницу функций. */
describe("офлайн-структура", () => {
  it("глубина 2: подпроцессы и операции, шаги с исполнителями, старт и конец из текста", async () => {
    const fragments = [
      frag("f1", "Процесс запускается после получения заявки."),
      frag("f2", "Сотрудник получает заявку. Сотрудник проверяет заявку. Сотрудник проверяет документы. Сотрудник оформляет пропуск."),
      frag("f3", "Охранник согласует заявку. Охранник утверждает заявку. Охранник передаёт пропуск. Охранник выдаёт пропуск посетителю. Сотрудник закрывает заявку."),
      frag("f4", "Процесс завершается выдачей пропуска."),
    ];
    const model = await extractModel(fragments, new MockProvider(), {
      processId: "s_offline",
      processName: "Выдача пропуска",
      modelType: "AS-IS",
      decompositionDepth: 2,
    });

    const subprocesses = model.nodes.filter((n) => model.nodes.some((x) => x.idef0_parent === n.id));
    expect(subprocesses.length).toBeGreaterThanOrEqual(2);
    expect(subprocesses.length).toBeLessThanOrEqual(6);
    const steps = model.nodes.filter((n) => n.bpmn_scope);
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.every((n) => !!n.role_id)).toBe(true);
    expect(model.nodes.some((n) => n.type === "event" && n.subtype === "start")).toBe(true);
    expect(model.nodes.some((n) => n.type === "event" && n.subtype === "end")).toBe(true);
    expect(model.process.trigger).toContain("запускается");
    expect(model.process.result).toContain("завершается");
    expect(steps.some((n) => n.name.startsWith("Выдать пропуск"))).toBe(true);
    expect(steps.find((n) => n.name === "Проверить заявку")?.role_id).toBeTruthy();

    const gaps = detectGaps(model);
    expect(gaps.some((g) => g.rule === "missing_start_event" || g.rule === "missing_end_event")).toBe(false);
    expect(gaps.some((g) => g.rule === "missing_executor" && g.element_id && steps.some((n) => n.id === g.element_id))).toBe(false);
  });

  it("глубина 1 оставляет действия на общей схеме", async () => {
    const fragments = [
      frag("f1", "Сотрудник получает заявку."),
      frag("f2", "Сотрудник проверяет заявку."),
      frag("f3", "Сотрудник оформляет пропуск."),
      frag("f4", "Сотрудник передаёт пропуск."),
    ];
    const model = await extractModel(fragments, new MockProvider(), {
      processId: "s_offline_1",
      processName: "Выдача пропуска",
      modelType: "AS-IS",
      decompositionDepth: 1,
    });
    expect(model.nodes.some((n) => n.bpmn_scope)).toBe(false);
    expect(model.nodes.filter((n) => n.type === "task").length).toBeGreaterThan(0);
  });

  it("B1: на интервью о найме A0 — 3–6 блоков, а не десятки функций; события есть", async () => {
    const raw = readFileSync(new URL("./fixtures/hiring/hiring.md", import.meta.url), "utf8");
    const model = await extractModel(fragmentText(raw), new MockProvider(), {
      processId: "s_hiring_offline",
      processName: "Приём сотрудника",
      modelType: "AS-IS",
      decompositionDepth: 2,
    });
    const top = model.nodes.filter((n) => !n.idef0_parent && !n.bpmn_scope && n.type !== "event");
    const subprocesses = model.nodes.filter((n) => model.nodes.some((x) => x.idef0_parent === n.id));
    // 5 подпроцессов и редкие действия из коротких чанков — не 80+ функций, как было
    expect(top.length).toBeLessThanOrEqual(10);
    expect(subprocesses.length).toBeGreaterThanOrEqual(3);
    expect(subprocesses.length).toBeLessThanOrEqual(6);
    expect(model.nodes.filter((n) => n.type === "event").length).toBeGreaterThanOrEqual(2);
  });
});
