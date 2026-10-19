import { LC_STATUS_LABELS, lcStatus, lcVersion, nextVersion } from "./lifecycle";
import { useState } from "react";
import type { Fragment, ProcessLogicModel, ValidationIssue } from "../../types";
import { CommitInput, Field } from "../editor-core/fields";
import { BLOCK_TRIGGERS, BOUNDARY_MAIN, BOUNDARY_TRIGGERS, SUBTYPES, TYPE_LABELS, addBoundaryEvent, attachTrigger, deleteNode, deleteTriggerEvent, setNodeType, updateNode } from "../bpmn-editor/model-ops";
import { triggerView } from "../bpmn-editor/geometry";
import { scopeView } from "@shared/scope";
import { triggerSummary } from "@shared/events";
import { LOOP_KINDS, LOOP_LABELS, type LoopKind } from "@shared/loops";
import { descendantsOf } from "../idef0-editor/geometry";
import { SLOT_ENTITY, attach, createEntity, detach, setFunctionRole, type EntityKind, type Slot } from "../idef0-editor/ops";
import { bpmnHosts, functionDepth, processCodeOf, stepCodes } from "@shared/codes";
import { TRIGGER_LABELS, type TriggerType } from "@shared/events";
import AssignmentsEditor from "./AssignmentsEditor";
import EventProperties from "./EventProperties";
import MessagesEditor from "./MessagesEditor";
import { HistoryList, Section, SourceList } from "./PanelParts";
import { USAGE_LABELS, functionUsage, type FnUsage } from "./usage-ops";
import { styleKindOf, type StyleKind } from "@shared/shapeStyles";
import StyleEditor from "./StyleEditor";
import { bpmnDoc, reportDoc, type DictKind, type StudioDoc } from "./docs";
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
  activeKind,
}: {
  /** Вид открытой диаграммы: на диаграмме IDEF0 оформляется блок функции, на BPMN — фигура шага. */
  activeKind?: StudioDoc["kind"];
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

  // шаг диаграммы BPMN операции (подоперация) — не функция IDEF0: у него нет сторон блока, RACI и декомпозиции
  const isStep = !!node.bpmn_scope;
  const isFn = (node.type === "task" || node.type === "subprocess") && !isStep;
  const timing = node.type === "task" || node.type === "subprocess";
  const subtypes = node.type === "event" ? [] : SUBTYPES[node.type] ?? []; // у событий вид и триггер — в блоке «Событие и триггер»
  const set = (patch: Partial<typeof node>) => onChange(updateNode(model, node.id, patch));
  const text = (key: "duration" | "time_processing" | "time_waiting" | "cost_estimate" | "frequency" | "content" | "begin" | "result" | "deadline", label: string, placeholder?: string, multiline = false) => (
    <Field label={label}>
      <CommitInput multiline={multiline} value={node[key] ?? ""} placeholder={placeholder} onCommit={(v) => set({ [key]: v.trim() || null })} />
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
  const home = node.idef0_parent ? codes.get(node.idef0_parent) ?? "A?" : processCodeOf(model);
  const code = codes.get(node.id) ?? stepCodes(model).get(node.id);
  const host = isStep ? model.nodes.find((n) => n.id === node.bpmn_scope) : undefined;
  const hasDiagram = isFn && bpmnHosts(model).some((h) => h.id === node.id);
  const depth = functionDepth(model, node.id);
  const usage = functionUsage(model, node.id);
  const styleKind: StyleKind | null = activeKind === "idef0" && isFn ? "idef0_block" : styleKindOf(node, !!node.attached_to);
  const openUsage = (u: FnUsage) => {
    if (u.kind === "decomposition") onOpenDecomposition(node.id);
    else if (u.kind === "operation") onOpenDoc(u.doc);
    else onReveal(node.id, u.kind === "block" ? "idef0" : "bpmn");
  };

  // элементы, которые есть на диаграмме BPMN: шаги операций и функции общей схемы процесса
  const onDiagram = isStep || !node.idef0_parent;
  const sameScope = (n: typeof node) => (n.bpmn_scope ?? null) === (node.bpmn_scope ?? null) && (isStep || !n.idef0_parent);
  const isHostable = (n: typeof node) => (n.type === "task" || n.type === "subprocess") && n.id !== node.id && sameScope(n);
  const hosts = model.nodes.filter(isHostable);
  const attachedHost = node.attached_to ? model.nodes.find((n) => n.id === node.attached_to) : undefined;
  const boundaries = model.nodes.filter((n) => n.type === "event" && n.attached_to === node.id);
  const addBoundary = (trigger: TriggerType) => {
    const r = addBoundaryEvent(model, node.id, trigger);
    if (!r.error) {
      onChange(r.model);
      onSelect({ kind: "node", id: r.id! });
    }
  };
  // триггеры блока: ожидающие события, свёрнутые в значки на блоке; событие-значок удаляется так, чтобы вход блока сохранился
  const tview = triggerView(scopeView(model, node.bpmn_scope ?? null));
  const blockTriggers = tview.markers.get(node.id) ?? [];
  const isMarker = tview.hidden.has(node.id);
  const addBlockTrigger = (trigger: TriggerType) => {
    const r = attachTrigger(model, node.id, trigger);
    if (!r.error) {
      onChange(r.model);
      onSelect({ kind: "node", id: r.id! });
    }
  };
  const messageCount = (model.messages ?? []).filter((m) => m.from === node.id || m.to === node.id).length;

  return (
    <div>
      <div className="prop-kind">
        {TYPE_LABELS[node.type]}
        {code && <span className="nav-code"> {code}</span>}
        {isStep && host && (
          <>
            {" "}
            <span className="muted">· шаг операции</span>{" "}
            <button className="link-button" onClick={() => onSelect({ kind: "node", id: host.id })}>
              {codes.get(host.id)} {host.name}
            </button>
          </>
        )}
        {node.status === "hypothesis" && <span className="prop-badge">гипотеза · {Math.round(node.confidence * 100)}%</span>}
      </div>

      <Section title="Общие">
        <Field label="Название">
          <CommitInput required value={node.name} onCommit={(v) => set({ name: v.trim() })} />
        </Field>
        {(node.type === "task" || node.type === "subprocess") && (
          <>
            {/* поля карточки деятельности Business Studio */}
            {text("content", "Содержание деятельности", "что делается на этом шаге", true)}
            {text("begin", "Начало", "что запускает деятельность")}
            {text("result", "Результат", "чем заканчивается")}
            {text("deadline", "Требования к срокам", "например, не позднее 3 рабочих дней")}
          </>
        )}
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
        {(node.type === "task" || node.type === "subprocess") && (
          <Field label="Цикличность (BPMN)">
            <select value={node.loop ?? ""} onChange={(e) => set({ loop: (e.target.value || undefined) as LoopKind | undefined })}>
              <option value="">Нет, выполняется один раз</option>
              {LOOP_KINDS.map((k) => (
                <option key={k} value={k}>
                  {LOOP_LABELS[k]}
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
        <Field label="Метка фигуры">
          <CommitInput value={node.shapeLabel ?? ""} onCommit={(v) => set({ shapeLabel: v.trim() || undefined })} />
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

      {node.type === "event" && <EventProperties model={model} node={node} boundary={!!attachedHost} onChange={onChange} />}

      {node.type === "event" && (
        <Section title="Граничное событие" open={!!attachedHost}>
          <Field label="Прикреплено к задаче">
            <select
              value={attachedHost?.id ?? ""}
              onChange={(e) => {
                const host = hosts.find((h) => h.id === e.target.value);
                onChange(updateNode(model, node.id, { attached_to: host?.id ?? null, ...(host ? { role_id: host.role_id ?? null } : {}) }));
              }}
            >
              <option value="">Не прикреплено (обычное событие)</option>
              {hosts.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                </option>
              ))}
            </select>
          </Field>
          {attachedHost && (
            <label className="prop-check">
              <input type="checkbox" checked={node.interrupting !== false} onChange={(e) => set({ interrupting: e.target.checked })} /> Прерывает задачу (сплошная рамка)
            </label>
          )}
          <p className="muted prop-note">Граничное событие стоит на нижней границе задачи и начинает отдельную ветку: таймер «срок вышел», сообщение, ошибка. Стрелку из него ведут к шагу, который выполняется при наступлении события.</p>
        </Section>
      )}

      {(node.type === "task" || node.type === "subprocess") && onDiagram && (
        <Section title="Триггеры блока" count={blockTriggers.length} open={blockTriggers.length > 0}>
          {blockTriggers.length === 0 && <p className="muted prop-note">Блок ничего не ждёт: его запускает стрелка. Добавьте триггер, если блок запускает сообщение, срок, условие или сигнал.</p>}
          {blockTriggers.length > 0 && (
            <div className="bpe-chips" style={{ marginBottom: 4 }}>
              {blockTriggers.map((mk) => (
                <span key={mk.eventId} className="bpe-chip">
                  <button className="bpe-chip-name" title="Открыть свойства триггера" onClick={() => onSelect({ kind: "node", id: mk.eventId })}>
                    {triggerSummary(mk.spec)}
                  </button>
                  <button className="bpe-chip-x" title="Убрать триггер" onClick={() => onChange(deleteTriggerEvent(model, mk.eventId))}>
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="bpe-actions" style={{ marginTop: 0 }}>
            {BLOCK_TRIGGERS.map((k) => (
              <button key={k} onClick={() => addBlockTrigger(k)}>
                + {TRIGGER_LABELS[k]}
              </button>
            ))}
          </div>
          <p className="muted prop-note">Триггер — значок на блоке, отдельной фигуры и стрелки к блоку нет. В файле BPMN он остаётся событием перед блоком.</p>
        </Section>
      )}

      {(node.type === "task" || node.type === "subprocess") && onDiagram && (
        <Section title="Граничные события" count={boundaries.length} open={boundaries.length > 0}>
          {boundaries.length === 0 && <p className="muted prop-note">На границе задачи событий нет.</p>}
          {boundaries.length > 0 && (
            <div className="bpe-chips" style={{ marginBottom: 4 }}>
              {boundaries.map((b) => (
                <span key={b.id} className="bpe-chip">
                  <button className="bpe-chip-name" title="Открыть свойства события" onClick={() => onSelect({ kind: "node", id: b.id })}>
                    {b.name}
                  </button>
                  <button className="bpe-chip-x" title="Удалить событие" onClick={() => onChange(deleteNode(model, b.id))}>
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="bpe-actions" style={{ marginTop: 0 }}>
            {BOUNDARY_MAIN.map((k) => (
              <button key={k} onClick={() => addBoundary(k)}>
                + {TRIGGER_LABELS[k]}
              </button>
            ))}
            <select value="" aria-label="Другой триггер" onChange={(e) => e.target.value && addBoundary(e.target.value as TriggerType)}>
              <option value="">Другой триггер…</option>
              {BOUNDARY_TRIGGERS.filter((t) => !BOUNDARY_MAIN.includes(t)).map((t) => (
                <option key={t} value={t}>
                  {TRIGGER_LABELS[t]}
                </option>
              ))}
            </select>
          </div>
        </Section>
      )}

      {node.type !== "gateway" && onDiagram && (
        <Section title="Потоки сообщений" count={messageCount} open={messageCount > 0}>
          <MessagesEditor model={model} nodeId={node.id} onChange={onChange} />
        </Section>
      )}

      {isFn && (
        <Section title="Ролевая модель" count={(model.assignments ?? []).filter((a) => a.node_id === node.id).length} open>
          <AssignmentsEditor model={model} nodeId={node.id} defaultKind={depth <= 1 ? "owner" : "executor"} onChange={onChange} />
          <p className="muted prop-note">Исполнитель по умолчанию (поле «Исполнитель» выше) — дорожка BPMN; назначенные роли — механизмы IDEF0.</p>
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
        {usage.length > 0 && (
          <div className="prop-note">
            <div className="muted">{isStep ? "Изображён на диаграмме:" : "Изображена на диаграммах:"}</div>
            <ul className="usage-list">
              {usage.map((u) => (
                <li key={`${u.kind}:${u.doc.key}`}>
                  <button className="link-button" onClick={() => openUsage(u)}>
                    {u.title}
                  </button>{" "}
                  <span className="muted">— {USAGE_LABELS[u.kind]}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="bpe-actions" style={{ marginTop: 0 }}>
          {!node.idef0_parent && <button onClick={() => onReveal(node.id, "bpmn")}>Показать в BPMN</button>}
          {hasDiagram && <button onClick={() => onOpenDoc(bpmnDoc(node.id))}>Диаграмма BPMN операции</button>}
          {isFn && <button onClick={() => onReveal(node.id, "idef0")}>Показать в IDEF0 ({home})</button>}
          {isFn && <button onClick={() => onOpenDecomposition(node.id)}>{childCount > 0 ? `Декомпозиция (${childCount} функц.)` : "Декомпозировать…"}</button>}
        </div>
      </Section>

      {styleKind && <StyleEditor model={model} kind={styleKind} onChange={onChange} />}

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

      <Section title="Жизненный цикл">
        <Field label="Статус">
          <select value={lcStatus(node)} onChange={(e) => set({ lc_status: e.target.value as keyof typeof LC_STATUS_LABELS })}>
            {Object.entries(LC_STATUS_LABELS).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Версия объекта">
          <div className="prop-row">
            <span data-lc-version>{lcVersion(node)}</span>
            <button title="Сменить версию объекта (Ctrl+Shift+V): следующая версия, статус — «в работе»" onClick={() => set({ lc_version: nextVersion(lcVersion(node)), lc_status: "in_work" })}>
              Сменить версию
            </button>
          </div>
        </Field>
        <p className="muted prop-note">Когда и кем менялся объект — в «Истории» ниже (по сохранённым версиям модели).</p>
      </Section>
      <HistoryList sessionId={sessionId} kind="node" id={node.id} stamp={stamp} />

      <div className="bpe-actions">
        <button className="danger" onClick={() => onChange(isMarker ? deleteTriggerEvent(model, node.id) : deleteNode(model, node.id))} title={isFn ? "Удаляет элемент и из BPMN, и из IDEF0" : undefined}>
          Удалить{isFn ? " функцию" : " элемент"}
          {subtree > 0 ? ` и ${subtree} вложенных` : ""}
        </button>
      </div>
    </div>
  );
}
