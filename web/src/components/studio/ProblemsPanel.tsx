import { useEffect, useState } from "react";
import type { AgentQuestionRow, AgentReportRow, AgentTaskRow, Proposal, ReportFinding } from "../../api/client";
import type { ProcessLogicModel, ValidationIssue } from "../../types";
import ProposalsList from "./ProposalsList";
import TasksPanel from "./TasksPanel";
import QuestionsPanel, { isLiveQuestion } from "./QuestionsPanel";
import ReportsPanel from "./ReportsPanel";
import { ruleTitle } from "./rule-titles";
import type { QuickFix } from "./quick-fixes";

type AcceptedRow = ValidationIssue & { reason: string; at: string | null };

const PRIORITY: Record<string, string> = { critical: "Критично", important: "Важно", desirable: "Желательно" };

/**
 * Нижняя панель окна студии: проверки модели, пересчитываемые по ходу правки, и открытые пробелы
 * интервью. Щелчок по замечанию открывает диаграмму и выделяет элемент.
 */
export default function ProblemsPanel({
  model,
  issues,
  onGoto,
  proposals = [],
  onApplyProposal,
  onRejectProposal,
  showTab,
  tasks = [],
  selectedFn = null,
  labelOf = (id) => id,
  onCreateTask,
  onCancelTask,
  questions = [],
  onQuestionStatus,
  reports = [],
  onReportStatus,
  onHandOffAnswers,
  nodeByCode,
  onSelectFn,
  onAssignFinding,
  acceptedIssues = [],
  fixFor,
  onFix,
  onAccept,
  onRevoke,
}: {
  model: ProcessLogicModel;
  /** Проверки текущего черновика (считает студия — их же показывают инспекторы редакторов). */
  issues: ValidationIssue[];
  onGoto: (issue: { elementId: string | null; notation: ValidationIssue["notation"] }) => void;
  /** Предложения агентов, ожидающие решения. */
  proposals?: Proposal[];
  onApplyProposal?: (p: Proposal) => void | Promise<void>;
  onRejectProposal?: (p: Proposal, reason: string) => void | Promise<void>;
  /** Открыть вкладку по запросу извне (кнопка «Предложения» в ленте); nonce меняется при каждом запросе. */
  showTab?: { tab: "issues" | "gaps" | "proposals" | "tasks" | "questions" | "reports"; nonce: number } | null;
  /** Задания аналитика агенту и их статусы. */
  tasks?: AgentTaskRow[];
  selectedFn?: { id: string; label: string } | null;
  labelOf?: (nodeId: string) => string;
  onCreateTask?: (task: { text: string; scope: string | null; agent?: string }) => void | Promise<void>;
  onCancelTask?: (task: AgentTaskRow) => void | Promise<void>;
  /** Вопросы к интервью (готовит интервьюер) и отчёты агентов; решения аналитика. */
  questions?: AgentQuestionRow[];
  onQuestionStatus?: (q: AgentQuestionRow, status: AgentQuestionRow["status"], answer?: string) => void | Promise<void>;
  reports?: AgentReportRow[];
  onReportStatus?: (r: AgentReportRow, status: AgentReportRow["status"]) => void | Promise<void>;
  onHandOffAnswers?: () => void | Promise<void>;
  nodeByCode?: (code: string) => string | null;
  onSelectFn?: (nodeId: string) => void;
  onAssignFinding?: (report: AgentReportRow, finding: ReportFinding) => void | Promise<void>;
  /** Принятые аналитиком замечания с причиной: в счётчики не входят, показываются по флажку. */
  acceptedIssues?: AcceptedRow[];
  /** Однозначное исправление замечания, если оно есть. */
  fixFor?: (issue: ValidationIssue) => QuickFix | null;
  onFix?: (issue: ValidationIssue, fix: QuickFix, optionId?: string) => void;
  /** Принять замечание (только предупреждения) с причиной / вернуть принятое. */
  onAccept?: (issue: ValidationIssue, reason: string) => void;
  onRevoke?: (issue: ValidationIssue) => void;
}) {
  const [tab, setTab] = useState<"issues" | "gaps" | "proposals" | "tasks" | "questions" | "reports">("issues");
  useEffect(() => {
    if (showTab) setTab(showTab.tab);
  }, [showTab?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps
  const [show, setShow] = useState<{ error: boolean; warning: boolean; accepted: boolean }>({ error: true, warning: true, accepted: false });
  const [grouped, setGrouped] = useState(false);
  const [accepting, setAccepting] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");
  const gaps = model.gaps.filter((g) => g.status === "open");
  const nameOf = (id: string | null) => (id ? model.nodes.find((n) => n.id === id)?.name ?? model.roles.find((r) => r.id === id)?.name ?? null : null);
  const shown = issues.filter((i) => show[i.severity]);
  const ordered = grouped ? [...shown].sort((a, b) => ruleTitle(a.rule).localeCompare(ruleTitle(b.rule), "ru")) : shown;
  const commitAccept = (i: ValidationIssue) => {
    if (!reason.trim()) return;
    onAccept?.(i, reason.trim());
    setAccepting(null);
    setReason("");
  };

  return (
    <div className="problems">
      <div className="problems-head">
        <button className={tab === "issues" ? "active" : ""} onClick={() => setTab("issues")}>
          Проверки <span className={`pill-count ${errors.length ? "err" : ""}`}>{errors.length}</span>
          <span className="pill-count warn">{warnings.length}</span>
        </button>
        <button className={tab === "gaps" ? "active" : ""} onClick={() => setTab("gaps")}>
          Пробелы интервью <span className="pill-count">{gaps.length}</span>
        </button>
        <button className={tab === "proposals" ? "active" : ""} onClick={() => setTab("proposals")}>
          Предложения агентов <span className={`pill-count ${proposals.length ? "warn" : ""}`}>{proposals.length}</span>
        </button>
        <button className={tab === "tasks" ? "active" : ""} onClick={() => setTab("tasks")}>
          Задания агенту <span className={`pill-count ${tasks.some((t) => t.status === "open" || t.status === "taken") ? "warn" : ""}`}>{tasks.filter((t) => t.status === "open" || t.status === "taken").length}</span>
        </button>
        <button className={tab === "questions" ? "active" : ""} onClick={() => setTab("questions")}>
          Вопросы <span className={`pill-count ${questions.some(isLiveQuestion) ? "warn" : ""}`}>{questions.filter(isLiveQuestion).length}</span>
        </button>
        <button className={tab === "reports" ? "active" : ""} onClick={() => setTab("reports")}>
          Отчёты <span className={`pill-count ${reports.some((r) => r.status === "new") ? "warn" : ""}`}>{reports.filter((r) => r.status === "new").length}</span>
        </button>
        <span className="spacer" />
        {tab === "issues" && (
          <>
            <label className="problems-filter">
              <input type="checkbox" checked={show.error} onChange={(e) => setShow({ ...show, error: e.target.checked })} /> ошибки
            </label>
            <label className="problems-filter">
              <input type="checkbox" checked={show.warning} onChange={(e) => setShow({ ...show, warning: e.target.checked })} /> предупреждения
            </label>
            <label className="problems-filter" title="Замечания, которые аналитик принял с причиной">
              <input type="checkbox" checked={show.accepted} onChange={(e) => setShow({ ...show, accepted: e.target.checked })} /> принятые ({acceptedIssues.length})
            </label>
            <label className="problems-filter">
              <input type="checkbox" checked={grouped} onChange={(e) => setGrouped(e.target.checked)} /> по правилам
            </label>
          </>
        )}
      </div>
      <div className="problems-body">
        {tab === "issues" && shown.length === 0 && !(show.accepted && acceptedIssues.length > 0) && (
          <div className="muted problems-empty">{issues.length === 0 ? (acceptedIssues.length > 0 ? `Действующих замечаний нет; принято: ${acceptedIssues.length}.` : "Замечаний нет — модель прошла все проверки.") : "Скрыто фильтром."}</div>
        )}
        {tab === "issues" &&
          ordered.map((i, idx) => {
            const fix = fixFor?.(i) ?? null;
            const prevRule = idx > 0 ? ordered[idx - 1].rule : null;
            return (
              <div key={i.id}>
                {grouped && i.rule !== prevRule && (
                  <div className="problem-group">
                    {ruleTitle(i.rule)} <span className="pill-count">{ordered.filter((x) => x.rule === i.rule).length}</span>
                  </div>
                )}
                <div className={`problem-row ${i.severity}`} data-issue-rule={i.rule} onClick={() => onGoto({ elementId: i.element_id, notation: i.notation })} title={nameOf(i.element_id) ?? undefined}>
                  <span className="problem-mark">{i.severity === "error" ? "✖" : "▲"}</span>
                  <span className="problem-notation">{i.notation}</span>
                  <span className="problem-text">{i.message}</span>
                  {nameOf(i.element_id) && <span className="problem-target">{nameOf(i.element_id)}</span>}
                  <span className="problem-actions" onClick={(e) => e.stopPropagation()}>
                    {fix && !fix.options && (
                      <button className="fix-btn" title={fix.label} onClick={() => onFix?.(i, fix)}>
                        Исправить
                      </button>
                    )}
                    {fix?.options && (
                      <select
                        className="fix-select"
                        aria-label={fix.label}
                        value=""
                        onChange={(e) => e.target.value && onFix?.(i, fix, e.target.value)}
                      >
                        <option value="">{fix.label}</option>
                        {fix.options.map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    )}
                    {i.severity === "warning" && onAccept && (
                      <button className="fix-btn" title="Признать отклонение осознанным и записать причину" onClick={() => (setAccepting(accepting === i.id ? null : i.id), setReason(""))}>
                        Принять…
                      </button>
                    )}
                  </span>
                </div>
                {accepting === i.id && (
                  <div className="problem-accept">
                    <input autoFocus placeholder="Почему принимаем (запишем в модель)" value={reason} onChange={(e) => setReason(e.target.value)} onKeyDown={(e) => (e.stopPropagation(), e.key === "Enter" && commitAccept(i))} />
                    <button className="primary" disabled={!reason.trim()} onClick={() => commitAccept(i)}>
                      Принять
                    </button>
                    <button onClick={() => setAccepting(null)}>Отмена</button>
                  </div>
                )}
              </div>
            );
          })}
        {tab === "issues" &&
          show.accepted &&
          acceptedIssues.map((i) => (
            <div key={`acc-${i.id}`} className="problem-row accepted" data-accepted-rule={i.rule} onClick={() => onGoto({ elementId: i.element_id, notation: i.notation })}>
              <span className="problem-mark">✓</span>
              <span className="problem-notation">{i.notation}</span>
              <span className="problem-text">
                {i.message} <span className="problem-reason">— принято: {i.reason}</span>
              </span>
              {nameOf(i.element_id) && <span className="problem-target">{nameOf(i.element_id)}</span>}
              <span className="problem-actions" onClick={(e) => e.stopPropagation()}>
                <button className="fix-btn" onClick={() => onRevoke?.(i)}>
                  Вернуть
                </button>
              </span>
            </div>
          ))}        {tab === "proposals" && <ProposalsList model={model} proposals={proposals} onApply={(p) => onApplyProposal?.(p)} onReject={(p, r) => onRejectProposal?.(p, r)} />}
        {tab === "tasks" && (
          <TasksPanel tasks={tasks} selected={selectedFn} labelOf={labelOf} onCreate={(t) => onCreateTask?.(t)} onCancel={(t) => onCancelTask?.(t)} onShowProposals={() => setTab("proposals")} />
        )}
        {tab === "questions" && <QuestionsPanel questions={questions} labelOf={labelOf} processName={model.process.name} onStatus={(q, s, a) => onQuestionStatus?.(q, s, a)} onHandOff={onHandOffAnswers} />}
        {tab === "reports" && <ReportsPanel reports={reports} labelOf={labelOf} onStatus={(r, s) => onReportStatus?.(r, s)} nodeByCode={nodeByCode} onSelectFn={onSelectFn} onAssign={onAssignFinding} />}
        {tab === "gaps" && gaps.length === 0 && <div className="muted problems-empty">Открытых вопросов нет.</div>}
        {tab === "gaps" &&
          gaps.map((g) => (
            <div key={g.id} className="problem-row gap" onClick={() => onGoto({ elementId: g.element_id, notation: "BPMN" })}>
              <span className="problem-mark">?</span>
              <span className="problem-notation">{PRIORITY[g.priority] ?? g.priority}</span>
              <span className="problem-text">{g.question}</span>
              {nameOf(g.element_id) && <span className="problem-target">{nameOf(g.element_id)}</span>}
            </div>
          ))}
      </div>
    </div>
  );
}
