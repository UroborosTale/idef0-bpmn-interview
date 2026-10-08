import { describe, expect, it } from "vitest";
import { splitAccepted, issueKey, validateModel } from "../src/shared/validate.js";
import { ProcessLogicModel } from "../src/types/model.js";
import { outline, type ModelView } from "../src/mcp/outline.js";
import { startApp } from "./api.js";
import { structuredModel } from "./fixtures.js";

delete process.env.AUTH_USERS;

describe("принятые замечания: общая логика", () => {
  it("ключ: правило и элемент; без элемента — ещё и текст", () => {
    expect(issueKey({ rule: "r", element_id: "o1", message: "любой текст" })).toBe("r|o1");
    expect(issueKey({ rule: "r", element_id: null, message: "текст" })).toBe("r||текст");
  });

  it("предупреждение принимается, ошибка — никогда", () => {
    const warn = { rule: "w", message: "m", element_id: "a", severity: "warning" };
    const err = { rule: "e", message: "m", element_id: "a", severity: "error" };
    const r = splitAccepted([{ rule: "w", element_id: "a", reason: "причина", at: "2026-10-08" }, { rule: "e", element_id: "a", reason: "нельзя" }], [warn, err]);
    expect(r.active).toEqual([err]);
    expect(r.accepted).toEqual([{ ...warn, reason: "причина", at: "2026-10-08" }]);
    expect(splitAccepted(undefined, [warn]).active).toEqual([warn]);
  });

  it("модель хранит принятые замечания: схема принимает и заполняет значениями по умолчанию", () => {
    const m = ProcessLogicModel.parse({ process: { id: "p", name: "П" } });
    expect(m.accepted_issues).toEqual([]);
    const withOne = ProcessLogicModel.parse({ process: { id: "p", name: "П" }, accepted_issues: [{ rule: "idef0_block_count", reason: "Так в документе" }] });
    expect(withOne.accepted_issues[0]).toEqual({ rule: "idef0_block_count", element_id: null, message: null, reason: "Так в документе", at: null });
  });
});

describe("принятые замечания для агента", () => {
  it("get_model: принятые не в списке замечаний, а отдельно с причиной; конспект называет их", async () => {
    const app = await startApp();
    try {
      const s = (await app.call("POST", "/sessions/blank", { meta: { processName: "Приём" } })).body;
      const m = structuredModel();
      const target = validateModel(m).find((i) => i.rule === "role_no_executor")!;
      m.accepted_issues = [{ rule: target.rule, element_id: target.element_id, message: null, reason: "Исполнитель определяется при внедрении", at: null }];
      expect((await app.call("PUT", `/sessions/${s.id}/model`, m)).status).toBe(200);
      const read = (await app.call("GET", `/agent/sessions/${s.id}/model`)).body;
      expect(read.issues.some((i: any) => i.rule === "role_no_executor")).toBe(false);
      expect(read.accepted).toEqual([{ rule: "role_no_executor", element_id: target.element_id, message: target.message, reason: "Исполнитель определяется при внедрении" }]);
      const text = outline(read as ModelView);
      expect(text).toContain("Принято аналитиком (не исправлять): 1");
      expect(text).toContain("причина: Исполнитель определяется при внедрении");
    } finally {
      await app.close();
    }
  });
});