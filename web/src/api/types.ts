/** Типы ответов API (по разделам сервера). */
import type { SessionListItem, SessionMeta, SessionRecord, VersionListItem, InterviewTrack, SessionRespondent, ChatMessage, Discrepancy, SourceRef, Gap, RequirementLink } from "../types";

export interface CampaignRespondentStatus {
  id: string;
  campaign_id: string;
  respondent_id: string;
  track_id: string;
  token: string;
  name: string;
  role_id: string | null;
  status: "pending" | "in_progress" | "completed";
  started_at: string | null;
  completed_at: string | null;
  last_reminded_at: string | null;
  overdue: boolean;
}
export interface Campaign {
  id: string;
  session_id: string;
  name: string;
  due_date: string | null;
  reminder_webhook_url: string | null;
  created_at: string;
}
export interface CampaignStatus {
  campaign: Campaign;
  respondents: CampaignRespondentStatus[];
  coverage: { total: number; completed: number; inProgress: number; notStarted: number };
}
export interface VerificationParagraph {
  id: string;
  text: string;
  sourceRefs: string[];
}

export interface ReviewStep {
  id: string;
  role: string;
  label: string;
  assignee?: string | null;
  status: "pending" | "approved" | "rejected" | "skipped";
  comment?: string | null;
  ts?: string | null;
}
export interface ImpactReport {
  significance: "cosmetic" | "structural" | "affects_others";
  changedElementIds: string[];
  changedNodeNames: string[];
  adjacentProcesses: { processId: string; name: string; owner: string | null; reason: string }[];
  affectedDocuments: { paragraphId: string; section: string }[];
  affectedRequirements: { requirementId: string; elementId: string }[];
  affectedRoles: { roleId: string; name: string }[];
  kpiChanged: boolean;
  baselineSeq?: number;
  currentSeq?: number | null;
}
export interface ReviewRoute {
  id: string;
  steps: ReviewStep[];
  currentStepIndex: number;
  status: "review" | "needs_rework" | "approved";
  baselineSeq: number;
  impactReport: ImpactReport | null;
  startedAt: string;
  completedAt?: string | null;
}
export interface NotificationRow {
  id: string;
  session_id: string;
  recipient_kind: string;
  recipient_label: string;
  recipient_contact: string | null;
  channel: string;
  message: string;
  diff_link: string | null;
  is_read: number;
  created_at: string;
}

