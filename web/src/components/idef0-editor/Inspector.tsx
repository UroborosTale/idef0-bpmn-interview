import { useState } from "react";
import type { ProcessLogicModel, ValidationIssue } from "../../types";
import { CommitInput, Field } from "../editor-core/fields";
import { deleteNode, updateNode } from "../bpmn-editor/model-ops";
import { descendantsOf, type Arrow, type ArrowKind } from "./geometry";
import { SLOT_ENTITY, attach, createEntity, detach, removeArrow, renameEntity, setFunctionRole, type EntityKind, type Slot } from "./ops";

type M = ProcessLogicModel;
export type Sel = { kind: "fn"; id: string } | { kind: "arrow"; id: string } | null;

interface Item {
  id: string;
  name: string;
}

/** Список сущностей одной стороны блока: чипы с «×», выбор существующей из справочника или создание новой. */
function IcomList({
  title,
  items,
  available,
  onAttach,
  onCreate,
  onDetach,
  onOpen,
}: {
  title: string;
  items: Item[];
  available: Item[];
  onAttach: (id: string) => void;
  onCreate: (name: string) => void;
  onDetach: (id: string) => void;
  onOpen?: (id: string) => void;
}) {
  const [creating, setCreating] = useState(false);
  return (
    <Field label={title}>
      <div className="bpe-chips" style={{ marginBottom: 4 }}>
        {items.length === 0 && <span className="muted">не указано</span>}
        {items.map((it) => (
          <span key={it.id} className="bpe-chip">
            <button className="bpe-chip-name" title="Выбрать стрелку" onClick={() => onOpen?.(it.id)}>
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

const ARROW_ENTITY: Record<ArrowKind, EntityKind> = {
  input: "data",
  link: "data",
  output: "data",
  control: "control",
  controlData: "data",
  controlLink: "data",
  role: "role",
  system: "system",
};
const ARROW_TITLE: Record<ArrowKind, string> = {
  input: "Вход (Input)",
  link: "Связь: выход → вход",
  output: "Выход (Output)",
  control: "Управление (Control)",
  controlData: "Управление — данные",
  controlLink: "Связь: выход → управление",
  role: "Механизм — исполнитель",
  system: "Механизм — система",
};
/** Какие стрелки соответствуют стороне блока (для перехода от чипа к стрелке). */
const SLOT_KINDS: Record<Slot, ArrowKind[]> = {
  inputs: ["input", "link"],
  outputs: ["output"],
  controls: ["control"],
  control_data_ids: ["controlData", "controlLink"],
  system_ids: ["system"],
};

interface Props {
  model: M;
  sel: Sel;
  arrows: Arrow[];
  codes: Map<string, string>;
  validation: ValidationIssue[];
  onChange: (next: M, nextSel?: Sel) => void;
  onSelect: (sel: Sel) => void;
  onOpen: (fnId: string) => void;
}

export default function Inspector({ model, sel, arrows, codes, validation, onChange, onSelect, onOpen }: Props) {
  const fn = sel?.kind === "fn" ? model.nodes.find((n) => n.id === sel.id) : undefined;
  const arrow = sel?.kind === "arrow" ? arrows.find((a) => a.key === sel.id) : undefined;

  if (fn) {
    const byId = <T extends Item>(xs: T[], ids: string[]) => ids.map((id) => xs.find((x) => x.id === id)).filter((x): x is T => !!x);
    const rest = <T extends Item>(xs: T[], ids: string[]) => xs.filter((x) => !ids.includes(x.id));
    const list = (title: string, slot: Slot, pool: Item[]) => {
      const ids = fn[slot] ?? [];
      return (
        <IcomList
          title={title}
          items={byId(pool, ids)}
          available={rest(pool, ids)}
          onAttach={(id) => onChange(attach(model, fn.id, slot, id))}
          onCreate={(name) => {
            const c = createEntity(model, SLOT_ENTITY[slot] as Exclude<EntityKind, "role">, name);
            onChange(attach(c.model, fn.id, slot, c.id!));
          }}
          onDetach={(id) => onChange(detach(model, fn.id, slot, id))}
          onOpen={(id) => {
            const a = arrows.find((x) =>
              slot === "outputs"
                ? x.entityId === id && ((x.kind === "output" && x.nodeId === fn.id) || ((x.kind === "link" || x.kind === "controlLink") && x.fromId === fn.id))
                : x.nodeId === fn.id && x.entityId === id && SLOT_KINDS[slot].includes(x.kind)
            );
            if (a) onSelect({ kind: "arrow", id: a.key });
          }}
        />
      );
    };
    const childCount = model.nodes.filter((n) => n.idef0_parent === fn.id).length;
    const subtree = descendantsOf(model, fn.id).length;
    return (
      <div>
        <h4>Функция {codes.get(fn.id) ?? ""}</h4>
        <Field label="Название">
          <CommitInput value={fn.name} onCommit={(v) => onChange(updateNode(model, fn.id, { name: v }))} />
        </Field>
        <button style={{ width: "100%", marginBottom: 10 }} onClick={() => onOpen(fn.id)}>
          {childCount > 0 ? `Открыть декомпозицию (${childCount} функц.)` : "Декомпозировать…"}
        </button>
        {list("Входы (Input) — слева", "inputs", model.data)}
        {list("Управление: регламенты — сверху", "controls", model.controls)}
        {list("Управление: данные (выход другой функции)", "control_data_ids", model.data)}
        {list("Выходы (Output) — справа", "outputs", model.data)}
        <h4 style={{ margin: "14px 0 8px" }}>Механизмы (Mechanism) — снизу</h4>
        <Field label="Исполнитель">
          <select value={fn.role_id ?? ""} onChange={(e) => onChange(setFunctionRole(model, fn.id, e.target.value || null))}>
            <option value="">Не назначен</option>
            {model.roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </Field>
        {list("Системы", "system_ids", model.systems)}
        <div className="bpe-actions">
          <button className="danger" onClick={() => onChange(deleteNode(model, fn.id), null)} title="Удаляет функцию и из BPMN">
            Удалить функцию{subtree > 0 ? ` и ${subtree} вложенных` : ""}
          </button>
        </div>
        <p className="muted" style={{ fontSize: 11.5 }}>
          Функция верхнего уровня — тот же элемент модели, что задача в BPMN: удаление и переименование действуют в обеих нотациях. Вложенные функции есть только в IDEF0.
        </p>
      </div>
    );
  }

  if (arrow) {
    const entity = ARROW_ENTITY[arrow.kind];
    const ownerCode = codes.get(arrow.nodeId) ?? "";
    const fromCode = arrow.fromId ? codes.get(arrow.fromId) ?? "" : "";
    const isLink = arrow.kind === "link" || arrow.kind === "controlLink";
    return (
      <div>
        <h4>{ARROW_TITLE[arrow.kind]}</h4>
        <p className="muted" style={{ margin: "0 0 10px" }}>
          {isLink ? `${fromCode} → ${ownerCode}` : `Функция ${ownerCode}`}
        </p>
        <Field label="Название стрелки">
          <CommitInput value={arrow.label} onCommit={(v) => v.trim() && onChange(renameEntity(model, entity, arrow.entityId, v.trim()))} />
        </Field>
        {isLink && (
          <p className="muted" style={{ fontSize: 12 }}>
            Выход функции {fromCode} является {arrow.kind === "link" ? "входом" : "управлением"} функции {ownerCode}. Переименование меняет подпись у обеих сторон.
          </p>
        )}
        {arrow.kind === "role" && (
          <p className="muted" style={{ fontSize: 12 }}>
            Исполнитель задаёт дорожку функции в BPMN: если убрать его, функция уйдёт в «Без исполнителя».
          </p>
        )}
        <div className="bpe-actions">
          <button className="danger" onClick={() => onChange(removeArrow(model, arrow), null)}>
            {isLink ? "Разорвать связь" : "Убрать стрелку"}
          </button>
        </div>
      </div>
    );
  }

  const issues = validation.filter((v) => v.notation === "IDEF0");
  return (
    <div>
      <h4>Редактор IDEF0</h4>
      <ul className="bpe-help">
        <li>Добавьте функцию из палитры или двойным щелчком по пустому месту.</li>
        <li>Выберите функцию — справа задайте входы, управление, выходы и механизмы.</li>
        <li>Потяните за ● у выбранной функции к другой: на верхнюю треть — «выход → управление», на остальное — «выход → вход».</li>
        <li>«Декомпозировать…» или значок ⊞ на блоке открывает диаграмму вложенных функций.</li>
        <li>Клик по стрелке — переименовать или убрать. Delete — удалить выбранное.</li>
      </ul>
      <h4 style={{ marginTop: 18 }}>Проверка IDEF0{issues.length > 0 && ` (${issues.length})`}</h4>
      <p className="muted" style={{ marginTop: 0 }}>
        Обновляется после сохранения.
      </p>
      <div className="bpe-issues">
        {issues.length === 0 && <p className="muted">Замечаний нет.</p>}
        {issues.map((v) => (
          <div
            key={v.id}
            className={`validation-item ${v.severity}`}
            style={{ cursor: v.element_id ? "pointer" : "default" }}
            onClick={() => v.element_id && model.nodes.some((n) => n.id === v.element_id) && onSelect({ kind: "fn", id: v.element_id })}
          >
            {v.message}
          </div>
        ))}
      </div>
    </div>
  );
}
