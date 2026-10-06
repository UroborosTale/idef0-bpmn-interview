import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApp } from "./api.js";
import { carryOverManualEdits, keepGapStatuses } from "../src/pipeline/carryOver.js";
import { purchaseModel } from "./fixtures.js";

delete process.env.AUTH_USERS;

let app: Awaited<ReturnType<typeof startApp>>;
beforeAll(async () => {
  app = await startApp();
});
afterAll(() => app.close());

const TEXT = `Владелец: Менеджер получает заявку от клиента и регистрирует её в CRM.
Владелец: Юрист проверяет договор и передаёт его бухгалтеру.
Владелец: Бухгалтер регистрирует договор в 1С.`;

async function runAndWait(id: string, body?: object) {
  const run = await app.call("POST", `/sessions/${id}/run`, body);
  for (let i = 0; i < 100; i++) {
    const j = await app.call("GET", `/jobs/${run.body.id}`);
    if (j.body.status !== "running") return j.body;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("задача не завершилась");
}

async function newSession() {
  const s = await app.call("POST", "/sessions", { meta: { processName: "Договор" } });
  await app.call("POST", `/sessions/${s.body.id}/ingest-text`, { text: TEXT });
  await runAndWait(s.body.id);
  return (await app.call("GET", `/sessions/${s.body.id}`)).body;
}

describe("хранилище", () => {
  it("версии хранятся отдельно и отдаются клиенту без моделей", async () => {
    const s = await newSession();
    await runAndWait(s.id);
    const after = (await app.call("GET", `/sessions/${s.id}`)).body;
    expect(after.versions.map((v: any) => v.seq)).toEqual([1, 2]);
    expect(after.versions[0].model).toBeUndefined();
    const list = (await app.call("GET", "/sessions")).body;
    const row = list.find((x: any) => x.id === s.id);
    expect(row).toMatchObject({ title: "Договор", status: "ready", hasErrors: expect.any(Boolean), gapsOpen: expect.any(Number) });
  });

  it("сохранение поверх изменившейся модели отклоняется", async () => {
    const s = await newSession();
    const model = { ...s.model, nodes: s.model.nodes.map((n: any, i: number) => (i === 0 ? { ...n, name: "правка 1" } : n)) };
    const ok = await app.call("PUT_BASE", `/sessions/${s.id}/model|${s.updatedAt}`, model);
    expect(ok.status).toBe(200);
    // вторая вкладка начинала правку с прежней версии
    const stale = await app.call("PUT_BASE", `/sessions/${s.id}/model|${s.updatedAt}`, model);
    expect(stale.status).toBe(409);
    expect(stale.body.conflict).toBe(true);
  });

  it("удаление сессии удаляет её версии и задачи", async () => {
    const s = await newSession();
    const { db } = await import("../src/db.js");
    expect((db.prepare(`SELECT COUNT(*) c FROM session_versions WHERE session_id = ?`).get(s.id) as any).c).toBeGreaterThan(0);
    expect((await app.call("DELETE", `/sessions/${s.id}`)).status).toBe(204);
    for (const t of ["session_versions", "jobs", "agent_run_log"]) expect((db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE session_id = ?`).get(s.id) as any).c).toBe(0);
  });

  it("повторная обработка сохраняет позиции и вручную добавленные шаги", async () => {
    const s = await newSession();
    const m = s.model;
    const first = m.nodes[0];
    first.layout = { x: 777, y: 75 };
    m.nodes.push({ ...first, id: "manual1", name: "Шаг, добавленный вручную", source: [], layout: { x: 900, y: 75 } });
    m.flows.push({ id: "fm", from: first.id, to: "manual1", source: [], confirmed_by: [] });
    expect((await app.call("PUT", `/sessions/${s.id}/model`, m)).status).toBe(200);

    const job = await runAndWait(s.id);
    expect(job.result.carried.kept).toBe(1);
    const after = (await app.call("GET", `/sessions/${s.id}`)).body.model;
    expect(after.nodes.find((n: any) => n.name === first.name).layout).toEqual({ x: 777, y: 75 });
    const manual = after.nodes.find((n: any) => n.name === "Шаг, добавленный вручную");
    expect(manual).toBeDefined();
    expect(after.flows.some((f: any) => f.to === manual.id)).toBe(true);

    // «с нуля» — без переноса
    await runAndWait(s.id, { fresh: true });
    expect((await app.call("GET", `/sessions/${s.id}`)).body.model.nodes.some((n: any) => n.name === "Шаг, добавленный вручную")).toBe(false);
  });
});

describe("перенос ручных правок", () => {
  it("вложенные функции, RACI и закрытые пробелы переживают пересборку модели", () => {
    const prev = purchaseModel();
    // вложенные функции заведены вручную (без источника в тексте)
    for (const n of prev.nodes) n.source = n.idef0_parent ? [] : [{ fragment_id: "f1", quote: n.name }];
    prev.raci = [{ node_id: "b", role_id: "r1", type: "A" }];
    // «новая» модель: те же шаги верхнего уровня с другими id и без деталей
    const next = purchaseModel();
    next.nodes = next.nodes
      .filter((n) => !n.idef0_parent)
      .map((n, i) => ({ ...n, id: `x${i}`, source: [{ fragment_id: "f1", quote: n.name }], layout: null, idef0_layout: null }));
    next.flows = [];
    next.raci = [];
    const { model, matched, kept } = carryOverManualEdits(prev, next);
    expect(matched).toBe(3);
    expect(kept).toBe(2);
    const parent = model.nodes.find((n) => n.name === "согласовать заявку")!;
    expect(model.nodes.filter((n) => n.idef0_parent === parent.id).map((n) => n.name).sort()).toEqual(["принять решение", "проверить бюджет"]);
    expect(model.raci).toEqual([{ node_id: parent.id, role_id: "r1", type: "A" }]);

    const gaps = keepGapStatuses(
      [{ id: "g1", rule: "r", priority: "important", element_id: null, question: "Кто?", status: "dismissed", asked_count: 2 }],
      [{ id: "g9", rule: "r", priority: "important", element_id: null, question: "Кто?", status: "open", asked_count: 0 }]
    );
    expect(gaps[0].status).toBe("dismissed");
  });
});
