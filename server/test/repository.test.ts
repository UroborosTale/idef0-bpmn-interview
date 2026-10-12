import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApp } from "./api.js";

delete process.env.AUTH_USERS;

let app: Awaited<ReturnType<typeof startApp>>;
beforeAll(async () => {
  app = await startApp();
});
afterAll(() => app.close());

/** Процесс с одной ролью, системой и документом; записи связаны с объектами репозитория, если id переданы. */
async function makeProcess(name: string, link: { role?: string; system?: string; data?: string }, status?: "approved") {
  const s = (await app.call("POST", "/sessions/blank", { meta: { processName: name } })).body;
  const model = s.model;
  model.roles = [{ id: "r1", name: "Закупщик", kind: "internal", source: [], repo_id: link.role }];
  model.systems = [{ id: "s1", name: "1С", source: [], repo_id: link.system }];
  model.data = [{ id: "d1", name: "Заявка", kind: "document", source: [], repo_id: link.data }];
  model.nodes = [{ id: "n1", type: "task", name: "Оформить заявку", role_id: "r1", system_ids: ["s1"], inputs: ["d1"], status: "confirmed", confidence: 1 }];
  if (status) model.process.status = status;
  const put = await app.call("PUT", `/sessions/${s.id}/model`, model, { "X-Base-Updated-At": s.updatedAt });
  expect(put.status).toBe(200);
  return put.body as { id: string; model: any };
}
const get = async (id: string) => (await app.call("GET", `/sessions/${id}`)).body;
const create = async (body: Record<string, unknown>) => (await app.call("POST", "/repository", body)).body;

