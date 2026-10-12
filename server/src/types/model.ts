import { z } from "zod";
import { MAX_DIAGRAM_W, MAX_LANE_H, MIN_DIAGRAM_W, MIN_LANE_H } from "../shared/bpmnGeometry.js";
import { TRIGGER_TYPES } from "../shared/events.js";

/**
 * Process Logic JSON — единый источник истины для IDEF0 и BPMN (ТЗ, раздел 5).
 * Схема версионируется (SCHEMA_VERSION) и публикуется как контракт.
 *
 * v2 (ТЗ на развитие, раздел 2): добавлены поля реестра процессов, KPI, RACI,
 * интерфейсов между процессами, трассировки требований, респондентов и
 * расхождений мультиинтервью. Поля v1 не удаляются и не меняют смысла —
 * модели v1 читаются схемой v2 без потерь (все новые поля имеют default()).
 */
export const SCHEMA_VERSION = "2.0.0";

export const SourceRef = z.object({
  fragment_id: z.string(),
  quote: z.string(),
});
export type SourceRef = z.infer<typeof SourceRef>;

// Карточка записи справочника (как в Business Studio): описание и ответственный необязательны у любой записи.
const Card = {
  description: z.string().nullable().optional(),
  owner: z.string().nullable().optional(), // у исполнителя — подразделение, у остальных — ответственный
};

// Ссылка на общий объект репозитория организации (server/src/objectRepo.ts): у ролей, систем и документов.
// Запись с одним repo_id в разных процессах — один и тот же объект.
const RepoLink = { repo_id: z.string().nullable().optional() };

export const Role = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(["internal", "external"]).default("internal"),
  source: z.array(SourceRef).default([]),
  ...Card,
  ...RepoLink,
  // Должность: требуемая квалификация и специализация (таблица ролей в регламентах и инструкциях)
  qualification: z.string().nullable().optional(),
  // Высота дорожки роли на диаграммах BPMN (px); без неё — стандартная (shared/bpmnGeometry.ts). Одна на все диаграммы, где есть эта роль.
  lane_height: z.number().min(MIN_LANE_H).max(MAX_LANE_H).nullable().optional(),
});
export type Role = z.infer<typeof Role>;

export const SystemEntity = z.object({
  id: z.string(),
  name: z.string(),
  source: z.array(SourceRef).default([]),
  ...Card,
  ...RepoLink,
});
export type SystemEntity = z.infer<typeof SystemEntity>;

export const DataEntity = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(["document", "data"]).default("document"),
  source: z.array(SourceRef).default([]),
  ...Card,
  ...RepoLink,
  // Карточка продукта (входы и выходы по Соглашению о моделировании). Источник и назначение внутри модели
  // выводятся из связей функций; supplier/consumer — только для внешних («Протокол совещания», «Конечный продукт»).
  supplier: z.string().nullable().optional(),
  consumer: z.string().nullable().optional(),
  value: z.string().nullable().optional(), // ценность для потребителя
  quality_standard: z.string().nullable().optional(), // стандарт качества
});
export type DataEntity = z.infer<typeof DataEntity>;

export const ControlEntity = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(["regulation", "rule", "norm"]).default("rule"),
  source: z.array(SourceRef).default([]),
  ...Card,
  reference: z.string().nullable().optional(), // реквизиты документа: номер, дата, пункт
});
export type ControlEntity = z.infer<typeof ControlEntity>;

export const NodeType = z.enum(["task", "event", "gateway", "subprocess"]);
export type NodeType = z.infer<typeof NodeType>;

// task subtypes
export const TaskSubtype = z.enum(["user", "service", "manual", "send", "receive", "script", "business_rule"]);
// event subtypes
export const EventSubtype = z.enum([
  "start",
  "end",
  "intermediate",
  "timer",
  "message",
  "error",
  "signal",
]);
// gateway subtypes
export const GatewaySubtype = z.enum(["exclusive", "parallel", "inclusive", "event_based"]);

// Триггер события: что его запускает или выбрасывает и параметры (подробнее — shared/events.ts).
export const EventTriggerSchema = z.object({
  type: z.enum(TRIGGER_TYPES),
  direction: z.enum(["catch", "throw"]).optional(),
  name: z.string().nullable().optional(),
  timer: z.object({ kind: z.enum(["date", "duration", "cycle"]), value: z.string() }).nullable().optional(),
  condition: z.string().nullable().optional(),
  members: z.array(z.enum(TRIGGER_TYPES)).optional(),
});

