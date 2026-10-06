import type { ProcessLogicModel, ValidationIssue } from "../../types";
import { CommitInput, Field } from "../editor-core/fields";
import {
  SUBTYPES,
  TYPE_LABELS,
  deleteFlow,
  deleteNode,
  deleteRole,
  renameRole,
  setNodeRole,
  setNodeType,
  updateFlow,
  updateNode,
} from "./model-ops";

type M = ProcessLogicModel;
export type Sel = { kind: "node" | "flow" | "lane"; id: string } | null;

interface Props {
  model: M;
  sel: Sel;
  validation: ValidationIssue[];
  onChange: (next: M, nextSel?: Sel) => void;
  onSelect: (sel: Sel) => void;
  onHint: (text: string) => void;
}

export default function Inspector({ model, sel, validation, onChange, onSelect, onHint }: Props) {
  const node = sel?.kind === "node" ? model.nodes.find((n) => n.id === sel.id) : undefined;
  const flow = sel?.kind === "flow" ? model.flows.find((f) => f.id === sel.id) : undefined;
  const role = sel?.kind === "lane" ? model.roles.find((r) => r.id === sel.id) : undefined;
  const nodeName = (id: string) => model.nodes.find((n) => n.id === id)?.name || id;

  if (node) {
    const subtypes = SUBTYPES[node.type] ?? [];
    return (
      <div>
        <h4>{TYPE_LABELS[node.type]}</h4>
        <Field label="Название">
          <CommitInput value={node.name} onCommit={(v) => onChange(updateNode(model, node.id, { name: v }))} />
        </Field>
        <Field label="Тип">
          <select value={node.type} onChange={(e) => onChange(setNodeType(model, node.id, e.target.value as typeof node.type))}>
            {Object.entries(TYPE_LABELS).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        {subtypes.length > 0 && (
          <Field label="Вид">
            <select value={node.subtype ?? ""} onChange={(e) => onChange(updateNode(model, node.id, { subtype: e.target.value || undefined }))}>
              {subtypes.map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Исполнитель (дорожка)">
          <select value={node.role_id ?? ""} onChange={(e) => onChange(setNodeRole(model, node.id, e.target.value || null))}>
            <option value="">Без исполнителя</option>
            {model.roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </Field>
        {node.type !== "event" && node.type !== "gateway" && (
          <>
            <Field label="Длительность">
              <CommitInput value={node.duration ?? ""} placeholder="например, 2 дня" onCommit={(v) => onChange(updateNode(model, node.id, { duration: v || null }))} />
            </Field>
            <Field label="Системы">
              <div className="bpe-chips">
                {model.systems.length === 0 && <span className="muted">нет в справочнике</span>}
                {model.systems.map((s) => {
                  const on = node.system_ids.includes(s.id);
                  return (
                    <button
                      key={s.id}
                      className={on ? "primary" : ""}
                      onClick={() => onChange(updateNode(model, node.id, { system_ids: on ? node.system_ids.filter((x) => x !== s.id) : [...node.system_ids, s.id] }))}
                    >
                      {s.name}
                    </button>
                  );
                })}
              </div>
            </Field>
          </>
        )}
        <Field label="Заметка">
          <CommitInput multiline value={node.note ?? ""} onCommit={(v) => onChange(updateNode(model, node.id, { note: v || undefined }))} />
        </Field>
        {node.status === "hypothesis" && (
          <button onClick={() => onChange(updateNode(model, node.id, { status: "confirmed", confidence: 1 }))}>Подтвердить (убрать «гипотезу»)</button>
        )}
        <div className="bpe-actions">
          <button className="danger" onClick={() => onChange(deleteNode(model, node.id), null)}>
            Удалить элемент
            {model.nodes.some((n) => n.idef0_parent === node.id) ? " и вложенные функции IDEF0" : ""}
          </button>
        </div>
      </div>
    );
  }

  if (flow) {
    const fromNode = model.nodes.find((n) => n.id === flow.from);
    return (
      <div>
        <h4>Стрелка</h4>
        <p className="muted" style={{ margin: "0 0 10px" }}>
          {nodeName(flow.from)} → {nodeName(flow.to)}
        </p>
        <Field label={fromNode?.type === "gateway" ? "Условие ветки" : "Условие (необязательно)"}>
          <CommitInput value={flow.condition ?? ""} placeholder="например, если сумма > 100 000" onCommit={(v) => onChange(updateFlow(model, flow.id, { condition: v || null }))} />
        </Field>
        <div className="bpe-actions">
          <button onClick={() => onChange(updateFlow(model, flow.id, { from: flow.to, to: flow.from }))}>Развернуть</button>
          <button className="danger" onClick={() => onChange(deleteFlow(model, flow.id), null)}>
            Удалить стрелку
          </button>
        </div>
      </div>
    );
  }

  if (role) {
    const count = model.nodes.filter((n) => n.role_id === role.id).length;
    return (
      <div>
        <h4>Дорожка</h4>
        <Field label="Название роли">
          <CommitInput value={role.name} onCommit={(v) => onChange(renameRole(model, role.id, v.trim() || role.name))} />
        </Field>
        <p className="muted">Элементов в дорожке: {count}</p>
        <div className="bpe-actions">
          <button
            className="danger"
            onClick={() => {
              const r = deleteRole(model, role.id);
              if (r.error) onHint(r.error);
              else onChange(r.model, null);
            }}
          >
            Удалить дорожку
          </button>
        </div>
      </div>
    );
  }

  // ничего не выбрано — подсказки и результат последней валидации
  const errors = validation.filter((v) => v.severity === "error");
  return (
    <div>
      <h4>Редактор BPMN</h4>
      <ul className="bpe-help">
        <li>Перетащите фигуру из палитры на дорожку.</li>
        <li>Выберите фигуру и потяните за ● справа — получится стрелка.</li>
        <li>Двойной щелчок — переименовать. Delete — удалить.</li>
        <li>Перенос фигуры в другую дорожку меняет исполнителя.</li>
        <li>Колесо мыши — масштаб, перетаскивание фона — сдвиг.</li>
      </ul>
      <h4 style={{ marginTop: 18 }}>
        Проверка модели{validation.length > 0 && ` (${errors.length} ошибок, ${validation.length - errors.length} предупр.)`}
      </h4>
      <p className="muted" style={{ marginTop: 0 }}>
        Обновляется после сохранения.
      </p>
      <div className="bpe-issues">
        {validation.length === 0 && <p className="muted">Замечаний нет.</p>}
        {[...errors, ...validation.filter((v) => v.severity !== "error")].slice(0, 30).map((v) => (
          <div
            key={v.id}
            className={`validation-item ${v.severity}`}
            style={{ cursor: v.element_id ? "pointer" : "default" }}
            onClick={() => v.element_id && model.nodes.some((n) => n.id === v.element_id) && onSelect({ kind: "node", id: v.element_id })}
          >
            <b>[{v.notation}]</b> {v.message}
          </div>
        ))}
      </div>
    </div>
  );
}
