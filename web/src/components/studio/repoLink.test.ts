import { describe, expect, it } from "vitest";
import type { RepoObject } from "../../api/types";
import { purchaseModel } from "../../test/fixtures";
import { REPO_CLASS, addLinkedEntry, entriesOf, hasRepoObject, repoIdOf, updateEntry } from "./dict-ops";

const obj = (over: Partial<RepoObject>): RepoObject => ({
  id: "obj_1",
  class: "role",
  name: "Менеджер по закупкам",
  synonyms: [],
  description: "Ведёт закупки",
  owner: "Отдел закупок",
  kind: "external",
  created_at: "",
  updated_at: "",
  ...over,
});

describe("справочники: общий репозиторий", () => {
  it("в репозитории ведутся роли, системы и документы — регламенты и показатели остаются в модели", () => {
    expect(REPO_CLASS).toEqual({ roles: "role", systems: "system", data: "data" });
  });

  it("объект репозитория становится записью модели со ссылкой, карточкой и видом", () => {
    const m = purchaseModel();
    const { model, id } = addLinkedEntry(m, "roles", obj({}));
    const role = model.roles.find((r) => r.id === id)!;
    expect(role).toMatchObject({ name: "Менеджер по закупкам", repo_id: "obj_1", description: "Ведёт закупки", owner: "Отдел закупок", kind: "external" });
    expect(repoIdOf(model, "roles", id)).toBe("obj_1");
    expect(hasRepoObject(model, "roles", "obj_1")).toBe(true);
    expect(hasRepoObject(m, "roles", "obj_1")).toBe(false);
  });

  it("система и документ получают ссылку; вид документа берётся из объекта", () => {
    const m = purchaseModel();
    const sys = addLinkedEntry(m, "systems", obj({ id: "obj_s", class: "system", name: "SAP", kind: null }));
    expect(sys.model.systems.find((s) => s.id === sys.id)).toMatchObject({ name: "SAP", repo_id: "obj_s" });
    const doc = addLinkedEntry(m, "data", obj({ id: "obj_d", class: "data", name: "Счёт", kind: "data" }));
    expect(doc.model.data.find((d) => d.id === doc.id)).toMatchObject({ name: "Счёт", kind: "data", repo_id: "obj_d" });
  });

  it("привязка существующей записи не трогает остальные поля", () => {
    const m = purchaseModel();
    const first = entriesOf(m, "data")[0];
    const linked = updateEntry(m, "data", first.id, { repo_id: "obj_9" });
    expect(repoIdOf(linked, "data", first.id)).toBe("obj_9");
    expect(entriesOf(linked, "data")[0]).toMatchObject({ ...first, repo_id: "obj_9" });
    expect(repoIdOf(m, "data", first.id)).toBeNull();
  });
});