// Ручной маршрут стрелки IDEF0 (хранится у функции, к которой привязана стрелка, по ключу «вид:сущность»; shared/idef0Layout.ts).
// Чего нет — выбирает автоматическая прокладка. Координаты — в мире диаграммы.
const Pt2 = z.tuple([z.number(), z.number()]);
export const ArrowRoute = z.object({
  // положение конца у блока этой функции вдоль стороны: 0…1 слева направо (верх, низ) или сверху вниз (лево, право)
  pos: z.number().min(0).max(1).optional(),
  // у связи между функциями — положение конца у блока-источника (на его правой стороне)
  from_pos: z.number().min(0).max(1).optional(),
  // внутренние точки излома от начала стрелки к концу: линия идёт через них, недостающие колена достраиваются
  points: z.array(Pt2).max(32).optional(),
  // свободный конец внешней стрелки (начало у входа, управления и механизма, конец у выхода)
  end: Pt2.optional(),
  // сдвиг подписи от обычного места
  label: Pt2.optional(),
});
export type ArrowRoute = z.infer<typeof ArrowRoute>;

export const ProcessNode = z.object({
  id: z.string(),
  type: NodeType,
  subtype: z.string().optional(),
  // Событие: триггер (сообщение, таймер, условие, сигнал, ошибка…). Вид события (начало, промежуточное, конец) — subtype.
  trigger: EventTriggerSchema.nullable().optional(),
  name: z.string(),
  role_id: z.string().nullable().optional(),
  system_ids: z.array(z.string()).default([]),
  inputs: z.array(z.string()).default([]), // data entity ids
  outputs: z.array(z.string()).default([]), // data entity ids
  controls: z.array(z.string()).default([]), // control entity ids
  // Данные, выступающие управлением (IDEF0: выход одной функции — управление другой). Ссылки на data[];
  // отсутствие поля = пусто (необязательное, чтобы не менять код, создающий узлы).
  control_data_ids: z.array(z.string()).optional(),
  duration: z.string().nullable().optional(),
  frequency: z.string().nullable().optional(),
  idef0_parent: z.string().nullable().optional(),
  // Шаг диаграммы BPMN операции: id функции IDEF0 (операции), чью диаграмму он образует. Такой узел — не функция
  // IDEF0, а подоперация; без поля узел относится к общей схеме процесса (прежнее поведение).
  bpmn_scope: z.string().nullable().optional(),
  // Граничное событие: id задачи или подпроцесса, к границе которых оно прикреплено (таймер «через 3 дня», ошибка…).
  // Положение такого события на диаграмме не хранится — оно выводится из положения задачи.
  attached_to: z.string().nullable().optional(),
  // Граничное событие прерывает задачу (по умолчанию) или нет (пунктирная рамка).
  interrupting: z.boolean().optional(),
  // Позиция на холсте редактора BPMN (левый верхний угол). Если задана, генератор BPMN
  // использует её вместо авто-раскладки, чтобы экспорт совпадал с нарисованным.
  layout: z.object({ x: z.number(), y: z.number() }).nullable().optional(),
  // Позиция блока на диаграмме IDEF0 A0 (редактор IDEF0); без неё блоки идут по диагонали.
  idef0_layout: z.object({ x: z.number(), y: z.number() }).nullable().optional(),
  // Ручные маршруты стрелок IDEF0, привязанных к этой функции: ключ «вид:сущность» (input:d1, link:d2, control:c1, system:s1…).
  arrow_routes: z.record(z.string(), ArrowRoute).optional(),
  // Ручное смещение значков документов и хранилищ BPMN от автоматического места у задачи: ключ «вид:сущность» (input:d1, output:d2, store:s1).
  artifact_offsets: z.record(z.string(), z.object({ dx: z.number().min(-5000).max(5000), dy: z.number().min(-5000).max(5000) })).optional(),
  status: z.enum(["confirmed", "hypothesis"]).default("hypothesis"),
  confidence: z.number().min(0).max(1).default(0.5),
  source: z.array(SourceRef).default([]),
  note: z.string().optional(),
  // --- PLM v2 (М2 аналитика, М6 трассировка требований) ---
  time_processing: z.string().nullable().optional(), // время обработки (в отличие от ожидания)
  time_waiting: z.string().nullable().optional(),
  cost_estimate: z.string().nullable().optional(),
  requirement_ids: z.array(z.string()).default([]), // ссылки на requirements_links / реестр требований (М6)
  tags: z.array(z.string()).default([]), // например: manual_transfer, double_entry — маркеры для антипаттернов М2.3
  confirmed_by: z.array(z.string()).default([]), // id респондентов, подтвердивших элемент (ФТ-М4.1.2)
});
export type ProcessNode = z.infer<typeof ProcessNode>;

