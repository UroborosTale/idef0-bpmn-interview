import type { EventTrigger } from "@shared/events";
import type { LoopKind } from "@shared/loops";
import type { ShapeStyle, StyleKind } from "@shared/shapeStyles";
import type { IdefFrame } from "@shared/idef0Frame";
export type Speaker = "interviewer" | "owner" | "participant" | "unknown";

export interface Fragment {
  id: string;
  index: number;
  speaker: Speaker;
  speaker_label?: string;
  text: string;
}

export interface SourceRef {
  fragment_id: string;
  quote: string;
}

export interface Role {
  id: string;
  name: string;
  kind: "internal" | "external";
  source: SourceRef[];
  description?: string | null;
  owner?: string | null;
  /** Должность: требуемая квалификация и специализация. */
  qualification?: string | null;
  /** Высота дорожки роли на диаграммах BPMN, px (120…600); без неё стандартная. */
  lane_height?: number | null;
  /** Объект общего репозитория организации. */
  repo_id?: string | null;
}

/** Ручной маршрут стрелки IDEF0; чего нет — выбирает автоматическая прокладка (@shared/idef0Layout). */
export interface ArrowRoute {
  /** Положение конца у блока вдоль стороны, 0…1. */
  pos?: number;
  /** У связи между функциями — положение конца у блока-источника. */
  from_pos?: number;
  /** Внутренние точки излома от начала стрелки к концу. */
  points?: [number, number][];
  /** Свободный конец внешней стрелки. */
  end?: [number, number];
  /** Сдвиг подписи. */
  label?: [number, number];
}

export interface SystemEntity {
  id: string;
  name: string;
  source: SourceRef[];
  description?: string | null;
  owner?: string | null;
  repo_id?: string | null;
}

export interface DataEntity {
  id: string;
  name: string;
  kind: "document" | "data";
  source: SourceRef[];
  description?: string | null;
  owner?: string | null;
  /** Карточка продукта: внешние поставщик и потребитель, ценность, стандарт качества. */
  supplier?: string | null;
  consumer?: string | null;
  value?: string | null;
  quality_standard?: string | null;
  repo_id?: string | null;
}

export interface ControlEntity {
  id: string;
  name: string;
  kind: "regulation" | "rule" | "norm";
  source: SourceRef[];
  description?: string | null;
  owner?: string | null;
  reference?: string | null;
}

export interface ProcessNode {
  id: string;
  type: "task" | "event" | "gateway" | "subprocess";
  subtype?: string;
  /** Событие: триггер (сообщение, таймер, условие, сигнал, ошибка…); вид события — subtype. */
  trigger?: EventTrigger | null;
  name: string;
  role_id?: string | null;
  system_ids: string[];
  inputs: string[];
  outputs: string[];
  controls: string[];
  control_data_ids?: string[];
  duration?: string | null;
  frequency?: string | null;
  /** Описание деятельности, как в карточке Business Studio: содержание, начало, результат, требования к срокам. */
  content?: string | null;
  begin?: string | null;
  result?: string | null;
  deadline?: string | null;
  /** Жизненный цикл объекта, как в Business Studio: статус и версия (без поля — «в работе», 1.0.0). */
  lc_status?: "in_work" | "review" | "approved" | "archived";
  lc_version?: string;
  idef0_parent?: string | null;
  /** Шаг диаграммы BPMN операции: id функции IDEF0 (операции). */
  bpmn_scope?: string | null;
  /** Граничное событие: id задачи или подпроцесса, к границе которых оно прикреплено. Положение выводится из задачи. */
  attached_to?: string | null;
  /** Граничное событие прерывает задачу (по умолчанию) или нет. */
  interrupting?: boolean;
  /** Цикличность задачи или подпроцесса: маркер на фигуре; без поля шаг выполняется один раз. */
  loop?: LoopKind;
  layout?: { x: number; y: number } | null;
  idef0_layout?: { x: number; y: number } | null;
  /** Туннели внешних стрелок IDEF0 этой функции (скобки у конца): ключ «вид:сущность»; up — нет на диаграмме выше, down — нет в декомпозиции. */
  tunnels?: Record<string, { up?: boolean; down?: boolean }>;
  /** Ручные маршруты стрелок IDEF0 этой функции: ключ «вид:сущность». */
  arrow_routes?: Record<string, ArrowRoute>;
  /** Ручное смещение значков документов и хранилищ BPMN от автоматического места: ключ «вид:сущность». */
  artifact_offsets?: Record<string, { dx: number; dy: number }>;
  note?: string;
  status: "confirmed" | "hypothesis";
  confidence: number;
  source: SourceRef[];
  time_processing?: string | null;
  time_waiting?: string | null;
  cost_estimate?: string | null;
  requirement_ids: string[];
  tags: string[];
  confirmed_by: string[];
}