describe("общий репозиторий объектов", () => {
  it("объект создаётся; повтор по названию или синониму — 409 с существующим объектом", async () => {
    const r = await app.call("POST", "/repository", { class: "role", name: "Менеджер по закупкам", synonyms: ["Закупщик (старший)"], kind: "internal" });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ class: "role", name: "Менеджер по закупкам", synonyms: ["Закупщик (старший)"], kind: "internal" });
    const byName = await app.call("POST", "/repository", { class: "role", name: "  менеджер  по закупкам " });
    expect(byName.status).toBe(409);
    expect(byName.body.existing.id).toBe(r.body.id);
    expect((await app.call("POST", "/repository", { class: "role", name: "закупщик (СТАРШИЙ)" })).status).toBe(409);
    // тот же текст в другом классе — другой объект
    expect((await app.call("POST", "/repository", { class: "system", name: "Менеджер по закупкам" })).status).toBe(201);
    expect((await app.call("POST", "/repository", { class: "role", name: "" })).status).toBe(400);
    expect((await app.call("POST", "/repository", { class: "role", name: "X", kind: "document" })).status).toBe(400);
  });

  it("except: правка из открытого окна процесса не трогает его сохранённую модель (иначе сохранение черновика даст конфликт), остальные процессы обновляются", async () => {
    const sys = await create({ class: "system", name: "Учётка", description: null });
    const mine = await makeProcess("Мой процесс", { system: sys.id });
    const other = await makeProcess("Чужой процесс", { system: sys.id });
    const before = (await get(mine.id)).updatedAt;
    const r = await app.call("PATCH", `/repository/${sys.id}?except=${mine.id}`, { name: "Учётка 2.0", description: "новая" });
    expect(r.status).toBe(200);
    expect(r.body.updated).toBe(1);
    expect((await get(other.id)).model.systems[0]).toMatchObject({ name: "Учётка 2.0", description: "новая" });
    const own = await get(mine.id);
    expect(own.model.systems[0].name).toBe("1С"); // не тронута
    expect(own.updatedAt).toBe(before); // версия не сдвинулась — сохранение черновика пройдёт без конфликта
    expect((await app.call("GET", `/repository/${sys.id}`)).body.name).toBe("Учётка 2.0");
  });

  it("список ищет по названию и синониму и считает, где объект используется", async () => {
    const role = await create({ class: "role", name: "Аналитик закупок", synonyms: ["Закупочный аналитик"] });
    const a = await makeProcess("Закупка А", { role: role.id });
    const b = await makeProcess("Закупка Б", { role: role.id });
    const list = (await app.call("GET", "/repository?class=role&q=закупочный")).body;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: role.id, sessions: 2, entries: 2, uses: 2 });
    const one = (await app.call("GET", `/repository/${role.id}`)).body;
    expect(one.usage.map((u: any) => u.sessionId).sort()).toEqual([a.id, b.id].sort());
    expect(one.usage[0]).toMatchObject({ entryId: "r1", uses: 1 });
  });

  it("переименование переносится в связанные записи моделей; старое название становится синонимом", async () => {
    const sys = await create({ class: "system", name: "SAP ERP" });
    const p = await makeProcess("Закупка В", { system: sys.id });
    const r = await app.call("PATCH", `/repository/${sys.id}`, { name: "SAP S/4HANA", description: "Учётная система" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ updated: 1, skipped: 0 });
    expect(r.body.object.synonyms).toContain("SAP ERP");
    const s = await get(p.id);
    expect(s.model.systems[0]).toMatchObject({ name: "SAP S/4HANA", description: "Учётная система", repo_id: sys.id });
    expect(s.diagramsStale).toBe(true);
    // propagate=0 — только репозиторий
    const q = await app.call("PATCH", `/repository/${sys.id}?propagate=0`, { owner: "ИТ" });
    expect(q.body).toMatchObject({ updated: 0 });
    expect((await get(p.id)).model.systems[0].owner ?? null).toBeNull();
  });

  it("утверждённая версия при переименовании не меняется — её число сообщается", async () => {
    const sys = await create({ class: "system", name: "Битрикс" });
    const draft = await makeProcess("Продажи", { system: sys.id });
    const approved = await makeProcess("Договоры", { system: sys.id }, "approved");
    const r = await app.call("PATCH", `/repository/${sys.id}`, { name: "Битрикс24" });
    expect(r.body).toMatchObject({ updated: 1, skipped: 1 });
    expect((await get(draft.id)).model.systems[0].name).toBe("Битрикс24");
    expect((await get(approved.id)).model.systems[0].name).toBe("1С");
  });

  it("название и синоним нельзя отдать чужому объекту", async () => {
    const a = await create({ class: "data", name: "Счёт на оплату" });
    const b = await create({ class: "data", name: "Накладная" });
    expect((await app.call("PATCH", `/repository/${b.id}`, { name: "счет на оплату" })).status).toBe(409);
    expect((await app.call("PATCH", `/repository/${b.id}`, { synonyms: ["Счёт на оплату"] })).status).toBe(409);
    expect((await app.call("PATCH", `/repository/${a.id}`, { synonyms: ["Инвойс"] })).status).toBe(200);
  });

  it("слияние дублей: записи переходят на целевой объект, название исходного — синоним", async () => {
    const keep = await create({ class: "role", name: "Руководитель отдела", description: "Основной" });
    const dup = await create({ class: "role", name: "Начальник отдела", synonyms: ["Нач. отдела"] });
    const p = await makeProcess("Согласование", { role: dup.id });
    const approved = await makeProcess("Приказы", { role: dup.id }, "approved");
    const r = await app.call("POST", `/repository/${dup.id}/merge`, { intoId: keep.id });
    expect(r.status).toBe(200);
    expect(r.body.object.synonyms).toEqual(expect.arrayContaining(["Начальник отдела", "Нач. отдела"]));
    expect((await app.call("GET", `/repository/${dup.id}`)).status).toBe(404);
    const draft = (await get(p.id)).model.roles[0];
    expect(draft).toMatchObject({ repo_id: keep.id, name: "Руководитель отдела", description: "Основной" });
    // утверждённая версия получает новую ссылку, но содержание не меняет
    expect((await get(approved.id)).model.roles[0]).toMatchObject({ repo_id: keep.id, name: "Закупщик" });
    expect((await app.call("GET", `/repository/${keep.id}`)).body.usage).toHaveLength(2);
    // нельзя объединять объект с собой и объекты разных классов
    const sys = await create({ class: "system", name: "Другая система" });
    expect((await app.call("POST", `/repository/${keep.id}/merge`, { intoId: keep.id })).status).toBe(400);
    expect((await app.call("POST", `/repository/${keep.id}/merge`, { intoId: sys.id })).status).toBe(400);
  });

  it("слияние сообщает, в скольких процессах теперь две записи с одним названием", async () => {
    const keep = await create({ class: "role", name: "Главный технолог" });
    const dup = await create({ class: "role", name: "Технолог главный" });
    // в одной модели обе записи сразу
    const s = (await app.call("POST", "/sessions/blank", { meta: { processName: "Две роли" } })).body;
    const model = s.model;
    model.roles = [
      { id: "r1", name: "Главный технолог", kind: "internal", source: [], repo_id: keep.id },
      { id: "r2", name: "Технолог главный", kind: "internal", source: [], repo_id: dup.id },
    ];
    expect((await app.call("PUT_BASE", `/sessions/${s.id}/model|${s.updatedAt}`, model)).status).toBe(200);
    // в другой — только дубль
    await makeProcess("Одна роль", { role: dup.id });
    const r = await app.call("POST", `/repository/${dup.id}/merge`, { intoId: keep.id });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ relinked: 2, duplicated: 1 }); // обновлено процессов: 2; в одном из них теперь две записи с одним названием
  });

  it("используемый объект удалить нельзя без замены; неиспользуемый удаляется", async () => {
    const doc = await create({ class: "data", name: "Договор поставки" });
    const other = await create({ class: "data", name: "Договор оказания услуг" });
    const p = await makeProcess("Договорная работа", { data: doc.id });
    const refused = await app.call("DELETE", `/repository/${doc.id}`);
    expect(refused.status).toBe(409);
    expect(refused.body.usage[0]).toMatchObject({ sessionId: p.id, entryId: "d1" });
    expect((await app.call("DELETE", `/repository/${doc.id}?replaceWith=${(await create({ class: "role", name: "Роль" })).id}`)).status).toBe(400);
    expect((await app.call("DELETE", `/repository/${doc.id}?replaceWith=${other.id}`)).status).toBe(200);
    expect((await get(p.id)).model.data[0]).toMatchObject({ repo_id: other.id, name: "Договор оказания услуг" });
    expect((await app.call("DELETE", `/repository/${other.id}`)).status).toBe(409);
    const unused = await create({ class: "data", name: "Черновик" });
    expect((await app.call("DELETE", `/repository/${unused.id}`)).status).toBe(204);
    expect((await app.call("GET", `/repository/${unused.id}`)).status).toBe(404);
  });

  it("repo_id сохраняется в модели при сохранении и читается обратно", async () => {
    const p = await makeProcess("Проверка поля", { role: "obj_test" });
    expect((await get(p.id)).model.roles[0].repo_id).toBe("obj_test");
  });
});
