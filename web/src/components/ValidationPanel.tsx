import type { ValidationIssue } from "../types";

/** Принятое замечание: причина и дата берутся из model.accepted_issues. */
type AcceptedIssue = ValidationIssue & { reason: string; at: string | null };

export default function ValidationPanel({
  issues,
  accepted = [],
  onSelectElement,
}: {
  issues: ValidationIssue[];
  accepted?: AcceptedIssue[];
  onSelectElement: (id: string | null) => void;
}) {
  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");

  if (issues.length === 0 && accepted.length === 0) return <p className="muted">Замечаний нет — валидация пройдена.</p>;

  return (
    <div>
      {issues.length === 0 && (
        <p className="muted">Действующих замечаний нет — остались только принятые ({accepted.length}).</p>
      )}
      {errors.length > 0 && (
        <>
          <h4 style={{ marginBottom: 6 }} title="Экспорт диаграмм возможен и с ошибками; ошибки не дают завершить интервью и утвердить модель">
          Ошибки (модель некорректна) — {errors.length}
        </h4>
          {errors.map((i) => (
            <div key={i.id} className="validation-item error" onClick={() => i.element_id && onSelectElement(i.element_id)} style={{ cursor: i.element_id ? "pointer" : "default" }}>
              <strong>[{i.notation}]</strong> {i.message}
            </div>
          ))}
        </>
      )}
      {warnings.length > 0 && (
        <>
          <h4 style={{ marginTop: 16, marginBottom: 6 }}>Предупреждения — {warnings.length}</h4>
          {warnings.map((i) => (
            <div key={i.id} className="validation-item warning" onClick={() => i.element_id && onSelectElement(i.element_id)} style={{ cursor: i.element_id ? "pointer" : "default" }}>
              <strong>[{i.notation}]</strong> {i.message}
            </div>
          ))}
        </>
      )}
      {accepted.length > 0 && (
        <>
          <h4 style={{ marginTop: 16, marginBottom: 6 }} title="Принятые замечания не мешают завершить интервью и утвердить модель">
            Принятые — {accepted.length}
          </h4>
          {accepted.map((i) => (
            <div
              key={`accepted-${i.id}`}
              className="validation-item accepted"
              data-accepted-rule={i.rule}
              onClick={() => i.element_id && onSelectElement(i.element_id)}
              style={{ cursor: i.element_id ? "pointer" : "default" }}
              title={i.at ? `Принято ${new Date(i.at).toLocaleString("ru-RU")}: ${i.reason}` : undefined}
            >
              <strong>[{i.notation}]</strong> {i.message}
              <span className="muted"> — принято: {i.reason}</span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
