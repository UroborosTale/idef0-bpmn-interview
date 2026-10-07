import { useState } from "react";
import type { AssignmentKind, ProcessLogicModel, RoleAssignment } from "../../types";
import { CommitInput } from "../editor-core/fields";
import { addRole, renameRole } from "../bpmn-editor/model-ops";
import { ASSIGNMENT_LABELS } from "./dict-ops";

type M = ProcessLogicModel;

const KINDS = Object.keys(ASSIGNMENT_LABELS) as AssignmentKind[];

const HINTS: Record<AssignmentKind, string> = {
  owner: "Отвечает за результат и актуальность модели; один на процесс или подпроцесс. В IDEF0 — механизм.",
  executor: "Выполняет операции; в BPMN — дорожка, в IDEF0 — механизм.",
  coexecutor: "Выполняет делегированные действия; в IDEF0 — механизм, в BPMN — дорожка.",
  controller: "Проверяет качество результата и решает о допуске; в IDEF0 — механизм.",
  observer: "Только получает информацию; в IDEF0 не показывается.",
};

/**
 * Ролевая модель процесса или функции (Соглашение о моделировании, разд. 2): должности из справочника «Исполнители»
 * в ролях владельца, исполнителя, соисполнителя, контролёра и наблюдателя и их функции — они попадают в таблицу
 * ролей регламента и инструкции, а в IDEF0 показываются механизмами. nodeId = null — процесс в целом.
 */
export default function AssignmentsEditor({ model, nodeId, defaultKind = "executor", onChange }: { model: M; nodeId: string | null; defaultKind?: AssignmentKind; onChange: (next: M) => void }) {
  const [creating, setCreating] = useState(false);
  const all = model.assignments ?? [];
  const mine = all.map((a, index) => ({ a, index })).filter(({ a }) => a.node_id === nodeId);
  const set = (index: number, patch: Partial<RoleAssignment>) => onChange({ ...model, assignments: all.map((a, i) => (i === index ? { ...a, ...patch } : a)) });
  const add = (roleId: string, kind: AssignmentKind = defaultKind, base: M = model) =>
    onChange({ ...base, assignments: [...(base.assignments ?? []), { node_id: nodeId, role_id: roleId, kind, functions: [] }] });
  const free = model.roles.filter((r) => !mine.some(({ a }) => a.role_id === r.id));

  return (
    <div className="assignments">
      {mine.length === 0 && <p className="muted prop-note">Роли не назначены.</p>}
      {mine.map(({ a, index }) => (
        <div key={index} className="assignment">
          <div className="assignment-head">
            <select value={a.kind} title={HINTS[a.kind]} onChange={(e) => set(index, { kind: e.target.value as AssignmentKind })}>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {ASSIGNMENT_LABELS[k]}
                </option>
              ))}
            </select>
            <select value={a.role_id} aria-label="Должность" onChange={(e) => set(index, { role_id: e.target.value })}>
              {model.roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
            <button className="bpe-chip-x" title="Снять роль" onClick={() => onChange({ ...model, assignments: all.filter((_, i) => i !== index) })}>
              ×
            </button>
          </div>
          <CommitInput
            multiline
            rows={2}
            value={a.functions.join("\n")}
            placeholder="Функции роли — по одной в строке"
            onCommit={(v) => set(index, { functions: v.split("\n").map((s) => s.trim()).filter(Boolean) })}
          />
        </div>
      ))}
      {creating ? (
        <input
          autoFocus
          placeholder="Название должности и Enter"
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter" && e.currentTarget.value.trim()) {
              const created = addRole(model);
              add(created.id!, defaultKind, renameRole(created.model, created.id!, e.currentTarget.value.trim()));
              setCreating(false);
            }
            if (e.key === "Escape") setCreating(false);
          }}
          onBlur={() => setCreating(false)}
        />
      ) : (
        <select
          value=""
          aria-label="Назначить должность"
          onChange={(e) => {
            if (e.target.value === "__new__") setCreating(true);
            else if (e.target.value) add(e.target.value);
          }}
        >
          <option value="">＋ назначить должность…</option>
          {free.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
          <option value="__new__">✎ Новая должность…</option>
        </select>
      )}
    </div>
  );
}
