import { nanoid } from "nanoid";
import { db, logAudit } from "./db.js";
import type { ProcessLogicModel, Fragment, ValidationIssue, ChatMessage } from "./types/model.js";
import type { Idef0Result } from "./pipeline/idef0.js";
import type { ImpactReport } from "./pipeline/impactAnalysis.js";

export interface SessionMeta {
  processName: string;
  department?: string;
  owner?: string;
  modelType: "AS-IS" | "TO-BE";
  decompositionDepth: number;
  notations: ("IDEF0" | "BPMN")[];
  confidential?: boolean; // ФТ-М9.3.2: обрабатывается только локальным провайдером; ФТ-М9.1.5: исключается из корпуса
}

export interface VersionSnapshot {
  seq: number; // порядковый номер снимка, монотонно растёт, никогда не переиспользуется (М7.1)
  version: string; // семантическая версия "MAJOR.MINOR", напр. "0.3", "1.0"
  major: boolean; // true — снимок создан при утверждении (ФТ-М7.1.1)
  ts: string;
  note: string;
  author: string;
  model: ProcessLogicModel;
}

export interface Comment {
  id: string;
  element_id: string | null;
  paragraph_id?: string | null; // ФТ-М7.2.3: замечание может относиться к абзацу документа (регламент/верификация), а не к элементу модели
  text: string;
  author: string;
  ts: string;
}

/** ФТ-М7.2: один шаг настраиваемого маршрута согласования. */
export interface ReviewStep {
  id: string;
  role: string; // произвольный код роли шага, напр. "analyst" | "owner" | "normcontrol"
  label: string; // отображаемое название, напр. "Нормоконтролёр"
  assignee?: string | null;
  status: "pending" | "approved" | "rejected" | "skipped";
  comment?: string | null;
  ts?: string | null;
}

/** ФТ-М7.2.1/7.2.2: маршрут согласования и его статус. */
export interface ReviewRoute {
  id: string;
  steps: ReviewStep[];
  currentStepIndex: number;
  status: "review" | "needs_rework" | "approved";
  baselineSeq: number; // версия модели на начало цикла согласования — для diff/анализа влияния (ФТ-М7.3)
  impactReport: ImpactReport | null; // снимок анализа влияния на момент старта согласования
  startedAt: string;
  completedAt?: string | null;
}

/** ФТ-М4.1: участник мультиинтервью в рамках одной сессии моделирования. */
export interface SessionRespondent {
  id: string;
  name: string;
  roleId: string | null; // подсказка роли для контекста извлечения и веса (ФТ-М4.1.5)
  weight: number;
}

/** ФТ-М4.1/М4.2: одна "дорожка" интервью — вклад одного респондента (текст или чат), извлекается независимо и затем сводится в общую модель. */
export interface InterviewTrack {
  id: string;
  respondentId: string;
  mode: "text" | "chat";
  fragments: Fragment[];
  rawText: string;
  chat: ChatMessage[];
  status: "pending" | "in_progress" | "completed";
}

export interface SessionRecord {
  id: string;
  title: string;
  mode: "A" | "B";
  status: "draft" | "processing" | "ready" | "interviewing" | "completed";
  meta: SessionMeta;
  fragments: Fragment[];
  rawText: string;
  model: ProcessLogicModel | null;
  validation: ValidationIssue[];
  bpmnXml: string | null;
  idef0: Idef0Result | null;
  chat: ChatMessage[];
  versions: VersionSnapshot[];
  comments: Comment[];
  qa: { gapId: string; question: string; answerText: string; ts: string }[];
  diagramsStale: boolean;
  provider: string | null;
  regulationSnapshotSeq: number | null; // ФТ-М1.1.4: версия, на которую сгенерирован регламент — для отметки устаревших абзацев
  respondents: SessionRespondent[];
  tracks: InterviewTrack[];
  verificationConfirmed: string[]; // ФТ-М4.4.2: id подтверждённых абзацев пересказа
  reviewRoute: ReviewRoute | null; // ФТ-М7.2: текущий маршрут согласования (null — вне цикла согласования)
  createdAt: string;
  updatedAt: string;
}

