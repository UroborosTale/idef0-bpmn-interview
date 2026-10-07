import { useState } from "react";
import type { Fragment, ProcessLogicModel, ValidationIssue } from "../../types";
import { CommitInput, Field } from "../editor-core/fields";
import { SUBTYPES, TYPE_LABELS, deleteNode, setNodeType, updateNode } from "../bpmn-editor/model-ops";
import { descendantsOf } from "../idef0-editor/geometry";
import { SLOT_ENTITY, attach, createEntity, detach, setFunctionRole, type EntityKind, type Slot } from "../idef0-editor/ops";
import { HistoryList, Section, SourceList } from "./PanelParts";
import { reportDoc, type DictKind, type StudioDoc } from "./docs";
import type { Selection } from "./selection";

type M = ProcessLogicModel;
interface Item {
  id: string;
  name: string;
}

const SLOT_DICT: Record<Slot, DictKind> = { inputs: "data", outputs: "data", controls: "controls", control_data_ids: "data", system_ids: "systems" };

/** Список записей одной стороны блока: чипы с «×» (название открывает карточку), выбор из справочника или создание новой. */
function IcomList({ title, items, available, onAttach, onCreate, onDetach, onOpen }: { title: string; items: Item[]; available: Item[]; onAttach: (id: string) => void; onCreate: (name: string) => void; onDetach: (id: string) => void; onOpen: (id: string) => void }) {
  const [creating, setCreating] = useState(false);
  return (
    <Field label={title}>
      <div className="bpe-chips" style={{ marginBottom: 4 }}>
        {items.length === 0 && <span className="muted">не указано</span>}
        {items.map((it) => (
          <span key={it.id} className="bpe-chip">
            <button className="bpe-chip-name" title="Открыть карточку" onClick={() => onOpen(it.id)}>
              {it.name}
            </button>
            <button className="bpe-chip-x" title="Убрать" onClick={() => onDetach(it.id)}>
              ×
            </button>
          </span>
        ))}
      </div>
      {creating ? (
        <input
          autoFocus
          placeholder="Название и Enter"
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter" && e.currentTarget.value.trim()) {
              onCreate(e.currentTarget.value.trim());
              setCreating(false);
            }
            if (e.key === "Escape") setCreating(false);
          }}
          onBlur={() => setCreating(false)}
        />
      ) : (
        <select
          value=""
          onChange={(e) => {
            if (e.target.value === "__new__") setCreating(true);
            else if (e.target.value) onAttach(e.target.value);
          }}
        >
          <option value="">＋ добавить…</option>
          {available.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
          <option value="__new__">✎ Новый…</option>
        </select>
      )}
    </Field>
  );
}

/**
 * Свойства шага или функции: общие атрибуты, исполнение (исполнитель, системы, сроки и стоимость),
 * стороны блока IDEF0, RACI, источник в интервью, замечания проверки, история. BPMN-задача и функция
 * IDEF0 — один элемент модели, поэтому свойства у них общие.
 */
