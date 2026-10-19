import { describe, expect, it } from "vitest";
import { checkConnections } from "../src/shared/connectionCheck.js";

/**
 * В10: «Проверка соединения» — проблемные концы стрелок IDEF0. Проверяются данные модели: дубль сущности
 * у блока, одна и та же запись как вход и выход, ссылка на запись, которой нет в справочнике.
 */
const node = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: "task" as const,
  name,
  idef0_parent: null,
  inputs: [],
  outputs: [],
  controls: [],
  system_ids: [],
  role_id: null,
  status: "confirmed" as const,
  confidence: 1,
  source: [],
  requirement_ids: [],
  tags: [],
  confirmed_by: [],
  ...extra,
});

const model = (nodes: ReturnType<typeof node>[]) =>
  ({
    process: { code: "B1", name: "Процесс" },
    nodes,
    data: [
      { id: "d1", name: "Заявка", kind: "document" },
      { id: "d2", name: "Акт", kind: "document" },
    ],
    controls: [{ id: "c1", name: "Регламент" }],
    roles: [{ id: "r1", name: "Аналитик" }],
    systems: [{ id: "s1", name: "1С" }],
    assignments: [],
    flows: [],
    messages: [],
    pools: [],
  }) as never;

describe("проверка соединения IDEF0", () => {
  it("чистая модель: замечаний нет", () => {
    expect(checkConnections(model([node("f1", "Функция 1", { inputs: ["d1"], controls: ["c1"], outputs: ["d2"] })]))).toEqual([]);
  });

  it("дубль сущности в разделе у блока", () => {
    const issues = checkConnections(model([node("f1", "Функция 1", { inputs: ["d1", "d1"] })]));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ kind: "dup", nodeId: "f1" });
    expect(issues[0].message).toContain("Заявка");
    expect(issues[0].message).toContain("дважды");
  });

  it("одна и та же запись — вход и выход одного блока", () => {
    const issues = checkConnections(model([node("f1", "Функция 1", { inputs: ["d1"], outputs: ["d1"] })]));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ kind: "both", nodeId: "f1" });
    expect(issues[0].message).toContain("одновременно вход и выход");
  });

  it("ссылка на запись, которой нет в справочнике: конец не прикреплён", () => {
    const issues = checkConnections(model([node("f1", "Функция 1", { inputs: ["нет-такой"] })]));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ kind: "missing", nodeId: "f1" });
    expect(issues[0].message).toContain("нет в справочнике");
  });

  it("проверяется только своя диаграмма: подфункции чужого уровня не попадают", () => {
    const child = node("c", "Подфункция", { idef0_parent: "f1", inputs: ["d1", "d1"] });
    const issues = checkConnections(model([node("f1", "Функция 1"), child]));
    expect(issues).toEqual([]);
    // а на диаграмме подфункции — попадают
    expect(checkConnections(model([node("f1", "Функция 1"), child]), "f1")).toHaveLength(1);
  });
});
