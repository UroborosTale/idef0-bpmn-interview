import { nanoid } from "nanoid";
import { db, logAudit } from "./db.js";
import { updateSession } from "./repo.js";
import type { ProcessLogicModel } from "./types/model.js";

/**
 * Общий репозиторий объектов организации (ТЗ, 3.2): роль, информационная система и документ хранятся один раз
 * и используются во многих процессах. Запись справочника модели ссылается на объект полем repo_id;
 * сама модель по-прежнему лежит в сессии, поэтому миграция данных не нужна.
 */
export type RepoClass = "role" | "system" | "data";
export const REPO_CLASSES: RepoClass[] = ["role", "system", "data"];

/** Ключ массива модели, в котором лежат записи класса. */
export const MODEL_KEY = { role: "roles", system: "systems", data: "data" } as const satisfies Record<RepoClass, keyof ProcessLogicModel>;

db.exec(`
CREATE TABLE IF NOT EXISTS repo_objects (
  id TEXT PRIMARY KEY,
  class TEXT NOT NULL,
  name TEXT NOT NULL,
  synonyms_json TEXT NOT NULL DEFAULT '[]',
  description TEXT,
  owner TEXT,
  kind TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`);

export interface RepoObject {
  id: string;
  class: RepoClass;
  name: string;
  synonyms: string[];
  description: string | null;
  owner: string | null;
  kind: string | null;
  created_at: string;
  updated_at: string;
}

function rowToObject(r: any): RepoObject {
  return { ...r, synonyms: JSON.parse(r.synonyms_json), synonyms_json: undefined } as RepoObject;
}

/** Сравнение названий без учёта регистра, ё/е и лишних пробелов. */
export const normName = (s: string) => s.trim().toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ");

export function getObject(id: string): RepoObject | null {
  const row = db.prepare(`SELECT * FROM repo_objects WHERE id = ?`).get(id);
  return row ? rowToObject(row) : null;
}

export function listObjects(cls?: RepoClass): RepoObject[] {
  const rows = cls
    ? db.prepare(`SELECT * FROM repo_objects WHERE class = ? ORDER BY name COLLATE NOCASE`).all(cls)
    : db.prepare(`SELECT * FROM repo_objects ORDER BY class, name COLLATE NOCASE`).all();
  return rows.map(rowToObject);
}

/** Объект класса с таким названием или синонимом (кроме `exceptId`). */
export function findByName(cls: RepoClass, name: string, exceptId?: string): RepoObject | null {
  const n = normName(name);
  return listObjects(cls).find((o) => o.id !== exceptId && (normName(o.name) === n || o.synonyms.some((s) => normName(s) === n))) ?? null;
}

/** Синонимы без пустых и повторов; название объекта синонимом не бывает. */
export function cleanSynonyms(name: string, synonyms: string[]): string[] {
  const seen = new Set([normName(name)]);
  const out: string[] = [];
  for (const s of synonyms) {
    const t = s.trim();
    if (!t || seen.has(normName(t))) continue;
    seen.add(normName(t));
    out.push(t);
  }
  return out;
}

export interface NewObject {
  class: RepoClass;
  name: string;
  synonyms?: string[];
  description?: string | null;
  owner?: string | null;
  kind?: string | null;
}

