import { Router } from "express";
import { z } from "zod";
import { db, logAudit } from "../db.js";
import {
  REPO_CLASSES,
  createObject,
  findByName,
  getObject,
  linkedEntries,
  listObjects,
  mergeObjects,
  normName,
  saveObject,
  syncLinkedEntries,
  type RepoClass,
} from "../objectRepo.js";

export const repositoryRouter = Router();

const Cls = z.enum(REPO_CLASSES as [RepoClass, ...RepoClass[]]);
const Text = z.string().trim().max(2000).nullable().optional();
const KINDS: Record<RepoClass, string[]> = { role: ["internal", "external"], system: [], data: ["document", "data"] };

const NewBody = z.object({
  class: Cls,
  name: z.string().trim().min(1).max(300),
  synonyms: z.array(z.string().max(300)).max(50).optional(),
  description: Text,
  owner: Text,
  kind: z.string().max(40).nullable().optional(),
});
const PatchBody = NewBody.omit({ class: true }).partial();

const badKind = (cls: RepoClass, kind: string | null | undefined) => !!kind && !KINDS[cls].includes(kind);

/** Объекты репозитория с числом процессов и записей, где они используются; фильтры: class, q (название или синоним). */
repositoryRouter.get("/repository", (req, res) => {
  const cls = Cls.safeParse(req.query.class);
  const q = typeof req.query.q === "string" ? normName(req.query.q) : "";
  const links = linkedEntries();
  const rows = listObjects(cls.success ? cls.data : undefined)
    .filter((o) => !q || normName(o.name).includes(q) || o.synonyms.some((s) => normName(s).includes(q)))
    .map((o) => {
      const used = links.get(o.id) ?? [];
      return { ...o, sessions: new Set(used.map((u) => u.sessionId)).size, entries: used.length, uses: used.reduce((a, u) => a + u.uses, 0) };
    });
  res.json(rows);
});

repositoryRouter.post("/repository", (req, res) => {
  const body = NewBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Укажите класс (role, system, data) и название" });
    return;
  }
  const b = body.data;
  if (badKind(b.class, b.kind)) {
    res.status(400).json({ error: "Недопустимый вид объекта" });
    return;
  }
  const existing = findByName(b.class, b.name);
  if (existing) {
    // клиент берёт существующий объект и связывает с ним запись модели, а не заводит дубль
    res.status(409).json({ error: `Объект «${existing.name}» уже есть в репозитории`, existing });
    return;
  }
  const obj = createObject({ ...b, synonyms: b.synonyms });
  logAudit(null, "analyst", "repository_create", { id: obj.id, class: obj.class, name: obj.name });
  res.status(201).json(obj);
});

/** Объект класса с таким названием или синонимом (без учёта регистра) — чтобы не заводить дубль. Стоит раньше /repository/:id. */
repositoryRouter.get("/repository/match", (req, res) => {
  const cls = Cls.safeParse(req.query.class);
  const name = typeof req.query.name === "string" ? req.query.name : "";
  if (!cls.success || !name.trim()) {
    res.status(400).json({ error: "Укажите класс и название" });
    return;
  }
  res.json({ object: findByName(cls.data, name) });
});

/** Объект и все записи моделей, которые на него ссылаются («где используется»). */
repositoryRouter.get("/repository/:id", (req, res) => {
  const obj = getObject(req.params.id);
  if (!obj) {
    res.status(404).json({ error: "Объект не найден" });
    return;
  }
  res.json({ ...obj, usage: linkedEntries(obj.id).get(obj.id) ?? [] });
});

/**
 * Правка объекта. Название, описание, ответственный и вид переносятся в связанные записи моделей
 * (propagate=false — только в репозитории); старое название остаётся синонимом. Утверждённые версии не меняются.
 */
repositoryRouter.patch("/repository/:id", (req, res) => {
  const obj = getObject(req.params.id);
  if (!obj) {
    res.status(404).json({ error: "Объект не найден" });
    return;
  }
  const body = PatchBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Неверные поля объекта" });
    return;
  }
  const p = body.data;
  if (badKind(obj.class, p.kind)) {
    res.status(400).json({ error: "Недопустимый вид объекта" });
    return;
  }
  const next = { ...obj };
  if (p.name !== undefined && p.name !== obj.name) {
    const clash = findByName(obj.class, p.name, obj.id);
    if (clash) {
      res.status(409).json({ error: `Название занято объектом «${clash.name}» — объедините их`, existing: clash });
      return;
    }
    next.synonyms = [...next.synonyms, obj.name];
    next.name = p.name;
  }
  if (p.synonyms !== undefined) {
    for (const s of p.synonyms) {
      const clash = normName(s) !== normName(next.name) ? findByName(obj.class, s, obj.id) : null;
      if (clash) {
        res.status(409).json({ error: `Синоним «${s}» уже принадлежит объекту «${clash.name}» — объедините их`, existing: clash });
        return;
      }
    }
    next.synonyms = p.synonyms;
  }
  if (p.description !== undefined) next.description = p.description || null;
  if (p.owner !== undefined) next.owner = p.owner || null;
  if (p.kind !== undefined) next.kind = p.kind;
  const saved = saveObject(next);
  // except — сессия, из открытого окна которой пришла правка: её модель обновится сохранением черновика, поэтому здесь её не трогаем (иначе сохранение даст конфликт версий)
  const except = typeof req.query.except === "string" && req.query.except ? req.query.except : undefined;
  const sync = req.query.propagate === "0" ? { updated: 0, skipped: 0 } : syncLinkedEntries(saved, except);
  logAudit(null, "analyst", "repository_update", { id: saved.id, name: saved.name, ...sync });
  res.json({ object: saved, ...sync });
});

/** Слияние дублей: записи моделей переходят на целевой объект, название исходного становится синонимом. */
repositoryRouter.post("/repository/:id/merge", (req, res) => {
  const from = getObject(req.params.id);
  const into = getObject(String(req.body?.intoId ?? ""));
  if (!from || !into) {
    res.status(404).json({ error: "Объект не найден" });
    return;
  }
  if (from.id === into.id || from.class !== into.class) {
    res.status(400).json({ error: "Объединять можно разные объекты одного класса" });
    return;
  }
  const r = mergeObjects(from.id, into.id);
  res.json(r);
});

/** Удаление: пока объект используется в моделях — только с заменой (replaceWith), иначе 409 со списком мест. */
repositoryRouter.delete("/repository/:id", (req, res) => {
  const obj = getObject(req.params.id);
  if (!obj) {
    res.status(404).json({ error: "Объект не найден" });
    return;
  }
  const usage = linkedEntries(obj.id).get(obj.id) ?? [];
  const replaceWith = typeof req.query.replaceWith === "string" ? req.query.replaceWith : "";
  if (usage.length && !replaceWith) {
    res.status(409).json({ error: `Объект используется в ${new Set(usage.map((u) => u.sessionId)).size} проц. — укажите замену`, usage });
    return;
  }
  if (usage.length) {
    const target = getObject(replaceWith);
    if (!target || target.id === obj.id || target.class !== obj.class) {
      res.status(400).json({ error: "Замена должна быть другим объектом того же класса" });
      return;
    }
    res.json(mergeObjects(obj.id, target.id));
    return;
  }
  db.prepare(`DELETE FROM repo_objects WHERE id = ?`).run(obj.id);
  logAudit(null, "analyst", "repository_delete", { id: obj.id, name: obj.name });
  res.status(204).end();
});
