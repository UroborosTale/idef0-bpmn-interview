import type { Fragment, ProcessLogicModel, SourceRef } from "../../types";
import { CommitInput, Field } from "../editor-core/fields";
import { HistoryList, Section, SourceList } from "./PanelParts";
import { idef0Codes } from "../idef0-editor/geometry";
import { DICT_TITLES, type DictKind } from "./docs";
import { ENTRY_TITLES, KIND_OPTIONS, LEVEL_OPTIONS, entryOf, removeEntry, updateEntry, usageOf } from "./dict-ops";

type M = ProcessLogicModel;
type Rec = { id: string; name: string; source?: SourceRef[] };

const HISTORY_KIND: Record<DictKind, string> = { roles: "roles", systems: "systems", data: "data", controls: "controls", kpi: "kpi", risks: "risks" };

/**
 * Карточка записи справочника (как карточка объекта в Business Studio): название, вид, атрибуты,
 * описание и ответственный, «где используется» с переходом к шагу, источник в интервью и история
 * изменений по сохранённым версиям. Правки идут в общую модель студии (можно отменить, нужно сохранить).
 */
export default function EntryCard({
  model,
  dict,
  id,
  sessionId,
  fragments,
  stamp,
  onChange,
  onGoto,
}: {
  model: M;
  dict: DictKind;
  id: string;
  sessionId: string;
  fragments: Fragment[];
  /** Версия модели на сервере — история перечитывается после каждого сохранения. */
  stamp: string;
  onChange: (next: M) => void;
  onGoto: (nodeId: string) => void;
}) {
  const rec = entryOf(model, dict, id) as Rec | undefined;
  if (!rec) return <p className="muted prop-note">Запись удалена.</p>;
  const f = rec as unknown as Record<string, string | null | undefined>; // необязательные поля карточки у разных справочников разные

  const set = (patch: Record<string, unknown>) => onChange(updateEntry(model, dict, id, patch));
  const text = (key: string, label: string, placeholder?: string) => (
    <Field label={label}>
      <CommitInput value={f[key] ?? ""} placeholder={placeholder} onCommit={(v) => set({ [key]: v.trim() || null })} />
    </Field>
  );
  const options = KIND_OPTIONS[dict];
  const withUsage = dict !== "kpi" && dict !== "risks";
  const usage = withUsage ? usageOf(model, dict, id) : [];
  // продукт: кто его выпускает и кто использует (по связям функций модели)
  const codes = idef0Codes(model);
  const fnNodes = model.nodes.filter((n) => (n.type === "task" || n.type === "subprocess") && !n.bpmn_scope);
  const producers = dict === "data" ? fnNodes.filter((n) => n.outputs.includes(id)) : [];
  const consumers = dict === "data" ? fnNodes.filter((n) => n.inputs.includes(id) || (n.control_data_ids ?? []).includes(id)) : [];
  const fnChips = (list: typeof fnNodes) => (
    <div className="bpe-chips">
      {list.map((n) => (
        <button key={n.id} className="usage-chip" onClick={() => onGoto(n.id)} title="Перейти к функции">
          <span className="nav-code">{codes.get(n.id)}</span> {n.name}
        </button>
      ))}
    </div>
  );
  const raci = dict === "roles" ? model.raci.filter((r) => r.role_id === id).length : 0;
  const iface = dict === "data" ? model.interfaces.filter((i) => i.data_id === id) : [];

  const remove = () => {
    const warn = usage.length > 0 ? `«${rec.name}» используется в ${usage.length} элем. — ссылки на неё будут убраны (шаги останутся). Удалить?` : `Удалить «${rec.name}»?`;
    if (window.confirm(warn)) onChange(removeEntry(model, dict, id));
  };

  return (
    <div className="entry-card">
      <div className="prop-kind">
        {ENTRY_TITLES[dict]} · <span className="muted">{DICT_TITLES[dict]}</span>
      </div>

      <Section title="Общие">
        <Field label="Название">
          <CommitInput required value={rec.name} onCommit={(v) => set({ name: v.trim() })} />
        </Field>
        {options && (
          <Field label="Вид">
            <select value={f.kind ?? ""} onChange={(e) => set({ kind: e.target.value })}>
              {options.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </Field>
        )}
        {dict === "controls" && text("reference", "Реквизиты", "номер, дата, пункт")}
        {dict === "kpi" && (
          <>
            {text("target", "Целевое значение")}
            {text("unit", "Единица измерения")}
            {text("period", "Периодичность измерения", "например, ежемесячно")}
          </>
        )}
        {dict === "risks" && (
          <>
            <Field label="Уровень риска">
              <select value={f.level ?? ""} onChange={(e) => set({ level: e.target.value || null })}>
                <option value="">не оценён</option>
                {LEVEL_OPTIONS.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Мера снижения">
              <CommitInput multiline rows={2} value={f.mitigation ?? ""} onCommit={(v) => set({ mitigation: v.trim() || null })} />
            </Field>
          </>
        )}
        {dict === "roles" && text("qualification", "Требуемая квалификация и специализация", "например, опыт моделирования от года")}
        {text("owner", dict === "roles" ? "Подразделение" : "Ответственный")}
        <Field label="Описание">
          <CommitInput multiline value={f.description ?? ""} placeholder="Назначение, особенности, ограничения" onCommit={(v) => set({ description: v.trim() || null })} />
        </Field>
      </Section>

      {dict === "data" && (
        <Section title="Карточка продукта">
          <Field label="Источник — кто выпускает">
            {producers.length > 0 ? fnChips(producers) : <span className="muted">{f.supplier ? "внешний поставщик (ниже)" : "не указан: вход процесса без поставщика"}</span>}
          </Field>
          {text("supplier", "Внешний поставщик", "например, Протокол совещания")}
          <Field label="Назначение — кто использует">
            {consumers.length > 0 ? fnChips(consumers) : <span className="muted">{f.consumer ? "внешний потребитель (ниже)" : "не указано: выход процесса без потребителя"}</span>}
          </Field>
          {text("consumer", "Внешний потребитель", "например, Конечный продукт")}
          <Field label="Ценность для потребителя">
            <CommitInput multiline rows={3} value={f.value ?? ""} onCommit={(v) => set({ value: v.trim() || null })} />
          </Field>
          <Field label="Стандарт качества">
            <CommitInput multiline rows={3} value={f.quality_standard ?? ""} onCommit={(v) => set({ quality_standard: v.trim() || null })} />
          </Field>
        </Section>
      )}

      {withUsage ? (
        <Section title="Где используется" count={usage.length}>
          {usage.length === 0 ? (
            <p className="prop-note prop-warn">Запись нигде не используется — её можно привязать к функции или удалить.</p>
          ) : (
            <div className="bpe-chips">
              {usage.map((u, k) => (
                <button key={k} className="usage-chip" onClick={() => onGoto(u.nodeId)} title="Перейти к элементу на диаграмме">
                  {u.nodeName} <span className="muted">· {u.how}</span>
                </button>
              ))}
            </div>
          )}
          {raci > 0 && <p className="muted prop-note">В матрице RACI: {raci} отмет.</p>}
          {iface.length > 0 && <p className="muted prop-note">Интерфейсы процесса: {iface.map((i) => (i.direction === "in" ? "вход" : "выход")).join(", ")}.</p>}
        </Section>
      ) : (
        <p className="muted prop-note">{dict === "kpi" ? "Показатель относится ко всему процессу." : "Риск относится ко всему процессу."}</p>
      )}

      <Section title="Источник в интервью" count={rec.source?.length ?? 0} open={(rec.source?.length ?? 0) > 0}>
        <SourceList source={rec.source ?? []} fragments={fragments} />
      </Section>

      <HistoryList sessionId={sessionId} kind={HISTORY_KIND[dict]} id={id} stamp={stamp} />

      <div className="bpe-actions">
        <button className="danger" onClick={remove}>
          Удалить запись
        </button>
      </div>
    </div>
  );
}
