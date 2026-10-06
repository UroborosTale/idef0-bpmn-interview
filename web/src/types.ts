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
}

export interface SystemEntity {
  id: string;
  name: string;
  source: SourceRef[];
}

export interface DataEntity {
  id: string;
  name: string;
  kind: "document" | "data";
  source: SourceRef[];
}

export interface ControlEntity {
  id: string;
  name: string;
  kind: "regulation" | "rule" | "norm";
  source: SourceRef[];
}

export interface ProcessNode {
  id: string;
  type: "task" | "event" | "gateway" | "subprocess";
  subtype?: string;
  name: string;
  role_id?: string | null;
  system_ids: string[];
  inputs: string[];
  outputs: string[];
  controls: string[];
  control_data_ids?: string[];
  duration?: string | null;
  frequency?: string | null;
  idef0_parent?: string | null;
  layout?: { x: number; y: number } | null;
  idef0_layout?: { x: number; y: number } | null;
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
  source: SourceRef[];
  confirmed_by: string[];
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
}

export interface Risk {
  id: string;
  name: string;
  mitigation?: string | null;
  source: SourceRef[];
}

export interface ProcessMeta {
  id: string;
  name: string;
  owner?: string;
  department?: string;
  type: "AS-IS" | "TO-BE";
  goal?: string;
  trigger?: string;
  result?: string;
  decomposition_depth: number;
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

export interface RaciEntry {
  node_id: string;
  role_id: string;
  type: "R" | "A" | "C" | "I";
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
