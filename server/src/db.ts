import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(__dirname, "../data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

export const db = new Database(path.join(dataDir, "app.sqlite"));
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'A',
  status TEXT NOT NULL DEFAULT 'draft',
  meta_json TEXT NOT NULL DEFAULT '{}',
  fragments_json TEXT NOT NULL DEFAULT '[]',
  raw_text TEXT NOT NULL DEFAULT '',
  model_json TEXT,
  validation_json TEXT NOT NULL DEFAULT '[]',
  bpmn_xml TEXT,
  idef0_json TEXT,
  chat_json TEXT NOT NULL DEFAULT '[]',
  versions_json TEXT NOT NULL DEFAULT '[]',
  comments_json TEXT NOT NULL DEFAULT '[]',
  qa_json TEXT NOT NULL DEFAULT '[]',
  diagrams_stale INTEGER NOT NULL DEFAULT 0,
  provider TEXT,
  regulation_snapshot_seq INTEGER,
  respondents_json TEXT NOT NULL DEFAULT '[]',
  tracks_json TEXT NOT NULL DEFAULT '[]',
  verification_confirmed_json TEXT NOT NULL DEFAULT '[]',
  review_route_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS glossary (
  key TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'confirmed'
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  details_json TEXT,
  ts TEXT NOT NULL
);

-- М3.1: реестр процессов портфеля (иерархия L0-L3, классификация, атрибуты)
CREATE TABLE IF NOT EXISTS processes (
  id TEXT PRIMARY KEY,
  code TEXT,
  name TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'L2',
  parent_process_id TEXT,
  classification TEXT NOT NULL DEFAULT 'main',
  owner TEXT,
  department TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  version TEXT NOT NULL DEFAULT '0.1',
  review_date TEXT,
  session_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- М3.2: подтверждённые связи между процессами (стыки вход/выход)
CREATE TABLE IF NOT EXISTS process_links (
  id TEXT PRIMARY KEY,
  from_process_id TEXT NOT NULL,
  to_process_id TEXT NOT NULL,
  data_label TEXT NOT NULL,
  confirmed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- М3.5: должности штатного расписания и отображение роль<->должность (многие-ко-многим)
CREATE TABLE IF NOT EXISTS positions (
  key TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  department TEXT
);

CREATE TABLE IF NOT EXISTS role_position_map (
  role_key TEXT NOT NULL,
  position_key TEXT NOT NULL,
  PRIMARY KEY (role_key, position_key)
);

-- М4.2: кампании асинхронного сбора интервью
CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  name TEXT NOT NULL,
  due_date TEXT,
  reminder_webhook_url TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS campaign_respondents (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  respondent_id TEXT NOT NULL,
  track_id TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  started_at TEXT,
  completed_at TEXT,
  last_reminded_at TEXT
);

-- М7.4: уведомления о влиянии утверждённых изменений
CREATE TABLE IF NOT EXISTS notification_webhooks (
  session_id TEXT PRIMARY KEY,
  webhook_url TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  recipient_kind TEXT NOT NULL, -- 'process_owner' | 'role'
  recipient_label TEXT NOT NULL,
  recipient_contact TEXT,
  channel TEXT NOT NULL DEFAULT 'system', -- 'system' | 'webhook'
  message TEXT NOT NULL,
  diff_link TEXT,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- М2.2: ставки ролей для расчёта трудозатрат и стоимости процесса
CREATE TABLE IF NOT EXISTS role_rates (
  role_key TEXT PRIMARY KEY,
  role_name TEXT NOT NULL,
  rate REAL NOT NULL,
  unit TEXT NOT NULL DEFAULT 'per_hour'
);

-- М6.1: реестр требований (стандарты, НПА, внутренние стандарты)
CREATE TABLE IF NOT EXISTS requirements (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  title TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'internal',
  created_at TEXT NOT NULL
);

-- М6.2: настраиваемые правила чек-листа процессного подхода
CREATE TABLE IF NOT EXISTS checklist_rules (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1
);

-- М9.1: корпус подтверждённых пар "текст интервью — утверждённая PLM" для
-- few-shot подбора примеров (9.1.2) и регрессионной оценки (9.1.4). Пополняется
-- только из утверждённых версий (repo.ts addVersion), конфиденциальные
-- процессы исключаются (9.1.5).
CREATE TABLE IF NOT EXISTS corpus_entries (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  process_name TEXT NOT NULL,
  raw_text TEXT NOT NULL,
  model_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- М9.2.3: журнал шагов мультиагентного оркестратора (извлекатель/сборщик/
-- критик/интервьюер/аналитик/документалист) — для разбора ошибок.
CREATE TABLE IF NOT EXISTS agent_run_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  run_id TEXT NOT NULL,
  iteration INTEGER NOT NULL DEFAULT 1,
  agent TEXT NOT NULL,
  summary TEXT NOT NULL,
  model TEXT,
  ts TEXT NOT NULL
);

-- М9.2.4: модель LLM, назначаемая каждому агенту отдельно.
CREATE TABLE IF NOT EXISTS agent_model_config (
  agent_key TEXT PRIMARY KEY,
  model_name TEXT NOT NULL
);

-- М3.4: отклонённые аналитиком кандидаты в дубли (чтобы не предлагать повторно)
CREATE TABLE IF NOT EXISTS duplicate_dismissals (
  from_process_id TEXT NOT NULL,
  to_process_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (from_process_id, to_process_id)
);

-- М2.4: гипотезы TO-BE, сгенерированные по результатам М2.1-2.3 (никогда не
-- применяются к модели автоматически — только по явному действию аналитика).
CREATE TABLE IF NOT EXISTS tobe_hypotheses (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  template TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  affected_element_ids_json TEXT NOT NULL,
  minutes_saved REAL,
  cost_saved REAL,
  risks TEXT NOT NULL,
  assumptions TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed',
  applied_session_id TEXT,
  created_at TEXT NOT NULL
);

-- М4.3: импортированные журналы событий (process mining) и сопоставление
-- активностей журнала с действиями PLM (подтверждается аналитиком, 4.3.2).
CREATE TABLE IF NOT EXISTS mining_logs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  filename TEXT,
  events_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mining_mappings (
  session_id TEXT NOT NULL,
  activity TEXT NOT NULL,
  node_id TEXT,
  confirmed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, activity)
);

-- М1.5.2: синхронизация карточки процесса с внешним реестром через коннектор
-- (генерический вебхук + настраиваемый маппинг полей — без привязки к
-- конкретному вендору, т.к. в этом окружении нет реальных учётных данных
-- внешней системы для интеграции).
CREATE TABLE IF NOT EXISTS card_sync_config (
  process_id TEXT PRIMARY KEY,
  webhook_url TEXT NOT NULL,
  field_mapping_json TEXT NOT NULL DEFAULT '{}',
  last_synced_at TEXT
);
`);

// Миграция для БД, созданных до появления regulation_snapshot_seq (ФТ-М1.1.4):
// на новой БД колонка уже есть из CREATE TABLE выше, ALTER тогда просто падает
// на "duplicate column" — это ожидаемо и безопасно игнорируется.
try {
  db.exec(`ALTER TABLE sessions ADD COLUMN regulation_snapshot_seq INTEGER`);
} catch {
  // колонка уже существует
}
try {
  db.exec(`ALTER TABLE sessions ADD COLUMN respondents_json TEXT NOT NULL DEFAULT '[]'`);
} catch {
  // колонка уже существует
}
try {
  db.exec(`ALTER TABLE sessions ADD COLUMN tracks_json TEXT NOT NULL DEFAULT '[]'`);
} catch {
  // колонка уже существует
}
try {
  db.exec(`ALTER TABLE sessions ADD COLUMN verification_confirmed_json TEXT NOT NULL DEFAULT '[]'`);
} catch {
  // колонка уже существует
}
try {
  db.exec(`ALTER TABLE sessions ADD COLUMN review_route_json TEXT`);
} catch {
  // колонка уже существует
}

/**
 * ФТ-М6.1.2: предзаполненный каталог требований — только коды и краткие
 * собственные формулировки ключевых пунктов ISO 9001:2015 §4.4 (СМК и её
 * процессы), НЕ дословный текст стандарта — по лицензионным ограничениям
 * (ТЗ, риски, раздел 13: "хранение только кодов и собственных формулировок").
 */
const ISO_9001_SEED: { code: string; title: string }[] = [
  { code: "ISO9001-4.4.1.a", title: "Определены входы, необходимые для процесса, и результаты, которые он должен выдавать" },
  { code: "ISO9001-4.4.1.b", title: "Определены последовательность и взаимодействие процессов" },
  { code: "ISO9001-4.4.1.c", title: "Определены критерии и методы, включая измерения, для обеспечения результативности процесса" },
  { code: "ISO9001-4.4.1.d", title: "Определены и обеспечены ресурсы, необходимые для процесса" },
  { code: "ISO9001-4.4.1.e", title: "Распределены ответственность и полномочия за процесс" },
  { code: "ISO9001-4.4.1.f", title: "Рассмотрены риски и возможности, связанные с процессом" },
  { code: "ISO9001-4.4.1.g", title: "Процесс оценивается, и в него вносятся изменения, необходимые для достижения результатов" },
  { code: "ISO9001-4.4.1.h", title: "Процесс и система менеджмента качества в целом улучшаются" },
];
const seedRequirementsCount = (db.prepare(`SELECT COUNT(*) AS c FROM requirements`).get() as { c: number }).c;
if (seedRequirementsCount === 0) {
  const insertReq = db.prepare(`INSERT INTO requirements (id, code, title, source, created_at) VALUES (?, ?, ?, 'ISO9001', ?)`);
  const now = new Date().toISOString();
  for (const r of ISO_9001_SEED) insertReq.run(`req_${r.code}`, r.code, r.title, now);
}

/** ФТ-М6.2.1: базовый чек-лист процессного подхода (по умолчанию все правила включены). */
const CHECKLIST_SEED: { code: string; label: string }[] = [
  { code: "owner_assigned", label: "Назначен владелец процесса" },
  { code: "inputs_outputs_defined", label: "Определены входы и выходы процесса" },
  { code: "kpi_with_targets", label: "Есть показатели (KPI) с целевыми значениями" },
  { code: "risks_defined", label: "Определены риски процесса" },
  { code: "records_defined", label: "Определены записи (документы) процесса" },
  { code: "control_points_exist", label: "Есть точки контроля (регламентирующие факторы)" },
  { code: "review_date_set", label: "Назначена дата планового пересмотра" },
];
const seedChecklistCount = (db.prepare(`SELECT COUNT(*) AS c FROM checklist_rules`).get() as { c: number }).c;
if (seedChecklistCount === 0) {
  const insertRule = db.prepare(`INSERT INTO checklist_rules (id, code, label, enabled) VALUES (?, ?, ?, 1)`);
  for (const r of CHECKLIST_SEED) insertRule.run(`rule_${r.code}`, r.code, r.label);
}

/** ФТ-М9.2.1/9.2.4: роли агентов мультиагентного конвейера и модель LLM по умолчанию для каждого. */
const DEFAULT_AGENT_MODEL = process.env.LLM_MODEL || "claude-sonnet-4-5";
const AGENT_SEED: string[] = ["extractor", "merger", "critic", "interviewer", "analyst", "documentalist"];
const seedAgentsCount = (db.prepare(`SELECT COUNT(*) AS c FROM agent_model_config`).get() as { c: number }).c;
if (seedAgentsCount === 0) {
  const insertAgent = db.prepare(`INSERT INTO agent_model_config (agent_key, model_name) VALUES (?, ?)`);
  for (const key of AGENT_SEED) insertAgent.run(key, DEFAULT_AGENT_MODEL);
}

export function logAudit(sessionId: string | null, actor: string, action: string, details?: unknown) {
  db.prepare(
    `INSERT INTO audit_log (session_id, actor, action, details_json, ts) VALUES (?, ?, ?, ?, ?)`
  ).run(sessionId, actor, action, details ? JSON.stringify(details) : null, new Date().toISOString());
}