export interface RegistryProcess {
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

export interface ProcessLink {
  id: string;
  from_process_id: string;
  to_process_id: string;
  data_label: string;
  confirmed: number | boolean;
  created_at: string;
}

/** Общий репозиторий объектов организации: роль, информационная система, документ — один раз на все процессы. */
export type RepoClass = "role" | "system" | "data";

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

/** Объект с числом процессов, записей справочников и шагов, где он используется. */
export interface RepoListItem extends RepoObject {
  sessions: number;
  entries: number;
  uses: number;
}

export interface RepoUsage {
  sessionId: string;
  sessionTitle: string;
  approved: boolean;
  entryId: string;
  entryName: string;
  uses: number;
}

export interface GlossaryEntry {
  key: string;
  kind: string;
  value: string;
  status: "proposed" | "confirmed";
}

export interface PositionRow {
  key: string;
  title: string;
  department: string | null;
}

export interface RegulationStaleness {
  generatedAtSeq: number | null;
  currentSeq: number | null;
  staleCount: number;
  staleParagraphIds: string[];
}

export interface ProcessCard {
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
  kpi: { id: string; name: string; target?: string | null; unit?: string | null }[];
  links: Record<string, string>;
}

// --- М2.1 Аналитика узких мест ---
export interface PathInfo {
  nodeIds: string[];
  nodeNames: string[];
  totalMinutes: number | null;
}
export interface NodeHeat {
  nodeId: string;
  name: string;
  heat: number;
  minutes: number | null;
  inLoop: boolean;
}
export interface BottleneckReport {
  hasTimingData: boolean;
  mainPath: PathInfo | null;
  worstPath: PathInfo | null;
  waitingShare: number | null;
  handoffCount: number;
  approvalCount: number;
  returnLoopCount: number;
  nodeHeat: NodeHeat[];
}

// --- М2.3 Антипаттерны ---
export interface AntipatternFinding {
  id: string;
  rule: string;
  label: string;
  elementIds: string[];
  explanation: string;
  quotes: SourceRef[];
}

// --- М2.2 Трудозатраты и стоимость ---
export interface RoleRate {
  role_key: string;
  role_name: string;
  rate: number;
  unit: string;
}
export interface RoleCost {
  roleId: string;
  roleName: string;
  minutesPerInstance: number;
  costPerInstance: number | null;
  hasRate: boolean;
}
export interface CostReport {
  roles: RoleCost[];
  totalMinutesPerInstance: number;
  totalCostPerInstance: number | null;
  frequencyPerMonth: number | null;
  totalCostPerMonth: number | null;
  missingRates: string[];
}
export interface SensitivityPoint {
  label: string;
  frequencyPerMonth: number | null;
  durationFactor: number;
  totalCostPerMonth: number | null;
}

// --- М6.1 Реестр требований ---
export interface RequirementRow {
  id: string;
  code: string;
  title: string;
  source: string;
  created_at: string;
}

// --- М6.2 Чек-лист процессного подхода ---
export interface ChecklistRuleRow {
  id: string;
  code: string;
  label: string;
  enabled: number;
}
export interface ChecklistRuleResult {
  code: string;
  label: string;
  passed: boolean;
  detail: string;
}
export interface ChecklistResult {
  compliancePercent: number;
  results: ChecklistRuleResult[];
}

// --- М3.3 Карта процессов ---
export interface RegistryMapNode {
  id: string;
  code: string | null;
  name: string;
  level: string;
  parentProcessId: string | null;
  classification: string;
  status: string;
}
export interface RegistryMapEdge {
  id: string;
  from: string;
  to: string;
  label: string;
}
export interface RegistryMap {
  nodes: RegistryMapNode[];
  edges: RegistryMapEdge[];
}

// --- М3.4 Поиск дублей ---
export interface DuplicateCandidate {
  aId: string;
  aName: string;
  bId: string;
  bName: string;
  score: number;
  reason: string;
}

// --- М6.5 Проверка актуальности ---
export interface StalenessRow {
  processId: string;
  name: string;
  status: string;
  reviewDate: string | null;
  reviewOverdue: boolean;
  daysOverdue: number;
  updatedAt: string;
}

// --- М6.3 Трассировка требований ---
export interface TraceabilityRequirementRow {
  requirementId: string;
  code: string;
  title: string;
  linkedElementIds: string[];
  coverage: "full" | "partial" | "none";
}
export interface TraceabilityReport {
  requirements: TraceabilityRequirementRow[];
  coveragePercent: number;
  uncoveredRequirementIds: string[];
  unlinkedElementIds: string[];
}

// --- М6.4 Аудит-трейл ---
export interface AuditLogRow {
  id: number;
  sessionId: string | null;
  actor: string;
  action: string;
  details: unknown;
  ts: string;
}

// --- М9.2 Мультиагентная архитектура ---
export interface AgentConfigRow {
  agentKey: string;
  label: string;
  modelName: string;
}
export interface AgentRunRow {
  id: number;
  runId: string;
  iteration: number;
  agent: string;
  label: string;
  summary: string;
  model: string | null;
  ts: string;
}

// --- М9.1 Корпус ---
export interface CorpusStats {
  count: number;
  fineTuneThreshold: number;
  fineTuneReady: boolean;
  note: string;
}
export interface CorpusEntryRow {
  id: string;
  sessionId: string;
  processName: string;
  createdAt: string;
}
export interface SimilarCorpusEntry {
  id: string;
  processName: string;
  score: number;
}

// --- М9.1.4/9.3.3 Регрессионная оценка ---
export interface EvalCaseResult {
  caseId: string;
  expectedRoles: string[];
  foundRoles: string[];
  expectedNodes: string[];
  foundNodes: string[];
  roleRecall: number;
  nodeRecall: number;
  error?: string;
}
export interface EvalSummary {
  provider: string;
  cases: EvalCaseResult[];
  avgRoleRecall: number;
  avgNodeRecall: number;
}

export interface LLMStatus {
  name: string;
  live: boolean;
  localConfigured: boolean;
}

// --- М2.4 Гипотезы TO-BE ---
export interface HypothesisRow {
  id: string;
  template: string;
  templateLabel: string;
  title: string;
  description: string;
  affectedElementIds: string[];
  minutesSaved: number | null;
  costSaved: number | null;
  risks: string;
  assumptions: string;
  status: "proposed" | "applied" | "dismissed";
  appliedSessionId: string | null;
  createdAt: string;
}

// --- М2.5 Сравнение AS-IS/TO-BE ---
export interface CompareDelta {
  stepCount: { before: number; after: number };
  handoffCount: { before: number; after: number };
  cycleTimeMinutes: { before: number | null; after: number | null };
  laborCostPerInstance: { before: number | null; after: number | null };
}
export interface CompareReport {
  diff: any;
  delta: CompareDelta;
}

// --- М4.3 Process mining ---
export interface DfgEdge {
  from: string;
  to: string;
  count: number;
}
export interface MiningImportResult {
  logId: string;
  eventCount: number;
  caseCount: number;
  dfg: { activities: string[]; edges: DfgEdge[]; caseCount: number };
  suggestions: { activity: string; nodeId: string | null; nodeName: string | null; score: number }[];
}
export interface MiningMappingRow {
  activity: string;
  nodeId: string | null;
  nodeName: string | null;
  confirmed: boolean;
}
export interface ConformanceDeviation {
  fromLabel: string;
  toLabel: string;
  count?: number;
}
export interface ActivityStat {
  activity: string;
  count: number;
  avgMinutes: number | null;
  mappedNodeId: string | null;
}
export interface ConformanceReport {
  fitness: number | null;
  precision: number | null;
  deviationsInLogNotModel: ConformanceDeviation[];
  deviationsInModelNotLog: ConformanceDeviation[];
  activityStats: ActivityStat[];
}
export interface MiningReport {
  modelStepCount: number;
  logActivityCount: number;
  logCaseCount: number;
  mappedActivityCount: number;
  conformance: ConformanceReport | null;
}

// --- М4.5 Адаптивная глубина ---
export interface CriticalityScore {
  nodeId: string;
  name: string;
  score: number;
  reasons: string[];
}

// --- М6.4 Пакет к аудиту ---
export interface RequirementAuditCoverage {
  requirement: { id: string; code: string; title: string; source: string };
  coveredByProcessCount: number;
  totalProcessCount: number;
  coverage: {
    sessionId: string;
    processName: string;
    status: string;
    elements: { elementId: string; name: string; coverage: "full" | "partial" }[];
  }[];
}

// --- М1.4 Экспорт в BPMS ---
export interface CompletenessReport {
  target: "camunda" | "elma365";
  notes: string[];
  stats: { totalTasks: number; tasksWithoutAssignee: number; gatewaysWithConditionStubs: number };
}

// --- М9.4 Плагины к средам моделирования (round-trip) ---
export interface BpmnReconcileChanges {
  renamed: { nodeId: string; from: string; to: string }[];
  added: string[];
  missing: string[];
}
export interface DrawioReconcileChange {
  nodeId: string;
  from: string;
  to: string;
}

// --- М9.5 Распознавание диаграмм на входе ---
export interface DiagramImportResult {
  session: SessionRecord;
  warnings: string[];
}

/** Расход LLM по сессии (server/src/llm/usage.ts). */
export interface LlmUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  byModel: { provider: string; model: string | null; calls: number; inputTokens: number; outputTokens: number }[];
}