// Внешний пул: другой процесс (по коду из реестра) или внешний участник; на диаграмме — свёрнутый пул без дорожек.
export const ExternalPool = z.object({
  id: z.string(),
  name: z.string(),
  code: z.string().nullable().optional(),
});
export type ExternalPool = z.infer<typeof ExternalPool>;

// Поток сообщений между шагом диаграммы и внешним пулом: from/to — id узла и id пула (в любом порядке).
export const MessageFlow = z.object({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  name: z.string().nullable().optional(),
});
export type MessageFlow = z.infer<typeof MessageFlow>;

// Ручной маршрут стрелки: стороны выхода и входа, положение конца на стороне, положение среднего участка (x или y в координатах
// диаграммы) и свободные точки излома. Всё необязательно; чего нет — выбирает автоматическая прокладка (shared/bpmnRouting.ts).
export const FlowRoute = z.object({
  from_side: z.enum(["L", "R", "T", "B"]).optional(),
  to_side: z.enum(["L", "R", "T", "B"]).optional(),
  channel: z.number().optional(),
  // Положение конца вдоль стороны фигуры: 0…1 слева направо (верх, низ) или сверху вниз (лево, право); без него концы разводятся сами.
  from_pos: z.number().min(0).max(1).optional(),
  to_pos: z.number().min(0).max(1).optional(),
  // Внутренние точки излома (координаты диаграммы) от выхода ко входу: линия идёт строго через них, недостающие колена достраиваются.
  points: z.array(z.tuple([z.number(), z.number()])).max(64).optional(),
});

export const ProcessFlow = z.object({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  condition: z.string().nullable().optional(),
  route: FlowRoute.nullable().optional(),
  source: z.array(SourceRef).default([]),
  confirmed_by: z.array(z.string()).default([]), // ФТ-М4.1.2
});
export type ProcessFlow = z.infer<typeof ProcessFlow>;

export const GapPriority = z.enum(["critical", "important", "desirable"]);
export const GapStatus = z.enum(["open", "answered", "dismissed"]);

export const Gap = z.object({
  id: z.string(),
  rule: z.string(),
  priority: GapPriority,
  element_id: z.string().nullable(),
  question: z.string(),
  status: GapStatus.default("open"),
  topic: z.string().optional(), // for interview "no more than N questions per topic"
  asked_count: z.number().default(0),
});
export type Gap = z.infer<typeof Gap>;

export const Statement = z.object({
  id: z.string(),
  kind: z.enum(["problem", "proposal"]),
  text: z.string(),
  source: z.array(SourceRef).default([]),
});
export type Statement = z.infer<typeof Statement>;

export const Kpi = z.object({
  id: z.string(),
  name: z.string(),
  target: z.string().nullable().optional(),
  unit: z.string().nullable().optional(),
  source: z.array(SourceRef).default([]),
  ...Card,
  period: z.string().nullable().optional(), // периодичность измерения
});
export type Kpi = z.infer<typeof Kpi>;

// --- PLM v2: риски процесса (для чек-листа процессного подхода, ФТ-М6.2.1) ---
export const Risk = z.object({
  id: z.string(),
  name: z.string(),
  mitigation: z.string().nullable().optional(),
  source: z.array(SourceRef).default([]),
  ...Card,
  level: z.enum(["low", "medium", "high"]).nullable().optional(), // уровень риска
});
export type Risk = z.infer<typeof Risk>;