export function createObject(input: NewObject): RepoObject {
  const id = `obj_${nanoid(10)}`;
  const now = new Date().toISOString();
  const name = input.name.trim();
  db.prepare(`INSERT INTO repo_objects (id, class, name, synonyms_json, description, owner, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id,
    input.class,
    name,
    JSON.stringify(cleanSynonyms(name, input.synonyms ?? [])),
    input.description ?? null,
    input.owner ?? null,
    input.kind ?? null,
    now,
    now
  );
  return getObject(id)!;
}

export function saveObject(o: RepoObject): RepoObject {
  db.prepare(`UPDATE repo_objects SET name = ?, synonyms_json = ?, description = ?, owner = ?, kind = ?, updated_at = ? WHERE id = ?`).run(
    o.name,
    JSON.stringify(cleanSynonyms(o.name, o.synonyms)),
    o.description,
    o.owner,
    o.kind,
    new Date().toISOString(),
    o.id
  );
  return getObject(o.id)!;
}

// --- использование в сохранённых моделях ---

export interface LinkedEntry {
  sessionId: string;
  sessionTitle: string;
  approved: boolean;
  entryId: string;
  entryName: string;
  /** Сколько шагов модели используют эту запись. */
  uses: number;
}

/** Сколько шагов модели используют запись справочника. */
export function entryUses(model: ProcessLogicModel, cls: RepoClass, id: string): number {
  const nodes = new Set<string>();
  for (const n of model.nodes) {
    if (cls === "role" && n.role_id === id) nodes.add(n.id);
    if (cls === "system" && n.system_ids.includes(id)) nodes.add(n.id);
    if (cls === "data" && (n.inputs.includes(id) || n.outputs.includes(id) || (n.control_data_ids ?? []).includes(id))) nodes.add(n.id);
  }
  if (cls === "role") for (const a of model.assignments ?? []) if (a.role_id === id && a.node_id) nodes.add(a.node_id);
  return nodes.size;
}

interface SessionRow {
  id: string;
  title: string;
  model_json: string;
}

/** Сессии, чьи модели ссылаются на объект (предварительный отбор по тексту — без разбора всех моделей). */
function sessionsLinkedTo(repoId: string | null): { row: SessionRow; model: ProcessLogicModel }[] {
  const like = repoId ? `%"repo_id":${JSON.stringify(repoId)}%` : `%"repo_id":"%`;
  const rows = db.prepare(`SELECT id, title, model_json FROM sessions WHERE model_json LIKE ?`).all(like) as SessionRow[];
  return rows.map((row) => ({ row, model: JSON.parse(row.model_json) as ProcessLogicModel }));
}

/** Записи моделей, связанные с объектами: id объекта → записи. Для одного объекта — только его. */
export function linkedEntries(repoId?: string): Map<string, LinkedEntry[]> {
  const out = new Map<string, LinkedEntry[]>();
  for (const { row, model } of sessionsLinkedTo(repoId ?? null)) {
    const approved = model.process.status === "approved";
    for (const cls of REPO_CLASSES) {
      for (const e of model[MODEL_KEY[cls]] as { id: string; name: string; repo_id?: string | null }[]) {
        if (!e.repo_id || (repoId && e.repo_id !== repoId)) continue;
        const list = out.get(e.repo_id) ?? [];
        list.push({ sessionId: row.id, sessionTitle: row.title, approved, entryId: e.id, entryName: e.name, uses: entryUses(model, cls, e.id) });
        out.set(e.repo_id, list);
      }
    }
  }
  return out;
}

/**
 * Применяет правку к записям, связанным с объектом, во всех сохранённых моделях.
 * Утверждённые версии заблокированы от изменений (ФТ-М7.2.4): их записи правятся только при `includeApproved`
 * (перепривязка ссылки не меняет содержание модели), иначе пропускаются — их число возвращается.
 */
export function updateLinkedEntries(
  repoId: string,
  edit: (entry: Record<string, any>, cls: RepoClass) => boolean,
  opts: { includeApproved?: boolean; markDiagramsStale?: boolean } = {}
): { updated: number; skipped: number } {
  let updated = 0;
  let skipped = 0;
  for (const { row, model } of sessionsLinkedTo(repoId)) {
    const approved = model.process.status === "approved";
    if (approved && !opts.includeApproved) {
      skipped++;
      continue;
    }
    let changed = false;
    for (const cls of REPO_CLASSES) {
      for (const e of model[MODEL_KEY[cls]] as Record<string, any>[]) {
        if (e.repo_id === repoId && edit(e, cls)) changed = true;
      }
    }
    if (!changed) continue;
    updateSession(row.id, { model, ...(opts.markDiagramsStale ? { diagramsStale: true } : {}) });
    logAudit(row.id, "system", "repository_sync", { repoId });
    updated++;
  }
  return { updated, skipped };
}

/** Переносит значения объекта (название, описание, ответственного, вид) в связанные записи моделей. */
export function syncLinkedEntries(obj: RepoObject): { updated: number; skipped: number } {
  return updateLinkedEntries(
    obj.id,
    (e) => {
      let changed = false;
      const set = (key: string, value: unknown) => {
        if (value === undefined || (e[key] ?? null) === value) return;
        e[key] = value;
        changed = true;
      };
      set("name", obj.name);
      set("description", obj.description);
      set("owner", obj.owner);
      if (obj.kind) set("kind", obj.kind);
      return changed;
    },
    { markDiagramsStale: true }
  );
}

/**
 * Слияние дублей: записи всех моделей, связанные с `fromId`, переходят на `intoId`; название и синонимы
 * исходного объекта становятся синонимами целевого, исходный объект удаляется.
 */
export function mergeObjects(fromId: string, intoId: string): { object: RepoObject; relinked: number; skipped: number } {
  const from = getObject(fromId);
  const into = getObject(intoId);
  if (!from || !into) throw new Error("Объект не найден");
  const relinked = updateLinkedEntries(
    fromId,
    (e) => {
      e.repo_id = intoId;
      return true;
    },
    { includeApproved: true }
  ).updated;
  const merged = saveObject({ ...into, synonyms: [...into.synonyms, from.name, ...from.synonyms], description: into.description ?? from.description, owner: into.owner ?? from.owner });
  db.prepare(`DELETE FROM repo_objects WHERE id = ?`).run(fromId);
  // записи, перешедшие к целевому объекту, получают его название и карточку (утверждённые версии не меняются)
  const sync = syncLinkedEntries(merged);
  logAudit(null, "analyst", "repository_merge", { fromId, intoId, relinked });
  return { object: getObject(intoId)!, relinked, skipped: sync.skipped };
}