export interface JobProgress {
  done: number;
  total: number;
  stage?: string;
}

export interface Job {
  id: string;
  sessionId: string | null;
  kind: string;
  status: "running" | "done" | "failed";
  progress: JobProgress | null;
  error: string | null;
}

/** Предложение правок модели от агента (Cline): человек применяет его в студии или отклоняет. */
export interface Proposal {
  id: string;
  sessionId: string;
  /** Роль агента: методолог, моделист, нормоконтролёр, интервьюер, аналитик. */
  agent: string;
  title: string;
  rationale: string;
  patch: import("@shared/patch").ModelPatch;
  delta: { introduced: { severity: string; message: string }[]; resolved: { severity: string; message: string }[] };
  status: "pending" | "applied" | "rejected";
  reason: string | null;
  createdAt: string;
  /** Модель сохраняли после создания предложения — оно подготовлено к более старой версии. */
  stale: boolean;
}

/** Задание аналитика агенту: «разбей операцию на шаги». Агент берёт его через MCP и отвечает предложениями. */
export interface AgentTaskRow {
  id: string;
  sessionId: string;
  text: string;
  scopeNodeId: string | null;
  agent: string | null;
  status: "open" | "taken" | "done" | "cancelled";
  createdBy: string;
  createdAt: string;
  takenBy: string | null;
  resultNote: string | null;
  /** Предложения, отправленные агентом по этому заданию. */
  proposals: { id: string; title: string; status: "pending" | "applied" | "rejected" }[];
}

