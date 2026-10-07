import { useState } from "react";
import type { ProcessLogicModel, ValidationIssue } from "../../types";

const PRIORITY: Record<string, string> = { critical: "Критично", important: "Важно", desirable: "Желательно" };

/**
 * Нижняя панель окна студии: проверки модели, пересчитываемые по ходу правки, и открытые пробелы
 * интервью. Щелчок по замечанию открывает диаграмму и выделяет элемент.
 */
export default function ProblemsPanel({
  model,
  issues,
  onGoto,
}: {
  model: ProcessLogicModel;
  /** Проверки текущего черновика (считает студия — их же показывают инспекторы редакторов). */
  issues: ValidationIssue[];
  onGoto: (issue: { elementId: string | null; notation: ValidationIssue["notation"] }) => void;
}) {
  const [tab, setTab] = useState<"issues" | "gaps">("issues");
  const [show, setShow] = useState<{ error: boolean; warning: boolean }>({ error: true, warning: true });
  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");
  const gaps = model.gaps.filter((g) => g.status === "open");
  const nameOf = (id: string | null) => (id ? model.nodes.find((n) => n.id === id)?.name ?? model.roles.find((r) => r.id === id)?.name ?? null : null);
  const shown = issues.filter((i) => show[i.severity]);

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
        <span className="spacer" />
        {tab === "issues" && (
          <>
            <label className="problems-filter">
              <input type="checkbox" checked={show.error} onChange={(e) => setShow({ ...show, error: e.target.checked })} /> ошибки
            </label>
            <label className="problems-filter">
              <input type="checkbox" checked={show.warning} onChange={(e) => setShow({ ...show, warning: e.target.checked })} /> предупреждения
            </label>
          </>
        )}
      </div>
      <div className="problems-body">
        {tab === "issues" && shown.length === 0 && <div className="muted problems-empty">{issues.length === 0 ? "Замечаний нет — модель прошла все проверки." : "Скрыто фильтром."}</div>}
        {tab === "issues" &&
          shown.map((i) => (
            <div key={i.id} className={`problem-row ${i.severity}`} onClick={() => onGoto({ elementId: i.element_id, notation: i.notation })} title={nameOf(i.element_id) ?? undefined}>
              <span className="problem-mark">{i.severity === "error" ? "✖" : "▲"}</span>
              <span className="problem-notation">{i.notation}</span>
              <span className="problem-text">{i.message}</span>
              {nameOf(i.element_id) && <span className="problem-target">{nameOf(i.element_id)}</span>}
            </div>
          ))}
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