function rowToRecord(row: any): SessionRecord {
  return {
    id: row.id,
    title: row.title,
    mode: row.mode,
    status: row.status,
    meta: JSON.parse(row.meta_json),
    fragments: JSON.parse(row.fragments_json),
    rawText: row.raw_text,
    model: row.model_json ? JSON.parse(row.model_json) : null,
    validation: JSON.parse(row.validation_json),
    bpmnXml: row.bpmn_xml,
    idef0: row.idef0_json ? JSON.parse(row.idef0_json) : null,
    chat: JSON.parse(row.chat_json),
    versions: JSON.parse(row.versions_json),
    comments: JSON.parse(row.comments_json),
    qa: JSON.parse(row.qa_json),
    diagramsStale: !!row.diagrams_stale,
    provider: row.provider,
    regulationSnapshotSeq: row.regulation_snapshot_seq ?? null,
    respondents: JSON.parse(row.respondents_json ?? "[]"),
    tracks: JSON.parse(row.tracks_json ?? "[]"),
    verificationConfirmed: JSON.parse(row.verification_confirmed_json ?? "[]"),
    reviewRoute: row.review_route_json ? JSON.parse(row.review_route_json) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createSession(input: { title: string; mode: "A" | "B"; meta: SessionMeta }): SessionRecord {
  const id = `sess_${nanoid(10)}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO sessions (id, title, mode, status, meta_json, fragments_json, raw_text, validation_json, chat_json, versions_json, comments_json, qa_json, diagrams_stale, created_at, updated_at)
     VALUES (?, ?, ?, 'draft', ?, '[]', '', '[]', '[]', '[]', '[]', '[]', 0, ?, ?)`
  ).run(id, input.title, input.mode, JSON.stringify(input.meta), now, now);
  logAudit(id, "system", "session_created", { title: input.title, mode: input.mode });
  return getSession(id)!;
}

export function getSession(id: string): SessionRecord | null {
  const row = db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id);
  return row ? rowToRecord(row) : null;
}

export function listSessions(): SessionRecord[] {
  const rows = db.prepare(`SELECT * FROM sessions ORDER BY updated_at DESC`).all();
  return rows.map(rowToRecord);
}

export function deleteSession(id: string): void {
  db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
  logAudit(id, "system", "session_deleted");
}

export interface SessionUpdate {
  title?: string;
  status?: SessionRecord["status"];
  meta?: SessionMeta;
  fragments?: Fragment[];
  rawText?: string;
  model?: ProcessLogicModel | null;
  validation?: ValidationIssue[];
  bpmnXml?: string | null;
  idef0?: Idef0Result | null;
  chat?: ChatMessage[];
  comments?: Comment[];
  qa?: SessionRecord["qa"];
  diagramsStale?: boolean;
  provider?: string | null;
  regulationSnapshotSeq?: number | null;
  respondents?: SessionRespondent[];
  tracks?: InterviewTrack[];
  verificationConfirmed?: string[];
  reviewRoute?: ReviewRoute | null;
}

export function updateSession(id: string, patch: SessionUpdate): SessionRecord {
  const current = getSession(id);
  if (!current) throw new Error("Session not found");
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE sessions SET
      title = ?, status = ?, meta_json = ?, fragments_json = ?, raw_text = ?, model_json = ?,
      validation_json = ?, bpmn_xml = ?, idef0_json = ?, chat_json = ?, comments_json = ?, qa_json = ?,
      diagrams_stale = ?, provider = ?, regulation_snapshot_seq = ?, respondents_json = ?, tracks_json = ?, verification_confirmed_json = ?, review_route_json = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    patch.title ?? current.title,
    patch.status ?? current.status,
    JSON.stringify(patch.meta ?? current.meta),
    JSON.stringify(patch.fragments ?? current.fragments),
    patch.rawText ?? current.rawText,
    patch.model !== undefined ? (patch.model ? JSON.stringify(patch.model) : null) : current.model ? JSON.stringify(current.model) : null,
    JSON.stringify(patch.validation ?? current.validation),
    patch.bpmnXml !== undefined ? patch.bpmnXml : current.bpmnXml,
    patch.idef0 !== undefined ? (patch.idef0 ? JSON.stringify(patch.idef0) : null) : current.idef0 ? JSON.stringify(current.idef0) : null,
    JSON.stringify(patch.chat ?? current.chat),
    JSON.stringify(patch.comments ?? current.comments),
    JSON.stringify(patch.qa ?? current.qa),
    patch.diagramsStale !== undefined ? (patch.diagramsStale ? 1 : 0) : current.diagramsStale ? 1 : 0,
    patch.provider !== undefined ? patch.provider : current.provider,
    patch.regulationSnapshotSeq !== undefined ? patch.regulationSnapshotSeq : current.regulationSnapshotSeq,
    JSON.stringify(patch.respondents ?? current.respondents),
    JSON.stringify(patch.tracks ?? current.tracks),
    JSON.stringify(patch.verificationConfirmed ?? current.verificationConfirmed),
    patch.reviewRoute !== undefined ? (patch.reviewRoute ? JSON.stringify(patch.reviewRoute) : null) : current.reviewRoute ? JSON.stringify(current.reviewRoute) : null,
    now,
    id
  );
  return getSession(id)!;
}