export interface ProcessFlow {
  id: string;
  from: string;
  to: string;
  condition?: string | null;
  /** Ветка «по умолчанию»: идёт, когда условия других веток не выполнены. */
  is_default?: boolean;
  /** Ручной маршрут: стороны, положение концов, точки излома; без него маршрут выбирается автоматически. */
  route?: FlowRoute | null;
  source: SourceRef[];
  confirmed_by: string[];
}

export interface FlowRoute {
  from_side?: "L" | "R" | "T" | "B";
  to_side?: "L" | "R" | "T" | "B";
  channel?: number;
  /** Положение конца вдоль стороны фигуры (0…1); без него концы разводятся автоматически. */
  from_pos?: number;
  to_pos?: number;
  /** Внутренние точки излома от выхода ко входу; линия идёт строго через них. */
  points?: [number, number][];
}

/** Внешний пул: другой процесс (по коду) или внешний участник; на диаграмме — свёрнутый пул. */
export interface ExternalPool {
  id: string;
  name: string;
  code?: string | null;
  /** Пул без потоков сообщений показывается только на диаграмме, где его создали (id операции; "" — общая схема). */
  scope?: string;
  /** Ручное смещение пула от автоматического места под диаграммой. */
  dx?: number;
  dy?: number;
}

/** Поток сообщений между шагом диаграммы и внешним пулом (from/to — id узла и id пула). */
export interface MessageFlow {
  id: string;
  /** Ручной маршрут стрелки (точки излома и положение участков). */
  route?: FlowRoute | null;
  from: string;
  to: string;
  name?: string | null;
}

/** Принятое замечание проверки: отклонение признано осознанным, причина записана. */
export interface AcceptedIssue {
  rule: string;
  element_id: string | null;
  message: string | null;
  reason: string;
  at: string | null;
}

export type GapPriority = "critical" | "important" | "desirable";

export interface Gap {
  id: string;
  rule: string;
  priority: GapPriority;
  element_id: string | null;
  question: string;
  status: "open" | "answered" | "dismissed";
  topic?: string;
}

export interface Statement {
  id: string;
  kind: "problem" | "proposal";
  text: string;
  source: SourceRef[];
}

export interface Kpi {
  id: string;
  name: string;
  target?: string | null;
  unit?: string | null;
  source: SourceRef[];
  description?: string | null;
  owner?: string | null;
  period?: string | null;
}

export interface Risk {
  id: string;
  name: string;
  mitigation?: string | null;
  source: SourceRef[];
  description?: string | null;
  owner?: string | null;
  level?: "low" | "medium" | "high" | null;
}

export interface ProcessMeta {
  id: string;
  name: string;
  owner?: string;
  department?: string;
  /** Группа процессов — папка верхнего уровня в навигаторе (укрупнённый процесс, к которому относится этот). */
  group?: string | null;
  author?: string;
  type: "AS-IS" | "TO-BE";
  goal?: string;
  trigger?: string;
  result?: string;
  decomposition_depth: number;
  /** Высота дорожки «Без исполнителя», px (120…600); без неё стандартная. */
  unassigned_lane_height?: number | null;
  notations: ("IDEF0" | "BPMN")[];
  code?: string | null;
  level?: "L0" | "L1" | "L2" | "L3" | null;
  parent_process_id?: string | null;
  version: string;
  status: "draft" | "review" | "needs_rework" | "approved" | "archived";
  review_date?: string | null;
  kpi: Kpi[];
  risks: Risk[];
  frequency_per_month?: number | null;
}

export interface ProcessInterface {
  id: string;
  direction: "in" | "out";
  data_id: string;
  linked_process_id?: string | null;
  linked_node_id?: string | null;
}

export interface RequirementLink {
  requirement_id: string;
  element_id: string;
  coverage: "full" | "partial";
}

/** Набор объектов (shared/objectSets.ts): именованный список функций; в набор входит функция и всё вложенное в неё. */
export interface ObjectSet {
  id: string;
  name: string;
  members: string[];
  /** Записи справочников в наборе: ключи «справочник:id» (shared/objectSets.ts, entryKey). */
  entries?: string[];
}

export interface RaciEntry {
  node_id: string;
  role_id: string;
  type: "R" | "A" | "C" | "I";
}

export type AssignmentKind = "owner" | "executor" | "coexecutor" | "controller" | "observer";

/** Ролевая модель: должность в роли на процессе (node_id = null) или функции. */
export interface RoleAssignment {
  node_id: string | null;
  role_id: string;
  kind: AssignmentKind;
  functions: string[];
}

export interface Respondent {
  id: string;
  name?: string;
  role_id?: string | null;
  session_ids: string[];
  weight: number;
}

export type DiscrepancyKind = "step_presence" | "executor" | "timing" | "step_order";

export interface Discrepancy {
  id: string;
  element_id: string;
  kind: DiscrepancyKind;
  question: string;
  variants: { respondent_id: string; value: string; source: SourceRef[] }[];
  status: "open" | "resolved";
  resolved_value?: string | null;
}

