import JSZip from "jszip";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setMembers, setVisible } from "../src/shared/objectSets.js";
import { demoModel } from "../src/reference/demo.js";
import { ProcessLogicModel } from "../src/types/model.js";
import { startApp } from "./api.js";
import { structuredModel } from "./fixtures.js";

delete process.env.AUTH_USERS;

const withSets = () => {
  const m = structuredModel();
  m.object_sets = [
    { id: "k1", name: "Подпроцесс 1", members: ["s1"] },
    { id: "k2", name: "Операция и мусор", members: ["o3", "нет-такой"] },
    { id: "k3", name: "Пустой", members: [] },
  ];
  return m;
};

describe("наборы объектов", () => {
  it("модель принимает наборы, а без поля их нет", () => {
    expect(ProcessLogicModel.safeParse(withSets()).success).toBe(true);
    expect(structuredModel().object_sets).toBeUndefined();
    const bad = JSON.parse(JSON.stringify(withSets()));
    bad.object_sets[0].name = "";
    expect(ProcessLogicModel.safeParse(bad).success).toBe(false);
  });

  it("в набор входит функция и всё вложенное; несуществующие id пропускаются", () => {
    const m = withSets();
    expect([...setMembers(m, "k1")].sort()).toEqual(["o1", "o2", "s1"]);
    expect([...setMembers(m, "k2")]).toEqual(["o3"]);
    expect(setMembers(m, "k3").size).toBe(0);
    expect(setMembers(m, "нет").size).toBe(0);
  });

  it("при фильтре видны члены набора и путь к ним", () => {
    const m = withSets();
    expect([...setVisible(m, "k2")].sort()).toEqual(["o3", "s2"]);
    expect([...setVisible(m, "k1")].sort()).toEqual(["o1", "o2", "s1"]);
  });

  it("шаги диаграмм в набор не входят и функциями не считаются", () => {
    const m = withSets();
    m.object_sets![2].members = ["b1"]; // шаг диаграммы операции, не функция
    expect(setMembers(m, "k3").size).toBe(0);
  });
});

describe("выгрузка BPMN по набору", () => {
  let app: Awaited<ReturnType<typeof startApp>>;
  beforeAll(async () => {
    app = await startApp();
  });
  afterAll(() => app.close());

  it("?set= ограничивает архив операциями набора; неизвестный набор — 404, набор без диаграмм — 400", async () => {
    const m = demoModel();
    const sub = m.nodes.find((n) => n.id === "o31")!.idef0_parent!;
    m.object_sets = [
      { id: "k1", name: "Раздел", members: [sub] },
      { id: "k2", name: "Без диаграмм", members: [] },
    ];
    const s = (await app.call("POST", "/sessions/blank", { meta: { processName: "C090" } })).body;
    expect((await app.call("PUT", `/sessions/${s.id}/model`, m)).status).toBe(200);
    const all = Object.keys((await JSZip.loadAsync((await app.raw(`/sessions/${s.id}/export/bpmn.zip`)).body)).files);
    const some = Object.keys((await JSZip.loadAsync((await app.raw(`/sessions/${s.id}/export/bpmn.zip?set=k1`)).body)).files);
    expect(all).toHaveLength(6);
    expect(some.length).toBeGreaterThan(0);
    expect(some.length).toBeLessThan(all.length);
    expect(some.every((f) => all.includes(f))).toBe(true);
    expect((await app.raw(`/sessions/${s.id}/export/bpmn.zip?set=нет`)).status).toBe(404);
    expect((await app.raw(`/sessions/${s.id}/export/bpmn.zip?set=k2`)).status).toBe(400);
  }, 90_000);
});
