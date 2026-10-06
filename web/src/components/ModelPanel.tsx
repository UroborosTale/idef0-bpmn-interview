import { useState } from "react";
import type { ProcessLogicModel, ProcessNode } from "../types";

const TYPE_LABEL: Record<string, string> = { task: "Действие", event: "Событие", gateway: "Ветвление", subprocess: "Подпроцесс" };

export default function ModelPanel({
  model,
  selectedId,
  onSelectElement,
  onUpdateNode,
}: {
  model: ProcessLogicModel;
  selectedId: string | null;
  onSelectElement: (id: string | null) => void;
  onUpdateNode: (nodeId: string, patch: Partial<ProcessNode>) => void;
}) {
  const [onlyHypotheses, setOnlyHypotheses] = useState(false);
  const [threshold, setThreshold] = useState(0);
  const [editingId, setEditingId] = useState<string | null>(null);

  const roleById = new Map(model.roles.map((r) => [r.id, r.name] as const));

  const nodes = model.nodes.filter((n) => {
    if (onlyHypotheses && n.status !== "hypothesis") return false;
    if (n.confidence < threshold) return false;
    return true;
  });

  return (
    <div>
      <div className="toolbar">
        <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12 }}>
          <input type="checkbox" checked={onlyHypotheses} onChange={(e) => setOnlyHypotheses(e.target.checked)} />
          Только гипотезы
        </label>
        <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12 }}>
          Порог уверенности ≥
          <input type="number" min={0} max={1} step={0.1} value={threshold} style={{ width: 60 }} onChange={(e) => setThreshold(Number(e.target.value))} />
        </label>
      </div>

      <h4>Действия / события / ветвления ({nodes.length})</h4>
      {nodes.map((n) => (
        <div key={n.id} className={`node-row ${n.status === "hypothesis" ? "hypothesis" : ""}`}
             style={{ borderColor: selectedId === n.id ? "var(--accent)" : undefined }}
             onClick={() => onSelectElement(n.id)}>
          <div style={{ flex: 1 }}>
            {editingId === n.id ? (
              <input
                autoFocus
                defaultValue={n.name}
                onClick={(e) => e.stopPropagation()}
                onBlur={(e) => { onUpdateNode(n.id, { name: e.target.value }); setEditingId(null); }}
                onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
              />
            ) : (
              <span onDoubleClick={(e) => { e.stopPropagation(); setEditingId(n.id); }}>
                <span className="muted">[{TYPE_LABEL[n.type]}]</span> {n.name}
                {n.status === "hypothesis" && <span className="badge-hyp">гипотеза</span>}
              </span>
            )}
            <div className="muted" style={{ fontSize: 11 }}>
              исполнитель: {n.role_id ? roleById.get(n.role_id) ?? "?" : "—"}
            </div>
          </div>
          <div className="confidence-bar" title={`Уверенность: ${n.confidence.toFixed(2)}`}>
            <span style={{ width: `${Math.round(n.confidence * 100)}%` }} />
          </div>
        </div>
      ))}

      <details style={{ marginTop: 16 }}>
        <summary>Роли ({model.roles.length})</summary>
        <ul>{model.roles.map((r) => <li key={r.id}>{r.name} <span className="muted">({r.kind === "internal" ? "внутр." : "внешн."})</span></li>)}</ul>
      </details>
      <details>
        <summary>Документы и данные ({model.data.length})</summary>
        <ul>{model.data.map((d) => <li key={d.id}>{d.name} <span className="muted">({d.kind})</span></li>)}</ul>
      </details>
      <details>
        <summary>Информационные системы ({model.systems.length})</summary>
        <ul>{model.systems.map((s) => <li key={s.id}>{s.name}</li>)}</ul>
      </details>
      <details>
        <summary>Регламентирующие факторы ({model.controls.length})</summary>
        <ul>{model.controls.map((c) => <li key={c.id}>{c.name}</li>)}</ul>
      </details>
    </div>
  );
}
