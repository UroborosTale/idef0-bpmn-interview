import type { ValidationIssue } from "../types";

export default function ValidationPanel({ issues, onSelectElement }: { issues: ValidationIssue[]; onSelectElement: (id: string | null) => void }) {
  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");

  if (issues.length === 0) return <p className="muted">Замечаний нет — валидация пройдена.</p>;

  return (
    <div>
      {errors.length > 0 && (
        <>
          <h4 style={{ marginBottom: 6 }}>Ошибки (блокируют экспорт) — {errors.length}</h4>
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
    </div>
  );
}
