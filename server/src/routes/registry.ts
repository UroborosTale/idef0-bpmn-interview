import { Router } from "express";
import { db, logAudit } from "../db.js";
import { nanoid } from "nanoid";
import * as XLSX from "xlsx";
import { detectDuplicates } from "../pipeline/duplicates.js";

export const registryRouter = Router();

// Библиотека xlsx содержит непропатченные уязвимости в пути ПАРСИНГА файлов
// (prototype pollution, ReDoS — GHSA-4r6h-8v6p-xvw6, GHSA-5pgg-2g8v-p4x9).
// Здесь она используется ТОЛЬКО для записи книг из собственных данных сервера
// (никогда для чтения загруженных пользователем файлов) — это не затрагивает
// уязвимый путь. Импорт из файлов (см. glossary.ts) сделан без этой библиотеки.

interface ProcessRow {
  id: string;
  code: string | null;
  name: string;
  level: "L0" | "L1" | "L2" | "L3";
  parent_process_id: string | null;
  classification: "main" | "support" | "management";
  owner: string | null;
  department: string | null;
  status: "draft" | "review" | "needs_rework" | "approved" | "archived";
  version: string;
  review_date: string | null;
  session_id: string | null;
  created_at: string;
  updated_at: string;
}

function rowOut(r: ProcessRow) {
  return { ...r };
}