export const ProcessMeta = z.object({
  id: z.string(),
  name: z.string(),
  owner: z.string().optional(),
  department: z.string().optional(),
  group: z.string().nullable().optional(), // группа процессов (папка в навигаторе: укрупнённый процесс, к которому относится этот)
  author: z.string().optional(), // автор процесса (реестр процессов, карточка документа)
  type: z.enum(["AS-IS", "TO-BE"]).default("AS-IS"),
  goal: z.string().optional(),
  trigger: z.string().optional(),
  result: z.string().optional(),
  decomposition_depth: z.number().default(2),
  // Высота дорожки «Без исполнителя» на диаграммах BPMN (у неё нет роли, поэтому настройка здесь); без неё — стандартная.
  unassigned_lane_height: z.number().min(MIN_LANE_H).max(MAX_LANE_H).nullable().optional(),
  notations: z.array(z.enum(["IDEF0", "BPMN"])).default(["IDEF0", "BPMN"]),
  // --- PLM v2 (портфель процессов М3, жизненный цикл М7) ---
  code: z.string().nullable().optional(), // код процесса в реестре (М3.1)
  level: z.enum(["L0", "L1", "L2", "L3"]).nullable().optional(),
  parent_process_id: z.string().nullable().optional(),
  version: z.string().default("0.1"), // семантическая версия документа модели (М7.1)
  status: z.enum(["draft", "review", "needs_rework", "approved", "archived"]).default("draft"), // ФТ-М7.2.2
  review_date: z.string().nullable().optional(), // дата планового пересмотра (М6.5)
  kpi: z.array(Kpi).default([]),
  risks: z.array(Risk).default([]), // ФТ-М6.2.1
  frequency_per_month: z.number().nullable().optional(), // ФТ-М2.2.1: частота процесса для расчёта трудозатрат/стоимости за период
});
export type ProcessMeta = z.infer<typeof ProcessMeta>;

// --- PLM v2: связи между процессами (М3.2) ---
export const ProcessInterface = z.object({
  id: z.string(),
  direction: z.enum(["in", "out"]),
  data_id: z.string(), // id объекта в data[] текущей модели
  linked_process_id: z.string().nullable().optional(),
  linked_node_id: z.string().nullable().optional(),
});
export type ProcessInterface = z.infer<typeof ProcessInterface>;

// --- PLM v2: трассировка требований (М6.3) ---
export const RequirementLink = z.object({
  requirement_id: z.string(),
  element_id: z.string(),
  coverage: z.enum(["full", "partial"]).default("full"),
});
export type RequirementLink = z.infer<typeof RequirementLink>;

// --- PLM v2: матрица RACI (М1.3) ---
export const RaciType = z.enum(["R", "A", "C", "I"]);
export const RaciEntry = z.object({
  node_id: z.string(),
  role_id: z.string(),
  type: RaciType,
});
export type RaciEntry = z.infer<typeof RaciEntry>;

// --- Ролевая модель (Соглашение о моделировании, разд. 2) ---
// Должность (запись справочника «Исполнители») назначается на процесс или функцию в одной из ролей.
// owner/executor/coexecutor/controller в IDEF0 — механизмы; observer — только получатель информации.
export const AssignmentKind = z.enum(["owner", "executor", "coexecutor", "controller", "observer"]);
export type AssignmentKind = z.infer<typeof AssignmentKind>;
export const RoleAssignment = z.object({
  node_id: z.string().nullable(), // null — процесс в целом
  role_id: z.string(),
  kind: AssignmentKind,
  functions: z.array(z.string()).default([]), // функции роли в этом процессе (по одной на строку в документах)
});
export type RoleAssignment = z.infer<typeof RoleAssignment>;

// --- PLM v2: респонденты мультиинтервью (М4.1) ---
export const Respondent = z.object({
  id: z.string(),
  name: z.string().optional(),
  role_id: z.string().nullable().optional(),
  session_ids: z.array(z.string()).default([]), // внутренние id "дорожек" интервью (tracks) этого респондента
  weight: z.number().min(0).default(1), // ФТ-М4.1.5: вес при разрешении конфликтов (исполнитель > руководитель для своего шага)
});
export type Respondent = z.infer<typeof Respondent>;

// --- PLM v2: типы расхождений между респондентами (М4.1.3) ---
export const DiscrepancyKind = z.enum(["step_presence", "executor", "timing", "step_order"]);
export type DiscrepancyKind = z.infer<typeof DiscrepancyKind>;

// --- PLM v2: расхождения между респондентами (М4.1) ---
export const DiscrepancyVariant = z.object({
  respondent_id: z.string(),
  value: z.string(),
  source: z.array(SourceRef).default([]),
});
export const Discrepancy = z.object({
  id: z.string(),
  element_id: z.string(),
  kind: DiscrepancyKind.default("step_presence"),
  question: z.string().default(""), // ФТ-М4.1.4: сгенерированный вопрос для разрешения
  variants: z.array(DiscrepancyVariant).default([]),
  status: z.enum(["open", "resolved"]).default("open"),
  resolved_value: z.string().nullable().optional(),
});
export type Discrepancy = z.infer<typeof Discrepancy>;

