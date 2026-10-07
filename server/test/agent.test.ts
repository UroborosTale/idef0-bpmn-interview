import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApp } from "./api.js";
import { applyPatch, describePatch, integrityProblems, issueDelta, type ModelPatch, type PatchOp } from "../src/shared/patch.js";
import { validateModel } from "../src/shared/validate.js";
import { structuredModel } from "./fixtures.js";

delete process.env.AUTH_USERS;

const patch = (...ops: PatchOp[]): ModelPatch => ({ ops });
const step = (id: string, extra: Record<string, unknown> = {}): PatchOp => ({ op: "add", collection: "nodes", value: { id, type: "task", name: `Шаг ${id}`, bpmn_scope: "o1", role_id: "r2", ...extra } });

describe("предложения агентов: применение правок", () => {
  it("добавление шага: значения по умолчанию, шаг — гипотеза до подтверждения человеком", () => {
    const m = structuredModel();
    const { model, errors } = applyPatch(m, patch(step("n1")));
    expect(errors).toEqual([]);
    const n = model.nodes.find((x) => x.id === "n1")!;
    expect(n).toMatchObject({ status: "hypothesis", confidence: 0.5, inputs: [], outputs: [], controls: [], system_ids: [], source: [], tags: [], bpmn_scope: "o1" });
    expect(m.nodes.some((x) => x.id === "n1")).toBe(false); // исходная модель не меняется
  });

  it("новую запись можно сразу использовать в следующих операциях предложения", () => {
    const { model, errors } = applyPatch(
      structuredModel(),
      patch(
        { op: "add", collection: "roles", value: { id: "r9", name: "Юрист" } },
        { op: "add", collection: "data", value: { id: "d9", name: "Заключение юриста" } },
        step("n1", { role_id: "r9", outputs: ["d9"] }),
        step("n2"),
        { op: "add", collection: "flows", value: { id: "fx", from: "n1", to: "n2" } },
        { op: "set_assignments", node_id: "o1", items: [{ role_id: "r9", kind: "controller", functions: ["Проверка заключения"] }] }
      )
    );
    expect(errors).toEqual([]);
    expect(model.roles.find((r) => r.id === "r9")).toMatchObject({ kind: "internal", source: [] });
    expect(model.flows.find((f) => f.id === "fx")).toMatchObject({ condition: null, source: [] });
    expect(model.assignments.filter((a) => a.node_id === "o1")).toEqual([{ node_id: "o1", role_id: "r9", kind: "controller", functions: ["Проверка заключения"] }]);
  });

  it("ошибки операций называют номер операции; при любой ошибке модель остаётся прежней", () => {
    const m = structuredModel();
    const bad = applyPatch(
      m,
      patch(
        step("n1"),
        step("n1"), // повтор id
        { op: "add", collection: "nodes", value: { id: "n3", type: "task" } }, // нет названия
        { op: "add", collection: "nodes", value: { id: "n4", type: "блок", name: "Х" } },
        { op: "add", collection: "flows", value: { id: "f9", from: "n1" } },
        { op: "update", collection: "nodes", id: "нет", patch: { name: "Х" } },
        { op: "update", collection: "nodes", id: "b1", patch: { id: "другой" } },
        { op: "remove", collection: "roles", id: "нет" },
        { op: "set_assignments", node_id: "нет", items: [] },
        { op: "set_assignments", node_id: "o1", items: [{ role_id: "нет", kind: "executor" }] },
        { op: "set_process", patch: { version: "9" } }
      )
    );
    expect(bad.model).toBe(m);
    expect(bad.errors.map((e) => e.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(bad.errors[0].message).toMatch(/уже есть/);
    expect(bad.errors[2].message).toMatch(/type/);
    expect(bad.errors[5].message).toMatch(/id записи менять нельзя/);
  });

  it("целостность: ссылки на несуществующее, потоки между диаграммами, повтор id", () => {
    const m = structuredModel();
    const run = (...ops: PatchOp[]) => applyPatch(m, patch(...ops)).errors.map((e) => e.message);
    expect(run(step("n1", { role_id: "нет" }))[0]).toMatch(/исполнитель «нет» не существует/);
    expect(run(step("n1", { inputs: ["нет"] }))[0]).toMatch(/вход или выход «нет»/);
    expect(run(step("n1", { bpmn_scope: "нет" }))[0]).toMatch(/операции «нет», которой нет/);
    expect(run(step("n1", { bpmn_scope: "b1" }))[0]).toMatch(/не функция IDEF0/);
    expect(run({ op: "add", collection: "flows", value: { id: "fz", from: "b1", to: "o2" } })[0]).toMatch(/разных диаграмм/);
    expect(run({ op: "add", collection: "flows", value: { id: "fz", from: "b1", to: "нет" } })[0]).toMatch(/несуществующему шагу/);
    expect(run(step("be", { type: "event", subtype: "timer", name: "Срок истёк", attached_to: "b0" }))[0]).toMatch(/не к задаче/);
    expect(run({ op: "add", collection: "messages", value: { id: "m1", from: "b1", to: "b2" } })[0]).toMatch(/шаг и внешний пул/);
    expect(run({ op: "update", collection: "nodes", id: "b1", patch: { idef0_parent: "нет" } })[0]).toMatch(/родитель IDEF0/);
  });

  it("нарушения, которые были в модели до предложения, предложению не вменяются", () => {
    const m = structuredModel();
    m.nodes.find((n) => n.id === "b2")!.role_id = "исчезла";
    expect(integrityProblems(m)).toHaveLength(1);
    const { errors } = applyPatch(m, patch(step("n1")));
    expect(errors).toEqual([]);
  });

  it("удаление операции уносит её шаги, потоки, назначения и потоки сообщений", () => {
    const m = structuredModel();
    m.pools = [{ id: "x1", name: "Другой процесс" }];
    m.messages = [{ id: "m1", from: "b2", to: "x1" }];
    const { model, errors } = applyPatch(m, patch({ op: "remove", collection: "nodes", id: "o1" }));
    expect(errors).toEqual([]);
    expect(model.nodes.map((n) => n.id)).toEqual(["s1", "s2", "o2", "o3"]);
    expect(model.flows).toEqual([]);
    expect(model.assignments.some((a) => a.node_id === "o1")).toBe(false);
    expect(model.messages).toEqual([]);
    expect(model.pools).toHaveLength(1);
  });

  it("удаление подпроцесса уносит операции, а граничных событий — вместе с задачей", () => {
    const m = structuredModel();
    m.nodes.push({ id: "be", type: "event", subtype: "timer", name: "Срок истёк", bpmn_scope: "o1", attached_to: "b1" } as never);
    const { model } = applyPatch(m, patch({ op: "remove", collection: "nodes", id: "s1" }));
    expect(model.nodes.map((n) => n.id)).toEqual(["s2", "o3"]);
    const only = applyPatch(m, patch({ op: "remove", collection: "nodes", id: "b1" }));
    expect(only.model.nodes.some((n) => n.id === "be")).toBe(false);
  });

  it("удаление должности, документа, регламента и системы чистит ссылки", () => {
    const m = structuredModel();
    const r = applyPatch(m, patch({ op: "remove", collection: "roles", id: "r2" })).model;
    expect(r.nodes.filter((n) => n.role_id === "r2")).toEqual([]);
    expect(r.assignments.some((a) => a.role_id === "r2")).toBe(false);
    const d = applyPatch(m, patch({ op: "remove", collection: "data", id: "d3" })).model;
    expect(d.nodes.some((n) => n.inputs.includes("d3") || n.outputs.includes("d3"))).toBe(false);
    const c = applyPatch(m, patch({ op: "remove", collection: "controls", id: "c1" })).model;
    expect(c.nodes.some((n) => n.controls.includes("c1"))).toBe(false);
    const s = applyPatch(m, patch({ op: "remove", collection: "systems", id: "s1" })).model;
    expect(s.nodes.some((n) => n.system_ids.includes("s1"))).toBe(false);
  });

  it("set_assignments заменяет назначения узла целиком; пустой список снимает все", () => {
    const m = structuredModel();
    const one = applyPatch(m, patch({ op: "set_assignments", node_id: "o1", items: [{ role_id: "r1", kind: "owner" }] })).model;
    expect(one.assignments.filter((a) => a.node_id === "o1")).toEqual([{ node_id: "o1", role_id: "r1", kind: "owner", functions: [] }]);
    expect(one.assignments.filter((a) => a.node_id === "s1")).toHaveLength(1); // чужие назначения целы
    const none = applyPatch(m, patch({ op: "set_assignments", node_id: null, items: [] })).model;
    expect(none.assignments.some((a) => a.node_id === null)).toBe(false);
  });

  it("set_process меняет допустимые атрибуты процесса", () => {
    const { model } = applyPatch(structuredModel(), patch({ op: "set_process", patch: { owner: "Начальник отдела", code: "B003.00.00" } }));
    expect(model.process).toMatchObject({ owner: "Начальник отдела", code: "B003.00.00", name: "Управление процессами" });
  });
});

describe("предложения агентов: описание и влияние на проверки", () => {
  it("описание по-русски: коды по Соглашению, место шага, новые записи по названию", () => {
    const m = structuredModel();
    const lines = describePatch(
      m,
      patch(
        { op: "add", collection: "roles", value: { id: "r9", name: "Юрист" } },
        step("n1", { role_id: "r9" }),
        { op: "update", collection: "nodes", id: "b1", patch: { name: "Открыть реестр процессов", role_id: "r1" } },
        { op: "remove", collection: "nodes", id: "o2" },
        { op: "set_assignments", node_id: "o1", items: [{ role_id: "r9", kind: "controller" }] },
        { op: "set_process", patch: { owner: "Начальник отдела" } },
        { op: "add", collection: "flows", value: { id: "fx", from: "b1", to: "n1" } }
      )
    );
    expect(lines).toEqual([
      "Добавить должность «Юрист»",
      "Добавить шаг «Шаг n1» в BPMN операции B002.01.01 «Актуализация реестра процессов»",
      "Изменить шаг B002.01.01/001 «Открыть реестр»: название → Открыть реестр процессов; исполнитель → r1",
      "Удалить шаг B002.01.02 «Проведение первичного интервью»",
      "Роли B002.01.01 «Актуализация реестра процессов»: «Юрист» — controller",
      "Процесс: ответственный → Начальник отдела",
      "Добавить стрелку b1 → n1",
    ]);
  });

  it("issueDelta: что предложение вносит и что снимает", () => {
    const m = structuredModel();
    // событие «Информация получена» — факт; переименуем в существительное (новое замечание), а у o2 назначим исполнителя (снимется замечание)
    const before = validateModel(m);
    expect(before.some((i) => i.rule === "role_no_executor" && i.element_id === "o2")).toBe(true);
    const { model } = applyPatch(
      m,
      patch({ op: "update", collection: "nodes", id: "b0", patch: { name: "Пункт протокола" } }, { op: "update", collection: "nodes", id: "o2", patch: { role_id: "r2" } } as PatchOp)
    );
    const delta = issueDelta(before, validateModel(model));
    expect(delta.introduced.map((i) => i.rule)).toContain("bpmn_event_not_fact");
    expect(delta.resolved.map((i) => `${i.rule}:${i.element_id}`)).toContain("role_no_executor:o2");
  });
});

describe("API агента", () => {
  let app: Awaited<ReturnType<typeof startApp>>;
  beforeAll(async () => {
    app = await startApp();
  });
  afterAll(() => app.close());

  async function session() {
    const s = (await app.call("POST", "/sessions/blank", { meta: { processName: "Управление процессами" } })).body;
    const put = await app.call("PUT", `/sessions/${s.id}/model`, structuredModel());
    expect(put.status).toBe(200);
    return { id: s.id as string, updatedAt: put.body.updatedAt as string };
  }

  const proposal = (extra: Record<string, unknown> = {}) => ({
    agent: "моделист",
    title: "Добавить шаг проверки реестра",
    rationale: "Фрагмент 3: «специалист проверяет реестр»",
    ops: [step("n1", { name: "Проверить реестр", subtype: "user" })],
    ...extra,
  });

  it("правила работы агента отдаются текстом", async () => {
    const r = await app.call("GET", "/agent/conventions");
    expect(r.status).toBe(200);
    expect(String(r.body)).toContain("Вы только предлагаете — применяет человек");
  });

  it("модель для агента: коды функций и шагов, замечания проверок", async () => {
    const { id } = await session();
    const r = await app.call("GET", `/agent/sessions/${id}/model`);
    expect(r.status).toBe(200);
    expect(r.body.processCode).toBe("B002.00.00");
    expect(r.body.codes).toMatchObject({ o1: "B002.01.01", b1: "B002.01.01/001" });
    expect(r.body.issues.some((i: any) => i.rule === "role_no_executor")).toBe(true);
    const list = await app.call("GET", "/agent/sessions");
    expect(list.body.find((s: any) => s.id === id)).toMatchObject({ code: "B002.00.00", hasModel: true });
    expect((await app.call("GET", "/agent/sessions/нет/model")).status).toBe(404);
  });

  it("предложение сохраняется: описание, влияние на проверки, статус «ожидает»", async () => {
    const { id } = await session();
    const created = await app.call("POST", `/agent/sessions/${id}/proposals`, proposal());
    expect(created.status).toBe(201);
    expect(created.body.status).toBe("pending");
    expect(created.body.lines).toEqual(["Добавить шаг «Проверить реестр» в BPMN операции B002.01.01 «Актуализация реестра процессов»"]);
    expect(created.body.delta).toEqual({ introduced: expect.any(Array), resolved: expect.any(Array) });

    const list = await app.call("GET", `/agent/sessions/${id}/proposals?status=pending`);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ id: created.body.id, agent: "моделист", status: "pending", stale: false, rationale: expect.stringContaining("Фрагмент 3") });
    // сама модель предложением не меняется
    expect((await app.call("GET", `/agent/sessions/${id}/model`)).body.model.nodes.some((n: any) => n.id === "n1")).toBe(false);
    expect((await app.call("GET", `/agent/sessions/${id}/proposals?status=плохо`)).status).toBe(400);
  });

  it("неприменимые и неверные предложения отклоняются с понятными ошибками", async () => {
    const { id } = await session();
    const unusable = await app.call("POST", `/agent/sessions/${id}/proposals`, proposal({ ops: [step("n1", { role_id: "нет" })] }));
    expect(unusable.status).toBe(422);
    expect(unusable.body.errors[0].message).toMatch(/исполнитель «нет» не существует/);

    const schema = await app.call("POST", `/agent/sessions/${id}/proposals`, proposal({ ops: [step("n1", { confidence: 5 })] }));
    expect(schema.status).toBe(422);
    expect(schema.body.error).toMatch(/нарушила схему/);

    const format = await app.call("POST", `/agent/sessions/${id}/proposals`, { agent: "x", title: "y", ops: [{ op: "взорвать" }] });
    expect(format.status).toBe(400);
    expect((await app.call("POST", `/agent/sessions/${id}/proposals`, proposal({ ops: [] }))).status).toBe(400);
    expect((await app.call("POST", "/agent/sessions/нет/proposals", proposal())).status).toBe(404);
    expect((await app.call("GET", `/agent/sessions/${id}/proposals`)).body).toEqual([]); // ничего не сохранилось
  });

  it("предложение устаревает, когда модель сохранили после его создания", async () => {
    const { id } = await session();
    const created = await app.call("POST", `/agent/sessions/${id}/proposals`, proposal());
    const m = (await app.call("GET", `/agent/sessions/${id}/model`)).body.model;
    m.process.owner = "изменено вручную";
    await new Promise((r) => setTimeout(r, 5));
    expect((await app.call("PUT", `/sessions/${id}/model`, m)).status).toBe(200);
    expect((await app.call("GET", `/agent/proposals/${created.body.id}`)).body.stale).toBe(true);
    expect((await app.call("GET", `/sessions/${id}/proposals`)).body[0].stale).toBe(true);
  });

  it("решение человека: применено или отклонено с причиной; повторное решение — конфликт; агент видит причину", async () => {
    const { id } = await session();
    const a = (await app.call("POST", `/agent/sessions/${id}/proposals`, proposal())).body.id;
    const b = (await app.call("POST", `/agent/sessions/${id}/proposals`, proposal({ title: "Ещё шаг", ops: [step("n2")] }))).body.id;

    const applied = await app.call("POST", `/proposals/${a}/resolve`, { status: "applied" });
    expect(applied.status).toBe(200);
    expect(applied.body).toMatchObject({ status: "applied", resolvedBy: "local" });
    expect((await app.call("POST", `/proposals/${a}/resolve`, { status: "rejected" })).status).toBe(409);

    await app.call("POST", `/proposals/${b}/resolve`, { status: "rejected", reason: "Этот шаг уже есть в операции B002.01.02" });
    const seen = await app.call("GET", `/agent/proposals/${b}`);
    expect(seen.body).toMatchObject({ status: "rejected", reason: "Этот шаг уже есть в операции B002.01.02" });
    expect((await app.call("GET", `/agent/sessions/${id}/proposals?status=pending`)).body).toEqual([]);
    expect((await app.call("POST", `/proposals/${b}/resolve`, { status: "что-то" })).status).toBe(400);
    expect((await app.call("POST", "/proposals/нет/resolve", { status: "applied" })).status).toBe(404);
  });

  it("удаление сессии удаляет её предложения", async () => {
    const { id } = await session();
    const p = (await app.call("POST", `/agent/sessions/${id}/proposals`, proposal())).body.id;
    expect((await app.call("DELETE", `/sessions/${id}`)).status).toBe(204);
    expect((await app.call("GET", `/agent/proposals/${p}`)).status).toBe(404);
  });

  it("текст интервью по фрагментам со страницами", async () => {
    const { id } = await session();
    expect((await app.call("POST", `/sessions/${id}/ingest-text`, { text: "Специалист открывает реестр. Затем вносит код процесса.\n\nПосле этого сохраняет файл." })).status).toBe(200);
    const all = await app.call("GET", `/agent/sessions/${id}/fragments`);
    expect(all.status).toBe(200);
    expect(all.body.total).toBeGreaterThan(0);
    expect(all.body.fragments[0]).toEqual({ id: expect.any(String), index: expect.any(Number), speaker: expect.any(String), text: expect.stringContaining("Специалист открывает реестр") });
    const page = await app.call("GET", `/agent/sessions/${id}/fragments?from=${all.body.total}&limit=5`);
    expect(page.body.fragments).toEqual([]);
    expect((await app.call("GET", "/agent/sessions/нет/fragments")).status).toBe(404);
  });

  it("цитаты в источниках проверяются по тексту интервью", async () => {
    const { id } = await session();
    await app.call("POST", `/sessions/${id}/ingest-text`, { text: "Специалист открывает реестр процессов и вносит код процесса." });
    const fid = (await app.call("GET", `/agent/sessions/${id}/fragments`)).body.fragments[0].id as string;
    const withSource = (source: unknown) => proposal({ ops: [step("n1", { source })] });

    const good = await app.call("POST", `/agent/sessions/${id}/proposals`, withSource([{ fragment_id: fid, quote: "открывает реестр процессов" }]));
    expect(good.status).toBe(201);
    const inexact = await app.call("POST", `/agent/sessions/${id}/proposals`, withSource([{ fragment_id: fid, quote: "Специалист открывает реестр" }]));
    expect(inexact.status).toBe(201); // дословность не нужна: цитата почти совпадает

    const invented = await app.call("POST", `/agent/sessions/${id}/proposals`, withSource([{ fragment_id: fid, quote: "директор утверждает бюджет на следующий год" }]));
    expect(invented.status).toBe(422);
    expect(invented.body.errors[0]).toMatchObject({ index: 0 });
    expect(invented.body.errors[0].message).toMatch(/цитаты «директор утверждает бюджет.*нет во фрагменте/);
    const noFragment = await app.call("POST", `/agent/sessions/${id}/proposals`, withSource([{ fragment_id: "нет-такого", quote: "открывает реестр" }]));
    expect(noFragment.body.errors[0].message).toMatch(/фрагмента «нет-такого» нет в интервью/);
    expect((await app.call("POST", `/agent/sessions/${id}/proposals`, withSource("текст"))).status).toBe(422);
    expect((await app.call("GET", `/agent/sessions/${id}/proposals`)).body).toHaveLength(2); // отклонённое не сохранилось
  });

  it("задания аналитика: поставить, взять, предложить по заданию, завершить", async () => {
    const { id } = await session();
    const created = await app.call("POST", `/sessions/${id}/tasks`, { text: "  Разбей операцию B002.01.02 на шаги  ", scope: "o2", agent: "моделист" });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ status: "open", text: "Разбей операцию B002.01.02 на шаги", scopeNodeId: "o2", agent: "моделист", proposals: [], createdBy: "local" });
    const tid = created.body.id as string;

    expect((await app.call("GET", `/agent/sessions/${id}/tasks`)).body.map((t: any) => t.id)).toEqual([tid]);
    const taken = await app.call("POST", `/agent/tasks/${tid}/take`, { agent: "моделист" });
    expect(taken.body).toMatchObject({ status: "taken", takenBy: "моделист" });
    expect((await app.call("POST", `/agent/tasks/${tid}/take`, { agent: "другой" })).status).toBe(409); // уже взято
    expect((await app.call("GET", `/agent/sessions/${id}/tasks`)).body).toEqual([]); // ожидающих нет
    expect((await app.call("GET", `/agent/sessions/${id}/tasks?status=taken`)).body).toHaveLength(1);

    const prop = await app.call("POST", `/agent/sessions/${id}/proposals`, proposal({ task_id: tid }));
    expect(prop.status).toBe(201);
    const listed = (await app.call("GET", `/sessions/${id}/tasks`)).body[0];
    expect(listed.proposals).toEqual([{ id: prop.body.id, title: "Добавить шаг проверки реестра", status: "pending" }]);

    const done = await app.call("POST", `/agent/tasks/${tid}/complete`, { note: "Предложено 1 шаг; уточните исполнителя" });
    expect(done.body).toMatchObject({ status: "done", resultNote: "Предложено 1 шаг; уточните исполнителя" });
    expect((await app.call("POST", `/agent/tasks/${tid}/complete`, { note: "ещё" })).status).toBe(409);
    expect((await app.call("POST", `/agent/sessions/${id}/proposals`, proposal({ task_id: tid }))).status).toBe(409); // по закрытому заданию предложений нет
  });

  it("задания: проверки входных данных, чужие и несуществующие, отмена", async () => {
    const { id } = await session();
    const other = (await session()).id;
    expect((await app.call("POST", `/sessions/${id}/tasks`, { text: "" })).status).toBe(400);
    expect((await app.call("POST", `/sessions/${id}/tasks`, { text: "Х", scope: "нет-такой" })).status).toBe(400);
    expect((await app.call("POST", "/sessions/нет/tasks", { text: "Х" })).status).toBe(404);
    const t = (await app.call("POST", `/sessions/${id}/tasks`, { text: "Проверь роли" })).body;
    expect(t.scopeNodeId).toBeNull();
    // предложение по заданию другой сессии или несуществующему отклоняется
    expect((await app.call("POST", `/agent/sessions/${other}/proposals`, proposal({ task_id: t.id }))).status).toBe(404);
    expect((await app.call("POST", `/agent/sessions/${id}/proposals`, proposal({ task_id: "task_нет" }))).status).toBe(404);
    expect((await app.call("POST", "/agent/tasks/task_нет/take", { agent: "x" })).status).toBe(404);
    expect((await app.call("POST", `/agent/tasks/${t.id}/take`, {})).status).toBe(400);

    expect((await app.call("POST", `/tasks/${t.id}/cancel`)).body.status).toBe("cancelled");
    expect((await app.call("POST", `/tasks/${t.id}/cancel`)).status).toBe(409);
    expect((await app.call("POST", `/agent/tasks/${t.id}/take`, { agent: "x" })).status).toBe(409);
    expect((await app.call("POST", "/tasks/task_нет/cancel")).status).toBe(404);
    expect((await app.call("GET", `/sessions/${id}/tasks`)).body[0].status).toBe("cancelled");
    expect((await app.call("GET", `/agent/sessions/${id}/tasks?status=плохо`)).status).toBe(400);
  });

  it("задания удаляются вместе с сессией; доступ агента по токену — к заданиям, но не к постановке и отмене", async () => {
    const { id } = await session();
    const t = (await app.call("POST", `/sessions/${id}/tasks`, { text: "Проверь роли" })).body.id as string;
    process.env.AUTH_USERS = "analyst:pass";
    process.env.AGENT_API_TOKEN = "agent-secret-token-123";
    try {
      const bearer = { Authorization: "Bearer agent-secret-token-123" };
      expect((await app.withoutCookie("GET", `/agent/sessions/${id}/tasks`, bearer)).body).toHaveLength(1);
      expect((await app.withoutCookie("POST", `/agent/tasks/${t}/take`, bearer, { agent: "моделист" })).status).toBe(200);
      expect((await app.withoutCookie("POST", `/sessions/${id}/tasks`, bearer, { text: "Х" })).status).toBe(401);
      expect((await app.withoutCookie("POST", `/tasks/${t}/cancel`, bearer)).status).toBe(401);
    } finally {
      delete process.env.AUTH_USERS;
      delete process.env.AGENT_API_TOKEN;
    }
    expect((await app.call("DELETE", `/sessions/${id}`)).status).toBe(204);
    expect((await app.call("POST", `/agent/tasks/${t}/take`, { agent: "x" })).status).toBe(404); // записи уже нет
  });
  describe("вход агента по токену", () => {
    const TOKEN = "agent-secret-token-123";
    const setup = () => {
      process.env.AUTH_USERS = "analyst:pass";
      process.env.AGENT_API_TOKEN = TOKEN;
    };
    const teardown = () => {
      delete process.env.AUTH_USERS;
      delete process.env.AGENT_API_TOKEN;
    };

    it("по токену доступны только ручки /agent/*", async () => {
      const { id } = await session();
      setup();
      try {
        const bearer = { Authorization: `Bearer ${TOKEN}` };
        expect((await app.withoutCookie("GET", "/agent/sessions", {})).status).toBe(401);
        expect((await app.withoutCookie("GET", "/agent/sessions", bearer)).status).toBe(200);
        expect((await app.withoutCookie("GET", "/agent/sessions", { Authorization: "Bearer wrong-token-1234567" })).status).toBe(401);
        expect((await app.withoutCookie("GET", "/agent/sessions", { Authorization: `Basic ${TOKEN}` })).status).toBe(401);
        const created = await app.withoutCookie("POST", `/agent/sessions/${id}/proposals`, bearer, proposal());
        expect(created.status).toBe(201);
        // остальное API, в том числе решение по предложению, агенту закрыто
        expect((await app.withoutCookie("GET", `/sessions/${id}`, bearer)).status).toBe(401);
        expect((await app.withoutCookie("GET", `/sessions/${id}/proposals`, bearer)).status).toBe(401);
        expect((await app.withoutCookie("POST", `/proposals/${created.body.id}/resolve`, bearer, { status: "applied" })).status).toBe(401);
      } finally {
        teardown();
      }
    });

    it("без AGENT_API_TOKEN токен не принимается", async () => {
      process.env.AUTH_USERS = "analyst:pass";
      try {
        expect((await app.withoutCookie("GET", "/agent/sessions", { Authorization: "Bearer " })).status).toBe(401);
        expect((await app.withoutCookie("GET", "/agent/sessions", { Authorization: "Bearer undefined" })).status).toBe(401);
      } finally {
        teardown();
      }
    });
  });
});