export default function NodeProperties({
  model,
  id,
  codes,
  issues,
  sessionId,
  fragments,
  stamp,
  onChange,
  onSelect,
  onReveal,
  onOpenDecomposition,
  onOpenDoc,
}: {
  model: M;
  id: string;
  codes: Map<string, string>;
  issues: ValidationIssue[];
  sessionId: string;
  fragments: Fragment[];
  stamp: string;
  onChange: (next: M) => void;
  onSelect: (sel: Selection) => void;
  onReveal: (id: string, where: "bpmn" | "idef0") => void;
  onOpenDecomposition: (id: string) => void;
  onOpenDoc: (doc: StudioDoc) => void;
}) {
  const node = model.nodes.find((n) => n.id === id);
  if (!node) return <p className="muted prop-note">Элемент удалён.</p>;

  const isFn = node.type === "task" || node.type === "subprocess";
  const timing = isFn;
  const subtypes = SUBTYPES[node.type] ?? [];
  const set = (patch: Partial<typeof node>) => onChange(updateNode(model, node.id, patch));
  const text = (key: "duration" | "time_processing" | "time_waiting" | "cost_estimate" | "frequency", label: string, placeholder?: string) => (
    <Field label={label}>
      <CommitInput value={node[key] ?? ""} placeholder={placeholder} onCommit={(v) => set({ [key]: v.trim() || null })} />
    </Field>
  );

  const byId = <T extends Item>(xs: T[], ids: string[]) => ids.map((i) => xs.find((x) => x.id === i)).filter((x): x is T => !!x);
  const rest = <T extends Item>(xs: T[], ids: string[]) => xs.filter((x) => !ids.includes(x.id));
  const list = (title: string, slot: Slot, pool: Item[]) => {
    const ids = node[slot] ?? [];
    return (
      <IcomList
        title={title}
        items={byId(pool, ids)}
        available={rest(pool, ids)}
        onAttach={(i) => onChange(attach(model, node.id, slot, i))}
        onCreate={(name) => {
          const c = createEntity(model, SLOT_ENTITY[slot] as Exclude<EntityKind, "role">, name);
          onChange(attach(c.model, node.id, slot, c.id!));
        }}
        onDetach={(i) => onChange(detach(model, node.id, slot, i))}
        onOpen={(i) => onSelect({ kind: "entry", dict: SLOT_DICT[slot], id: i })}
      />
    );
  };

  const childCount = model.nodes.filter((n) => n.idef0_parent === node.id).length;
  const subtree = descendantsOf(model, node.id).length;
  const raci = model.raci.filter((r) => r.node_id === node.id);
  const mine = issues.filter((i) => i.element_id === node.id);
  const home = node.idef0_parent ? codes.get(node.idef0_parent) ?? "A?" : "A0";

  return (
    <div>
      <div className="prop-kind">
        {TYPE_LABELS[node.type]}
        {codes.get(node.id) && <span className="nav-code"> {codes.get(node.id)}</span>}
        {node.status === "hypothesis" && <span className="prop-badge">гипотеза · {Math.round(node.confidence * 100)}%</span>}
      </div>

      <Section title="Общие">
        <Field label="Название">
          <CommitInput required value={node.name} onCommit={(v) => set({ name: v.trim() })} />
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
            <select value={node.subtype ?? ""} onChange={(e) => set({ subtype: e.target.value || undefined })}>
              {subtypes.map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Исполнитель (дорожка BPMN, механизм IDEF0)">
          <select value={node.role_id ?? ""} onChange={(e) => onChange(setFunctionRole(model, node.id, e.target.value || null))}>
            <option value="">{isFn ? "Не назначен" : "Без исполнителя"}</option>
            {model.roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </Field>
        {node.role_id && (
          <button className="link-button prop-link" onClick={() => onSelect({ kind: "entry", dict: "roles", id: node.role_id! })}>
            Карточка исполнителя →
          </button>
        )}
        <Field label="Заметка">
          <CommitInput multiline value={node.note ?? ""} onCommit={(v) => set({ note: v.trim() || undefined })} />
        </Field>
        {node.status === "hypothesis" && <button onClick={() => set({ status: "confirmed", confidence: 1 })}>Подтвердить (убрать «гипотезу»)</button>}
      </Section>

      {timing && (
        <Section title="Сроки и стоимость">
          {text("duration", "Длительность", "например, 2 дня")}
          {text("time_processing", "Время обработки")}
          {text("time_waiting", "Время ожидания")}
          {text("cost_estimate", "Стоимость")}
          {text("frequency", "Частота", "например, 20 раз в месяц")}
        </Section>
      )}

      {isFn && (
        <Section title="Стороны блока IDEF0">
          {list("Входы (Input) — слева", "inputs", model.data)}
          {list("Управление: регламенты — сверху", "controls", model.controls)}
          {list("Управление: данные (выход другой функции)", "control_data_ids", model.data)}
          {list("Выходы (Output) — справа", "outputs", model.data)}
          {list("Механизмы: информационные системы — снизу", "system_ids", model.systems)}
        </Section>
      )}

      {isFn && (
        <Section title="RACI" count={raci.length} open={raci.length > 0}>
          {raci.length === 0 ? (
            <p className="muted prop-note">Ответственные не назначены.</p>
          ) : (
            <ul className="prop-list">
              {raci.map((r, i) => (
                <li key={i}>
                  <b>{r.type}</b> — {model.roles.find((x) => x.id === r.role_id)?.name ?? r.role_id}
                </li>
              ))}
            </ul>
          )}
          <button onClick={() => onOpenDoc(reportDoc("raci"))}>Открыть матрицу RACI</button>
        </Section>
      )}

      <Section title="Диаграммы">
        <div className="bpe-actions" style={{ marginTop: 0 }}>
          {!node.idef0_parent && <button onClick={() => onReveal(node.id, "bpmn")}>Показать в BPMN</button>}
          {isFn && <button onClick={() => onReveal(node.id, "idef0")}>Показать в IDEF0 ({home})</button>}
          {isFn && <button onClick={() => onOpenDecomposition(node.id)}>{childCount > 0 ? `Декомпозиция (${childCount} функц.)` : "Декомпозировать…"}</button>}
        </div>
      </Section>

      <Section title="Источник в интервью" count={node.source.length} open={node.source.length > 0}>
        <SourceList source={node.source} fragments={fragments} />
      </Section>

      {mine.length > 0 && (
        <Section title="Замечания проверки" count={mine.length}>
          {mine.map((v) => (
            <div key={v.id} className={`validation-item ${v.severity}`}>
              <b>[{v.notation}]</b> {v.message}
            </div>
          ))}
        </Section>
      )}

      <HistoryList sessionId={sessionId} kind="node" id={node.id} stamp={stamp} />

      <div className="bpe-actions">
        <button className="danger" onClick={() => onChange(deleteNode(model, node.id))} title={isFn ? "Удаляет элемент и из BPMN, и из IDEF0" : undefined}>
          Удалить{isFn ? " функцию" : " элемент"}
          {subtree > 0 ? ` и ${subtree} вложенных` : ""}
        </button>
      </div>
    </div>
  );
}
