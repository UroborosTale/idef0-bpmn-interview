import { Router } from "express";
import { db, logAudit } from "../db.js";
import { validateWebhookUrl } from "../util/webhook.js";

export const cardRouter = Router();

interface ProcessRow {
  id: string;
  code: string | null;
  name: string;
  level: string;
  classification: string;
  owner: string | null;
  department: string | null;
  status: string;
  version: string;
  review_date: string | null;
  session_id: string | null;
}

/** ФТ-М1.5.1: карточка процесса — атрибуты реестра + KPI и ссылки на модели/документы связанной сессии. */
function buildCard(processRow: ProcessRow) {
  let kpi: unknown[] = [];
  let links: Record<string, string> = {};
  if (processRow.session_id) {
    const sess = db.prepare(`SELECT model_json FROM sessions WHERE id = ?`).get(processRow.session_id) as { model_json: string | null } | undefined;
    if (sess?.model_json) {
      const model = JSON.parse(sess.model_json);
      kpi = model.process?.kpi ?? [];
    }
    links = {
      bpmn: `/api/sessions/${processRow.session_id}/export/bpmn`,
      idef0_decomposition: `/api/sessions/${processRow.session_id}/export/idef0/decomposition.svg`,
      model_json: `/api/sessions/${processRow.session_id}/export/model.json`,
      regulation_docx: `/api/sessions/${processRow.session_id}/regulation/export.docx`,
      raci_xlsx: `/api/sessions/${processRow.session_id}/raci/export/xlsx`,
    };
  }
  return {
    id: processRow.id,
    code: processRow.code,
    name: processRow.name,
    level: processRow.level,
    classification: processRow.classification,
    owner: processRow.owner,
    department: processRow.department,
    status: processRow.status,
    version: processRow.version,
    review_date: processRow.review_date,
    session_id: processRow.session_id,
    kpi,
    links,
  };
}

cardRouter.get("/registry/:id/card", (req, res) => {
  const row = db.prepare(`SELECT * FROM processes WHERE id = ?`).get(req.params.id) as ProcessRow | undefined;
  if (!row) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json(buildCard(row));
});

/** ФТ-М1.5.2: конфигурация синхронизации с внешним реестром (вебхук + маппинг полей). */
cardRouter.get("/registry/:id/card/sync-config", (req, res) => {
  const row = db.prepare(`SELECT * FROM card_sync_config WHERE process_id = ?`).get(req.params.id) as
    | { process_id: string; webhook_url: string; field_mapping_json: string; last_synced_at: string | null }
    | undefined;
  if (!row) {
    res.json({ webhook_url: null, field_mapping: {}, last_synced_at: null });
    return;
  }
  res.json({ webhook_url: row.webhook_url, field_mapping: JSON.parse(row.field_mapping_json), last_synced_at: row.last_synced_at });
});

cardRouter.put("/registry/:id/card/sync-config", (req, res) => {
  const { webhook_url, field_mapping } = req.body as { webhook_url: string; field_mapping?: Record<string, string> };
  if (!webhook_url) {
    res.status(400).json({ error: "webhook_url is required" });
    return;
  }
  const check = validateWebhookUrl(webhook_url);
  if (!check.ok) {
    res.status(400).json({ error: check.error });
    return;
  }
  db.prepare(
    `INSERT INTO card_sync_config (process_id, webhook_url, field_mapping_json, last_synced_at) VALUES (?, ?, ?, NULL)
     ON CONFLICT(process_id) DO UPDATE SET webhook_url = excluded.webhook_url, field_mapping_json = excluded.field_mapping_json`
  ).run(req.params.id, webhook_url, JSON.stringify(field_mapping ?? {}));
  res.json({ webhook_url, field_mapping: field_mapping ?? {} });
});

/**
 * ФТ-М1.5.2: отправка карточки во внешний реестр. Маппинг переименовывает
 * ключи карточки перед отправкой (например {"name":"Title","owner":"Owner"}),
 * немаппированные поля передаются как есть.
 */
cardRouter.post("/registry/:id/card/sync", async (req, res) => {
  const row = db.prepare(`SELECT * FROM processes WHERE id = ?`).get(req.params.id) as ProcessRow | undefined;
  if (!row) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const cfg = db.prepare(`SELECT * FROM card_sync_config WHERE process_id = ?`).get(req.params.id) as
    | { webhook_url: string; field_mapping_json: string }
    | undefined;
  if (!cfg) {
    res.status(400).json({ error: "синхронизация не настроена — сначала укажите webhook_url" });
    return;
  }
  const card = buildCard(row);
  const mapping = JSON.parse(cfg.field_mapping_json) as Record<string, string>;
  const mapped: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(card)) mapped[mapping[k] ?? k] = v;

  try {
    const resp = await fetch(cfg.webhook_url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(mapped),
      signal: AbortSignal.timeout(10_000),
    });
    const ok = resp.ok;
    db.prepare(`UPDATE card_sync_config SET last_synced_at = ? WHERE process_id = ?`).run(new Date().toISOString(), req.params.id);
    logAudit(null, "analyst", "card_synced", { process_id: req.params.id, ok, status: resp.status });
    res.json({ ok, status: resp.status });
  } catch (e) {
    res.status(502).json({ error: `не удалось отправить карточку: ${(e as Error).message}` });
  }
});