// Принятые замечания проверок: аналитик признал отклонение осознанным («так нарисовано в документе») и записал причину.
// Замечание считается принятым, пока совпадают правило и элемент (у замечаний без элемента — ещё и текст).
export const AcceptedIssue = z.object({
  rule: z.string(),
  element_id: z.string().nullable().default(null),
  message: z.string().nullable().default(null),
  reason: z.string(),
  at: z.string().nullable().default(null),
});
export type AcceptedIssue = z.infer<typeof AcceptedIssue>;

export const ProcessLogicModel = z.object({
  schema_version: z.string().default(SCHEMA_VERSION),
  process: ProcessMeta,
  roles: z.array(Role).default([]),
  systems: z.array(SystemEntity).default([]),
  data: z.array(DataEntity).default([]),
  controls: z.array(ControlEntity).default([]),
  nodes: z.array(ProcessNode).default([]),
  flows: z.array(ProcessFlow).default([]),
  gaps: z.array(Gap).default([]),
  statements: z.array(Statement).default([]),
  // --- PLM v2 ---
  interfaces: z.array(ProcessInterface).default([]),
  requirements_links: z.array(RequirementLink).default([]),
  raci: z.array(RaciEntry).default([]),
  assignments: z.array(RoleAssignment).default([]),
  pools: z.array(ExternalPool).default([]),
  messages: z.array(MessageFlow).default([]),
  // Ширина дорожек диаграмм BPMN (правый край, px): ключ — id операции, пустая строка — общая схема процесса. Это нижняя граница:
  // шире содержимого дорожки растягивают, чтобы оставить место для новых фигур; без записи ширина по содержимому.
  diagram_widths: z.record(z.string(), z.number().min(MIN_DIAGRAM_W).max(MAX_DIAGRAM_W)).optional(),
  accepted_issues: z.array(AcceptedIssue).default([]),
  respondents: z.array(Respondent).default([]),
  discrepancies: z.array(Discrepancy).default([]),
});
export type ProcessLogicModel = z.infer<typeof ProcessLogicModel>;

export function emptyModel(meta: Partial<ProcessMeta> & { id: string; name: string }): ProcessLogicModel {
  return ProcessLogicModel.parse({
    schema_version: SCHEMA_VERSION,
    process: {
      id: meta.id,
      name: meta.name,
      owner: meta.owner,
      department: meta.department,
      type: meta.type ?? "AS-IS",
      goal: meta.goal,
      trigger: meta.trigger,
      result: meta.result,
      decomposition_depth: meta.decomposition_depth ?? 2,
      notations: meta.notations ?? ["IDEF0", "BPMN"],
    },
    roles: [],
    systems: [],
    data: [],
    controls: [],
    nodes: [],
    flows: [],
    gaps: [],
    statements: [],
  });
}

// --- Text fragment & speaker types (ФТ-1) ---

export const Speaker = z.enum(["interviewer", "owner", "participant", "unknown"]);
export type Speaker = z.infer<typeof Speaker>;

export const Fragment = z.object({
  id: z.string(),
  index: z.number(),
  speaker: Speaker,
  speaker_label: z.string().optional(),
  text: z.string(),
});
export type Fragment = z.infer<typeof Fragment>;

// --- Validation types (ФТ-5) ---

export const ValidationSeverity = z.enum(["error", "warning"]);
export const ValidationIssue = z.object({
  id: z.string(),
  notation: z.enum(["BPMN", "IDEF0", "MODEL"]),
  severity: ValidationSeverity,
  rule: z.string(),
  message: z.string(),
  element_id: z.string().nullable(),
});
export type ValidationIssue = z.infer<typeof ValidationIssue>;

// --- Chat / interview types (режим Б) ---

export const ChatMessage = z.object({
  id: z.string(),
  role: z.enum(["system", "assistant", "owner"]),
  text: z.string(),
  ts: z.number(),
  gap_id: z.string().nullable().optional(),
  /** Кто задал вопрос, если не система: интервьюер (логин). Такой вопрос сохранён и в списке вопросов к интервью. */
  author: z.string().optional(),
  /** Вопрос из списка вопросов к интервью (agent_questions): ответ владельца отметит его полученным. */
  question_id: z.string().optional(),
});
export type ChatMessage = z.infer<typeof ChatMessage>;
