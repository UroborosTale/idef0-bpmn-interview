import { Router } from "express";
import { db, logAudit } from "../db.js";

export const glossaryRouter = Router();

/**
 * Единые справочники организации (ФТ-М3.5): роли, подразделения, ИС, документы,
 * термины хранятся в одной таблице glossary с дискриминатором kind — так же,
 * как это уже было в Ядре для терминов (нормализация интервью, ФТ-11.2).
 * Должности штатного расписания и связка роль<->должность (many-to-many)
 * вынесены в отдельные таблицы positions / role_position_map, т.к. это
 * отношение, а не плоский словарь.
 */
glossaryRouter.get("/glossary", (req, res) => {
  const { kind, status } = req.query as { kind?: string; status?: string };
  const clauses: string[] = [];
  const params: any[] = [];
  if (kind) {
    clauses.push("kind = ?");
    params.push(kind);
  }
  if (status) {
    clauses.push("status = ?");
    params.push(status);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db.prepare(`SELECT key, kind, value, status FROM glossary ${where} ORDER BY kind, key`).all(...params);
  res.json(rows);
});

glossaryRouter.put("/glossary/:key", (req, res) => {
  const { kind, value, status } = req.body as { kind: string; value: string; status?: string };
  if (!value) {
    res.status(400).json({ error: "value is required" });
    return;
  }
  db.prepare(
    `INSERT INTO glossary (key, kind, value, status) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET kind = excluded.kind, value = excluded.value, status = excluded.status`
  ).run(req.params.key, kind || "term", value, status || "confirmed");
  logAudit(null, "admin", "glossary_upsert", { key: req.params.key });
  res.json({ key: req.params.key, kind: kind || "term", value, status: status || "confirmed" });
});

glossaryRouter.delete("/glossary/:key", (req, res) => {
  db.prepare(`DELETE FROM glossary WHERE key = ?`).run(req.params.key);
  res.status(204).end();
});

/** ФТ-М3.5.2: список предложенных (непроверенных) сущностей, ожидающих подтверждения. */
glossaryRouter.get("/glossary/proposals", (_req, res) => {
  const rows = db.prepare(`SELECT key, kind, value, status FROM glossary WHERE status = 'proposed' ORDER BY kind, key`).all();
  res.json(rows);
});

glossaryRouter.post("/glossary/proposals/:key/confirm", (req, res) => {
  db.prepare(`UPDATE glossary SET status = 'confirmed' WHERE key = ?`).run(req.params.key);
  logAudit(null, "admin", "glossary_proposal_confirmed", { key: req.params.key });
  res.status(204).end();
});

glossaryRouter.post("/glossary/proposals/:key/reject", (req, res) => {
  db.prepare(`DELETE FROM glossary WHERE key = ? AND status = 'proposed'`).run(req.params.key);
  logAudit(null, "admin", "glossary_proposal_rejected", { key: req.params.key });
  res.status(204).end();
});

/**
 * Пополнение словаря из подтверждённых элементов модели одной сессии
 * (ФТ-М3.5.2): новые роли/системы ПРЕДЛАГАЮТСЯ (status='proposed'), а не
 * добавляются в словарь молча — подтверждает их менеджер справочников.
 */
glossaryRouter.post("/glossary/import-from-session/:sessionId", (req, res) => {
  const row = db.prepare(`SELECT model_json FROM sessions WHERE id = ?`).get(req.params.sessionId) as { model_json: string | null } | undefined;
  if (!row?.model_json) {
    res.status(404).json({ error: "модель не найдена" });
    return;
  }
  const model = JSON.parse(row.model_json);
  const insert = db.prepare(`INSERT INTO glossary (key, kind, value, status) VALUES (?, ?, ?, 'proposed') ON CONFLICT(key) DO NOTHING`);
  let count = 0;
  for (const r of model.roles ?? []) {
    if (insert.run(r.name.toLowerCase(), "role", r.name).changes) count++;
  }
  for (const s of model.systems ?? []) {
    if (insert.run(s.name.toLowerCase(), "system", s.name).changes) count++;
  }
  for (const d of model.data ?? []) {
    if (insert.run(d.name.toLowerCase(), "document", d.name).changes) count++;
  }
  res.json({ proposed: count });
});

// --- ФТ-М3.5.3/3.5.4: должности штатного расписания, отображение роль<->должность ---

interface PositionRow {
  key: string;
  title: string;
  department: string | null;
}

glossaryRouter.get("/positions", (_req, res) => {
  res.json(db.prepare(`SELECT * FROM positions ORDER BY department, title`).all());
});

glossaryRouter.put("/positions/:key", (req, res) => {
  const { title, department } = req.body as { title: string; department?: string };
  if (!title) {
    res.status(400).json({ error: "title is required" });
    return;
  }
  db.prepare(
    `INSERT INTO positions (key, title, department) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET title = excluded.title, department = excluded.department`
  ).run(req.params.key, title, department ?? null);
  res.json({ key: req.params.key, title, department: department ?? null } satisfies PositionRow);
});

glossaryRouter.delete("/positions/:key", (req, res) => {
  db.prepare(`DELETE FROM positions WHERE key = ?`).run(req.params.key);
  db.prepare(`DELETE FROM role_position_map WHERE position_key = ?`).run(req.params.key);
  res.status(204).end();
});

/** ФТ-М3.5.4: связка роль (из PLM) <-> должность, многие-ко-многим. */
glossaryRouter.get("/role-position-map", (_req, res) => {
  res.json(db.prepare(`SELECT role_key, position_key FROM role_position_map`).all());
});

glossaryRouter.post("/role-position-map", (req, res) => {
  const { role_key, position_key } = req.body as { role_key: string; position_key: string };
  if (!role_key || !position_key) {
    res.status(400).json({ error: "role_key and position_key are required" });
    return;
  }
  db.prepare(`INSERT INTO role_position_map (role_key, position_key) VALUES (?, ?) ON CONFLICT DO NOTHING`).run(role_key, position_key);
  res.status(201).json({ role_key, position_key });
});

glossaryRouter.delete("/role-position-map", (req, res) => {
  const { role_key, position_key } = req.body as { role_key: string; position_key: string };
  db.prepare(`DELETE FROM role_position_map WHERE role_key = ? AND position_key = ?`).run(role_key, position_key);
  res.status(204).end();
});

/**
 * ФТ-М3.5.3: загрузка оргструктуры и штатного расписания. Только CSV —
 * .xlsx-парсинг сознательно не подключён: единственная npm-библиотека xlsx
 * имеет непропатченные уязвимости именно в пути разбора файлов (prototype
 * pollution / ReDoS), а этот эндпоинт как раз принимает файл от пользователя.
 * xlsx в проекте используется только для ЗАПИСИ экспортов (registry.ts),
 * не для чтения чужих файлов.
 * Ожидаемые колонки CSV (заголовок обязателен): position,department,role
 * (role — необязательная, для сразу же создаваемой связки роль<->должность).
 */
glossaryRouter.post("/glossary/import-orgstructure", (req, res) => {
  const { csv } = req.body as { csv: string };
  if (!csv || !csv.trim()) {
    res.status(400).json({ error: "csv is required" });
    return;
  }
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) {
    res.status(400).json({ error: "файл пуст или не содержит строк данных" });
    return;
  }
  const parseCsvLine = (line: string): string[] => {
    const out: string[] = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"' && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else if (ch === '"') {
          inQuotes = false;
        } else {
          cur += ch;
        }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === "," || ch === ";") {
        out.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }
    out.push(cur);
    return out.map((s) => s.trim());
  };

  const header = parseCsvLine(lines[0]).map((h) => h.toLowerCase());
  const posIdx = header.indexOf("position");
  const depIdx = header.indexOf("department");
  const roleIdx = header.indexOf("role");
  if (posIdx < 0) {
    res.status(400).json({ error: "в заголовке CSV должна быть колонка 'position'" });
    return;
  }

  const insertPos = db.prepare(
    `INSERT INTO positions (key, title, department) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET title = excluded.title, department = excluded.department`
  );
  const insertDept = db.prepare(`INSERT INTO glossary (key, kind, value, status) VALUES (?, 'department', ?, 'confirmed') ON CONFLICT(key) DO NOTHING`);
  const insertRoleProposal = db.prepare(`INSERT INTO glossary (key, kind, value, status) VALUES (?, 'role', ?, 'proposed') ON CONFLICT(key) DO NOTHING`);
  const insertMap = db.prepare(`INSERT INTO role_position_map (role_key, position_key) VALUES (?, ?) ON CONFLICT DO NOTHING`);

  let positions = 0;
  let departments = 0;
  let mappings = 0;
  const tx = db.transaction(() => {
    for (let i = 1; i < lines.length; i++) {
      const cells = parseCsvLine(lines[i]);
      const title = cells[posIdx]?.trim();
      if (!title) continue;
      const department = depIdx >= 0 ? cells[depIdx]?.trim() || null : null;
      const posKey = title.toLowerCase();
      insertPos.run(posKey, title, department);
      positions++;
      if (department) {
        if (insertDept.run(department.toLowerCase(), department).changes) departments++;
      }
      if (roleIdx >= 0) {
        const role = cells[roleIdx]?.trim();
        if (role) {
          const roleKey = role.toLowerCase();
          insertRoleProposal.run(roleKey, role);
          insertMap.run(roleKey, posKey);
          mappings++;
        }
      }
    }
  });
  tx();
  logAudit(null, "admin", "orgstructure_imported", { positions, departments, mappings });
  res.json({ positions, departments, mappings });
});