/** ФТ-М3.1: реестр процессов — список с фильтрами и поиском. */
registryRouter.get("/registry", (req, res) => {
  const { level, classification, department, status, q } = req.query as Record<string, string | undefined>;
  const clauses: string[] = [];
  const params: any[] = [];
  if (level) {
    clauses.push("level = ?");
    params.push(level);
  }
  if (classification) {
    clauses.push("classification = ?");
    params.push(classification);
  }
  if (department) {
    clauses.push("department = ?");
    params.push(department);
  }
  if (status) {
    clauses.push("status = ?");
    params.push(status);
  }
  if (q) {
    clauses.push("(name LIKE ? OR code LIKE ?)");
    params.push(`%${q}%`, `%${q}%`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db.prepare(`SELECT * FROM processes ${where} ORDER BY level, code, name`).all(...params) as ProcessRow[];
  res.json(rows.map(rowOut));
});

// ВАЖНО: литеральные пути /registry/links, /registry/export/xlsx и т.п.
// зарегистрированы РАНЬШЕ параметризованного /registry/:id — иначе Express
// сопоставит их с :id (в частности, /registry/links совпадает по числу
// сегментов с /registry/:id, что "проглатывает" запрос).
/** ФТ-М3.2: связи между процессами — стыки вход/выход (список + подтверждение). */
registryRouter.get("/registry/links", (_req, res) => {
  const rows = db.prepare(`SELECT * FROM process_links ORDER BY created_at DESC`).all();
  res.json(rows);
});

/** ФТ-М3.3: карта процессов — узлы реестра (с иерархией L0-L3) и подтверждённые связи между ними. */
registryRouter.get("/registry/map", (_req, res) => {
  const nodes = (db.prepare(`SELECT id, code, name, level, parent_process_id, classification, status FROM processes ORDER BY level, name`).all() as any[]).map(
    (r) => ({ id: r.id, code: r.code, name: r.name, level: r.level, parentProcessId: r.parent_process_id, classification: r.classification, status: r.status })
  );
  const edges = (db.prepare(`SELECT id, from_process_id, to_process_id, data_label, confirmed FROM process_links WHERE confirmed = 1`).all() as any[]).map((r) => ({
    id: r.id,
    from: r.from_process_id,
    to: r.to_process_id,
    label: r.data_label,
  }));
  res.json({ nodes, edges });
});

/** ФТ-М3.4: кандидаты в дубли реестра — эвристика по схожести названий (без учёта уже отклонённых пар). */
registryRouter.get("/registry/duplicates", (_req, res) => {
  const processes = db.prepare(`SELECT id, name, classification, department, level FROM processes`).all() as {
    id: string;
    name: string;
    classification: string;
    department: string | null;
    level: string;
  }[];
  const dismissed = new Set(
    (db.prepare(`SELECT from_process_id, to_process_id FROM duplicate_dismissals`).all() as { from_process_id: string; to_process_id: string }[]).map((d) =>
      [d.from_process_id, d.to_process_id].sort().join("|")
    )
  );
  res.json(detectDuplicates(processes, dismissed));
});

registryRouter.post("/registry/duplicates/dismiss", (req, res) => {
  const { aId, bId } = req.body as { aId: string; bId: string };
  if (!aId || !bId) {
    res.status(400).json({ error: "aId and bId are required" });
    return;
  }
  db.prepare(`INSERT OR IGNORE INTO duplicate_dismissals (from_process_id, to_process_id, created_at) VALUES (?, ?, ?)`).run(aId, bId, new Date().toISOString());
  logAudit(null, "analyst", "duplicate_dismissed", { aId, bId });
  res.status(204).end();
});

/** ФТ-М6.5: проверка актуальности реестра — просроченные даты планового пересмотра. */
registryRouter.get("/registry/staleness", (_req, res) => {
  const rows = db.prepare(`SELECT id, name, review_date, status, updated_at FROM processes`).all() as {
    id: string;
    name: string;
    review_date: string | null;
    status: string;
    updated_at: string;
  }[];
  const today = new Date();
  const result = rows.map((r) => {
    let reviewOverdue = false;
    let daysOverdue = 0;
    if (r.review_date) {
      const reviewDate = new Date(r.review_date);
      if (!Number.isNaN(reviewDate.getTime()) && reviewDate.getTime() < today.getTime()) {
        reviewOverdue = true;
        daysOverdue = Math.floor((today.getTime() - reviewDate.getTime()) / 86400000);
      }
    }
    return { processId: r.id, name: r.name, status: r.status, reviewDate: r.review_date, reviewOverdue, daysOverdue, updatedAt: r.updated_at };
  });
  res.json(result.filter((r) => r.reviewOverdue || !r.reviewDate));
});

registryRouter.get("/registry/:id", (req, res) => {
  const row = db.prepare(`SELECT * FROM processes WHERE id = ?`).get(req.params.id) as ProcessRow | undefined;
  if (!row) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json(rowOut(row));
});

registryRouter.post("/registry", (req, res) => {
  const body = req.body as Partial<ProcessRow>;
  if (!body.name) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  const id = `proc_${nanoid(10)}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO processes (id, code, name, level, parent_process_id, classification, owner, department, status, version, review_date, session_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    body.code ?? null,
    body.name,
    body.level ?? "L2",
    body.parent_process_id ?? null,
    body.classification ?? "main",
    body.owner ?? null,
    body.department ?? null,
    body.status ?? "draft",
    body.version ?? "0.1",
    body.review_date ?? null,
    body.session_id ?? null,
    now,
    now
  );
  logAudit(null, "analyst", "registry_process_created", { id, name: body.name });
  res.status(201).json(rowOut(db.prepare(`SELECT * FROM processes WHERE id = ?`).get(id) as ProcessRow));
});

registryRouter.patch("/registry/:id", (req, res) => {
  const existing = db.prepare(`SELECT * FROM processes WHERE id = ?`).get(req.params.id) as ProcessRow | undefined;
  if (!existing) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const body = req.body as Partial<ProcessRow>;
  const merged: ProcessRow = { ...existing, ...body, id: existing.id, updated_at: new Date().toISOString() };
  db.prepare(
    `UPDATE processes SET code=?, name=?, level=?, parent_process_id=?, classification=?, owner=?, department=?, status=?, version=?, review_date=?, session_id=?, updated_at=?
     WHERE id=?`
  ).run(
    merged.code,
    merged.name,
    merged.level,
    merged.parent_process_id,
    merged.classification,
    merged.owner,
    merged.department,
    merged.status,
    merged.version,
    merged.review_date,
    merged.session_id,
    merged.updated_at,
    merged.id
  );
  logAudit(null, "analyst", "registry_process_updated", { id: merged.id });
  res.json(rowOut(merged));
});

registryRouter.delete("/registry/:id", (req, res) => {
  db.prepare(`DELETE FROM processes WHERE id = ?`).run(req.params.id);
  db.prepare(`DELETE FROM process_links WHERE from_process_id = ? OR to_process_id = ?`).run(req.params.id, req.params.id);
  logAudit(null, "analyst", "registry_process_deleted", { id: req.params.id });
  res.status(204).end();
});

/** ФТ-М3.1.4: выгрузка реестра в .xlsx. */
registryRouter.get("/registry/export/xlsx", (_req, res) => {
  const rows = db.prepare(`SELECT * FROM processes ORDER BY level, code, name`).all() as ProcessRow[];
  const CLASS_LABEL: Record<string, string> = { main: "Основной", support: "Обеспечивающий", management: "Управленческий" };
  const STATUS_LABEL: Record<string, string> = { draft: "Черновик", review: "На согласовании", needs_rework: "На доработке", approved: "Утверждён", archived: "Архив" };
  const sheetRows = rows.map((r) => ({
    Код: r.code ?? "",
    Название: r.name,
    Уровень: r.level,
    "Родительский процесс": r.parent_process_id ?? "",
    Классификация: CLASS_LABEL[r.classification] ?? r.classification,
    Владелец: r.owner ?? "",
    Подразделение: r.department ?? "",
    Статус: STATUS_LABEL[r.status] ?? r.status,
    Версия: r.version,
    "Дата пересмотра": r.review_date ?? "",
  }));
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(sheetRows);
  ws["!cols"] = [{ wch: 10 }, { wch: 40 }, { wch: 8 }, { wch: 16 }, { wch: 16 }, { wch: 20 }, { wch: 20 }, { wch: 14 }, { wch: 8 }, { wch: 14 }];
  XLSX.utils.book_append_sheet(wb, ws, "Реестр процессов");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  res.setHeader("Content-Disposition", `attachment; filename="registry.xlsx"`);
  res.type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet").send(buf);
});

registryRouter.post("/registry/links", (req, res) => {
  const { from_process_id, to_process_id, data_label, confirmed } = req.body as {
    from_process_id: string;
    to_process_id: string;
    data_label: string;
    confirmed?: boolean;
  };
  if (!from_process_id || !to_process_id || !data_label) {
    res.status(400).json({ error: "from_process_id, to_process_id, data_label are required" });
    return;
  }
  const id = `link_${nanoid(10)}`;
  db.prepare(`INSERT INTO process_links (id, from_process_id, to_process_id, data_label, confirmed, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
    id,
    from_process_id,
    to_process_id,
    data_label,
    confirmed ? 1 : 0,
    new Date().toISOString()
  );
  res.status(201).json({ id, from_process_id, to_process_id, data_label, confirmed: !!confirmed });
});

registryRouter.patch("/registry/links/:id/confirm", (req, res) => {
  db.prepare(`UPDATE process_links SET confirmed = 1 WHERE id = ?`).run(req.params.id);
  logAudit(null, "analyst", "process_link_confirmed", { id: req.params.id });
  res.status(204).end();
});

registryRouter.delete("/registry/links/:id", (req, res) => {
  db.prepare(`DELETE FROM process_links WHERE id = ?`).run(req.params.id);
  res.status(204).end();
});

/**
 * ФТ-М3.2.1: автопоиск стыков — выход процесса A совпадает с входом процесса B
 * по нормализованному имени объекта данных (сравнение выходов/входов моделей
 * связанных сессий). Предлагает кандидатов, не создаёт связи автоматически —
 * подтверждение остаётся за аналитиком (3.2.2).
 */
registryRouter.get("/registry/links/suggest", (_req, res) => {
  const rows = db.prepare(`SELECT id, session_id FROM processes WHERE session_id IS NOT NULL`).all() as { id: string; session_id: string }[];
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

  type Endpoint = { processId: string; dataName: string };
  const outputs: Endpoint[] = [];
  const inputs: Endpoint[] = [];

  for (const r of rows) {
    const sess = db.prepare(`SELECT model_json FROM sessions WHERE id = ?`).get(r.session_id) as { model_json: string | null } | undefined;
    if (!sess?.model_json) continue;
    const model = JSON.parse(sess.model_json);
    const dataById = new Map<string, string>((model.data ?? []).map((d: any) => [d.id, d.name]));
    const producedIds = new Set<string>();
    const consumedIds = new Set<string>();
    for (const n of model.nodes ?? []) {
      for (const outId of n.outputs ?? []) producedIds.add(outId);
      for (const inId of n.inputs ?? []) consumedIds.add(inId);
    }
    for (const id of producedIds) if (!consumedIds.has(id) && dataById.has(id)) outputs.push({ processId: r.id, dataName: dataById.get(id)! });
    for (const id of consumedIds) if (!producedIds.has(id) && dataById.has(id)) inputs.push({ processId: r.id, dataName: dataById.get(id)! });
  }

  const existing = new Set(
    (db.prepare(`SELECT from_process_id, to_process_id, data_label FROM process_links`).all() as any[]).map(
      (l) => `${l.from_process_id}|${l.to_process_id}|${norm(l.data_label)}`
    )
  );

  const suggestions: { from_process_id: string; to_process_id: string; data_label: string }[] = [];
  for (const out of outputs) {
    for (const inp of inputs) {
      if (out.processId === inp.processId) continue;
      if (norm(out.dataName) !== norm(inp.dataName)) continue;
      const key = `${out.processId}|${inp.processId}|${norm(out.dataName)}`;
      if (existing.has(key)) continue;
      suggestions.push({ from_process_id: out.processId, to_process_id: inp.processId, data_label: out.dataName });
    }
  }
  res.json(suggestions);
});

/**
 * ФТ-М3.2.3: разрывы — вход без производителя, выход без потребителя, по всем
 * процессам реестра, привязанным к сессии с моделью.
 */
registryRouter.get("/registry/links/gaps", (_req, res) => {
  const rows = db.prepare(`SELECT id, name, session_id FROM processes WHERE session_id IS NOT NULL`).all() as {
    id: string;
    name: string;
    session_id: string;
  }[];
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  const allOutputs = new Set<string>();
  const allInputs = new Set<string>();
  const perProcess: { processId: string; name: string; unconsumedOutputs: string[]; unproducedInputs: string[] }[] = [];

  for (const r of rows) {
    const sess = db.prepare(`SELECT model_json FROM sessions WHERE id = ?`).get(r.session_id) as { model_json: string | null } | undefined;
    if (!sess?.model_json) continue;
    const model = JSON.parse(sess.model_json);
    const dataById = new Map<string, string>((model.data ?? []).map((d: any) => [d.id, d.name]));
    const produced = new Set<string>();
    const consumed = new Set<string>();
    for (const n of model.nodes ?? []) {
      for (const outId of n.outputs ?? []) produced.add(dataById.get(outId) ?? outId);
      for (const inId of n.inputs ?? []) consumed.add(dataById.get(inId) ?? inId);
    }
    for (const v of produced) allOutputs.add(norm(v));
    for (const v of consumed) allInputs.add(norm(v));
    perProcess.push({ processId: r.id, name: r.name, unconsumedOutputs: [...produced], unproducedInputs: [...consumed] });
  }

  const gaps = perProcess.map((p) => ({
    processId: p.processId,
    name: p.name,
    unconsumedOutputs: p.unconsumedOutputs.filter((o) => !allInputs.has(norm(o))),
    unproducedInputs: p.unproducedInputs.filter((i) => !allOutputs.has(norm(i))),
  }));
  res.json(gaps.filter((g) => g.unconsumedOutputs.length || g.unproducedInputs.length));
});