/** Вопрос к следующему интервью: его готовит агент-интервьюер, а аналитик отмечает, что задано и что отвечено. */
export interface AgentQuestionRow {
  id: string;
  sessionId: string;
  text: string;
  addressee: string | null;
  scopeNodeId: string | null;
  reason: string | null;
  priority: "critical" | "important" | "desirable";
  status: "open" | "asked" | "answered" | "dismissed";
  answer: string | null;
  fragmentId: string | null;
  agent: string;
  taskId: string | null;
  /** Задание моделисту «внести ответ», в которое вошёл вопрос. */
  handoffTaskId: string | null;
  createdAt: string;
}

export type FindingLevel = "high" | "medium" | "low";

/** Вывод отчёта агента: что, где, основание, влияние, уверенность и рекомендация. */
export interface ReportFinding {
  what: string;
  where?: string;
  basis?: string;
  impact: FindingLevel;
  confidence: FindingLevel;
  recommendation?: string;
}

/** Отчёт агента (аналитика, нормоконтролёра, методолога): модель не меняет, аналитик читает и архивирует. */
export interface AgentReportRow {
  id: string;
  sessionId: string;
  agent: string;
  kind: "analysis" | "review" | "methodology" | "other";
  title: string;
  summary: string | null;
  body: string | null;
  findings: ReportFinding[];
  scopeNodeId: string | null;
  taskId: string | null;
  status: "new" | "read" | "archived";
  /** Модель изменилась после того, как отчёт был составлен. */
  stale?: boolean;
  createdAt: string;
}

/** Сводка работы одной роли агента (предложения, задания, вопросы, отчёты) — для настройки инструкций по реальным запускам. */
export interface AgentRoleStats {
  role: string;
  proposals: {
    total: number;
    pending: number;
    applied: number;
    rejected: number;
    /** Доля применённых среди решённых; null — решений ещё нет. */
    acceptance: number | null;
    introduced: number;
    resolved: number;
    topReasons: { reason: string; count: number }[];
  };
  tasks: { taken: number; done: number; created: number };
  questions: { added: number; asked: number; answered: number; dismissed: number };
  reports: { total: number; unread: number; findings: number; highImpact: number };
}
export interface AgentStatsReport {
  scope: "session" | "all";
  roles: AgentRoleStats[];
}