export interface ProcessLogicModel {
  schema_version: string;
  process: ProcessMeta;
  roles: Role[];
  systems: SystemEntity[];
  data: DataEntity[];
  controls: ControlEntity[];
  nodes: ProcessNode[];
  flows: ProcessFlow[];
  gaps: Gap[];
  statements: Statement[];
  interfaces: ProcessInterface[];
  requirements_links: RequirementLink[];
  raci: RaciEntry[];
  assignments: RoleAssignment[];
  pools: ExternalPool[];
  messages: MessageFlow[];
  /** Ширина дорожек диаграмм BPMN, px: ключ — id операции, "" — общая схема процесса; нижняя граница, шире содержимого. */
  diagram_widths?: Record<string, number>;
  /** Рамка листа и сетка диаграмм IDEF0: ключ — id функции, "" — верхняя диаграмма. */
  idef0_frames?: Record<string, IdefFrame>;
  /** Рамка листа и сетка диаграмм BPMN: ключ — id операции, "" — общая схема процесса. */
  bpmn_frames?: Record<string, IdefFrame>;
  accepted_issues: AcceptedIssue[];
  /** Наборы объектов для фильтра навигатора и выгрузки. */
  object_sets?: ObjectSet[];
  /** Оформление фигур по видам: заливка, линия, цвет и размер текста (shared/shapeStyles.ts); одно на все диаграммы. */
  shape_styles?: Partial<Record<StyleKind, ShapeStyle>>;
  respondents: Respondent[];
  discrepancies: Discrepancy[];
}

export interface ValidationIssue {
  id: string;
  notation: "BPMN" | "IDEF0" | "MODEL";
  severity: "error" | "warning";
  rule: string;
  message: string;
  element_id: string | null;
}

export interface ChatMessage {
  id: string;
  role: "system" | "assistant" | "owner";
  text: string;
  ts: number;
  gap_id?: string | null;
  /** Интервьюер (логин), если вопрос задал он, а не система. */
  author?: string;
  question_id?: string;
}

export interface Idef0Block {
  nodeId: string;
  code: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Idef0ChildDiagram {
  parentNodeId: string;
  code: string; // A2, A31…
  name: string;
  svg: string;
}

export interface Idef0Result {
  contextSvg: string;
  decompositionSvg: string;
  nodeTreeSvg: string;
  /** Диаграммы декомпозиции вложенных функций; у сессий, собранных до появления декомпозиции, поля нет. */
  children?: Idef0ChildDiagram[];
  blocks: Idef0Block[];
  width: number;
  height: number;
}

export interface SessionMeta {
  processName: string;
  department?: string;
  owner?: string;
  modelType: "AS-IS" | "TO-BE";
  decompositionDepth: number;
  notations: ("IDEF0" | "BPMN")[];
  confidential?: boolean;
  /** Конфиденциальную сессию агенты видят, только если аналитик разрешил. */
  agentAccess?: boolean;
}

export interface Comment {
  id: string;
  element_id: string | null;
  text: string;
  author: string;
  ts: string;
}

export interface VersionListItem {
  seq: number;
  version: string;
  major: boolean;
  ts: string;
  note: string;
  author: string;
  nodeCount: number;
  flowCount: number;
}

export interface VersionSnapshot {
  seq: number;
  version: string;
  major: boolean;
  ts: string;
  note: string;
  author: string;
  model: ProcessLogicModel;
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
  regulationSnapshotSeq: number | null;
  respondents: SessionRespondent[];
  tracks: InterviewTrack[];
  verificationConfirmed: string[];
  reviewRoute: unknown | null; // см. ReviewRoute в api/client.ts (типизировано подробно там, чтобы не заводить цикл импортов)
  createdAt: string;
  updatedAt: string;
}

export interface SessionRespondent {
  id: string;
  name: string;
  roleId: string | null;
  weight: number;
}

export interface InterviewTrack {
  id: string;
  respondentId: string;
  mode: "text" | "chat";
  fragments: Fragment[];
  rawText: string;
  chat: ChatMessage[];
  status: "pending" | "in_progress" | "completed";
}

export interface SessionListItem {
  id: string;
  title: string;
  mode: "A" | "B";
  status: SessionRecord["status"];
  meta: SessionMeta;
  updatedAt: string;
  createdAt: string;
  gapsOpen: number;
  hasErrors: boolean;
  diagramsStale: boolean;
}

export interface HistoryChange {
  field: string;
  from: string | null;
  to: string | null;
}

/** Событие в истории записи справочника или шага (по сохранённым версиям модели). */
export interface HistoryEvent {
  seq: number;
  version: string;
  ts: string;
  author: string;
  note: string;
  event: "created" | "changed" | "removed";
  changes: HistoryChange[];
}
export type { EventTrigger };