/**
 * ФТ-М7.2.4: утверждённая версия блокируется от изменений модели — правки
 * возможны только после явного возврата в черновик (POST /sessions/:id/reopen).
 * Возвращает причину отказа или null, если редактирование разрешено.
 */
export function editBlockReason(session: SessionRecord): string | null {
  if (session.model?.process.status === "approved") {
    return "Версия утверждена и заблокирована от изменений. Откройте новый цикл правок (reopen), чтобы продолжить редактирование.";
  }
  return null;
}

/**
 * Создаёт снимок версии модели (ФТ-М7.1.1): каждое сохранение — новая версия.
 * Мажорная версия присваивается при утверждении (opts.major), минорная —
 * во всех остальных случаях (автосохранение, ручная правка, откат).
 * История версий не переписывается: rollback добавляет новый снимок поверх
 * старых (ФТ-М7.1.3), а не удаляет их.
 * Версия и статус синхронизируются в модель сессии (process.version/status),
 * чтобы GET /sessions/:id всегда показывал актуальную версию.
 */
export function addVersion(id: string, note: string, opts?: { major?: boolean; author?: string; modelOverride?: ProcessLogicModel }): SessionRecord {
  const current = getSession(id);
  const model = opts?.modelOverride ?? current?.model;
  if (!current || !model) throw new Error("No model to snapshot");
  const versions = [...current.versions];
  const last = versions[versions.length - 1];
  let major = 0;
  let minor = 0;
  if (last) {
    const [ma, mi] = last.version.split(".");
    major = Number(ma) || 0;
    minor = Number(mi) || 0;
  }
  if (opts?.major) {
    major += 1;
    minor = 0;
  } else {
    minor += 1;
  }
  const version = `${major}.${minor}`;
  const seq = (last?.seq ?? 0) + 1;
  const stampedModel: ProcessLogicModel = {
    ...model,
    process: { ...model.process, version, status: opts?.major ? "approved" : model.process.status },
  };
  versions.push({ seq, version, major: !!opts?.major, ts: new Date().toISOString(), note, author: opts?.author ?? "аналитик", model: stampedModel });
  db.prepare(`UPDATE sessions SET versions_json = ?, model_json = ? WHERE id = ?`).run(
    JSON.stringify(versions.slice(-50)),
    JSON.stringify(stampedModel),
    id
  );
  logAudit(id, opts?.author ?? "system", opts?.major ? "version_approved" : "version_snapshot", { version, note });

  // ФТ-М9.1.1/9.1.5: утверждённая пара "текст — модель" пополняет корпус для
  // few-shot подбора и регрессионной оценки; конфиденциальные процессы исключаются.
  if (opts?.major && !current.meta.confidential) {
    db.prepare(`INSERT INTO corpus_entries (id, session_id, process_name, raw_text, model_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
      `corpus_${nanoid(10)}`,
      id,
      current.meta.processName,
      current.rawText,
      JSON.stringify(stampedModel),
      new Date().toISOString()
    );
  }

  return getSession(id)!;
}

/** Откат к исторической версии (ФТ-М7.1.3): создаёт НОВЫЙ снимок поверх истории, не переписывая её. */
export function rollbackToVersion(id: string, seq: number, author?: string): SessionRecord {
  const current = getSession(id);
  if (!current) throw new Error("Session not found");
  const target = current.versions.find((v) => v.seq === seq);
  if (!target) throw new Error("Version not found");
  return addVersion(id, `Откат к версии ${target.version}`, { author, modelOverride: target.model });
}
