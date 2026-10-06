import { Router } from "express";
import { nanoid } from "nanoid";
import { db, logAudit } from "../db.js";

export const requirementsRouter = Router();

interface RequirementRow {
  id: string;
  code: string;
  title: string;
  source: string;
  created_at: string;
}

/** ФТ-М6.1: реестр требований (стандарты, НПА, внутренние стандарты) — предзаполнен кратким каталогом ISO 9001:2015 §4.4 при первом запуске (см. db.ts). */
requirementsRouter.get("/requirements", (req, res) => {
  const { source, q } = req.query as { source?: string; q?: string };
  const clauses: string[] = [];
  const params: any[] = [];
  if (source) {
    clauses.push("source = ?");
    params.push(source);
  }
  if (q) {
    clauses.push("(code LIKE ? OR title LIKE ?)");
    params.push(`%${q}%`, `%${q}%`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  res.json(db.prepare(`SELECT * FROM requirements ${where} ORDER BY source, code`).all(...params));
});

requirementsRouter.post("/requirements", (req, res) => {
  const { code, title, source } = req.body as { code: string; title: string; source?: string };
  if (!code || !title) {
    res.status(400).json({ error: "code and title are required" });
    return;
  }
  const id = `req_${nanoid(10)}`;
  db.prepare(`INSERT INTO requirements (id, code, title, source, created_at) VALUES (?, ?, ?, ?, ?)`).run(id, code, title, source ?? "internal", new Date().toISOString());
  logAudit(null, "analyst", "requirement_added", { id, code });
  res.status(201).json({ id, code, title, source: source ?? "internal" } satisfies Omit<RequirementRow, "created_at">);
});

requirementsRouter.patch("/requirements/:id", (req, res) => {
  const existing = db.prepare(`SELECT * FROM requirements WHERE id = ?`).get(req.params.id) as RequirementRow | undefined;
  if (!existing) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const { code, title, source } = req.body as Partial<RequirementRow>;
  db.prepare(`UPDATE requirements SET code = ?, title = ?, source = ? WHERE id = ?`).run(
    code ?? existing.code,
    title ?? existing.title,
    source ?? existing.source,
    req.params.id
  );
  res.json({ ...existing, code: code ?? existing.code, title: title ?? existing.title, source: source ?? existing.source });
});

requirementsRouter.delete("/requirements/:id", (req, res) => {
  db.prepare(`DELETE FROM requirements WHERE id = ?`).run(req.params.id);
  res.status(204).end();
});
