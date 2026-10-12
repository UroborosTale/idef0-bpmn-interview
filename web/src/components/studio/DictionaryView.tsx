import { useRef, useState } from "react";
import type { ProcessLogicModel } from "../../types";
import { api } from "../../api/client";
import { DICT_TITLES, type DictKind } from "./docs";
import { KIND_OPTIONS, REPO_CLASS, addEntry, addLinkedEntry, entriesOf, hasRepoObject, removeEntry, unlinkedCount, updateEntry, usageOf } from "./dict-ops";
import RepoPicker from "./RepoPicker";

type M = ProcessLogicModel;

const HINTS: Record<DictKind, string> = {
  roles: "Исполнители процесса — они же дорожки BPMN и механизмы IDEF0. Переименование меняет подпись дорожки.",
  systems: "Информационные системы, в которых выполняются шаги (механизмы IDEF0).",
  data: "Документы и данные: входы и выходы функций, а также управление, когда выход одной функции управляет другой.",
  controls: "Регламенты, правила и нормы, по которым выполняются функции (управление IDEF0).",
  kpi: "Показатели результативности процесса с целевыми значениями.",
  risks: "Риски процесса и меры по их снижению.",
};

/**
 * Справочник окна студии (как «Справочники» в Business Studio): список записей, добавление,
 * переименование, вид записи и «где используется» с переходом к шагу. Правки идут в общую
 * модель студии — их можно отменить и нужно сохранить вместе с диаграммами. Выбранная запись
 * открывается карточкой в панели «Свойства».
 */
export default function DictionaryView({
  kind,
  model,
  selectedId,
  onSelect,
  onChange,
  onGoto,
}: {
  kind: DictKind;
  model: M;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onChange: (next: M) => void;
  onGoto: (nodeId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [adding, setAdding] = useState("");
  const rows = entriesOf(model, kind);
  const q = query.trim().toLowerCase();
  const shown = q ? rows.filter((r) => r.name.toLowerCase().includes(q)) : rows;
  const options = KIND_OPTIONS[kind];
  const withUsage = kind !== "kpi" && kind !== "risks";
  const unlinked = unlinkedCount(model, kind);
  const repoClass = REPO_CLASS[kind];
  // пока идёт запрос к серверу, пользователь может править модель дальше — результат применяем к актуальной модели, а не к снимку на момент щелчка
  const modelRef = useRef(model);
  modelRef.current = model;
  const [picking, setPicking] = useState(false);
  const [repoMsg, setRepoMsg] = useState<string | null>(null);

  /** Передать запись модели в общий репозиторий: найденный по названию или синониму объект подхватывается, иначе создаётся новый. */
  const publish = async (id: string) => {
    const entry = rows.find((r) => r.id === id) as unknown as Record<string, string | null | undefined> | undefined;
    if (!repoClass || !entry?.name) return;
    try {
      const found = await api.matchRepositoryObject(repoClass, entry.name);
      if (found) {
        onChange(updateEntry(modelRef.current, kind, id, { name: found.name, repo_id: found.id, description: found.description, owner: found.owner }));
        setRepoMsg(`«${entry.name}» связана с объектом репозитория «${found.name}».`);
        return;
      }
      const created = await api.createRepositoryObject({ class: repoClass, name: entry.name, description: entry.description ?? null, owner: entry.owner ?? null, kind: entry.kind ?? null });
      onChange(updateEntry(modelRef.current, kind, id, { repo_id: created.id }));
      setRepoMsg(`«${entry.name}» передана в репозиторий — теперь её можно использовать в других процессах.`);
    } catch (e) {
      setRepoMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const add = () => {
    const name = adding.trim();
    if (!name) return;
    onChange(addEntry(model, kind, name).model);
    setAdding("");
  };

  const remove = (id: string, name: string) => {
    const used = withUsage ? usageOf(model, kind, id).length : 0;
    const warn = used > 0 ? `«${name}» используется в ${used} элем. — ссылки на неё будут убраны (шаги останутся). Удалить?` : `Удалить «${name}»?`;
    if (window.confirm(warn)) onChange(removeEntry(model, kind, id));
  };

  return (
    <div className="dict">
      <div className="dict-head">
        <h4>{DICT_TITLES[kind]}</h4>
        <span className="muted">{rows.length} зап.</span>
        <span className="spacer" />
        <input className="dict-search" placeholder="Поиск…" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <p className="muted dict-hint">
        {HINTS[kind]}
        {unlinked > 0 && kind === "roles" && <> У {unlinked} функц. исполнитель не назначен.</>}
        {unlinked > 0 && kind === "systems" && <> У {unlinked} функц. система не указана.</>}
      </p>

      <div className="dict-add">
        <input
          placeholder={`Новая запись: ${DICT_TITLES[kind].toLowerCase()}`}
          value={adding}
          onChange={(e) => setAdding(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
        />
        <button className="primary" disabled={!adding.trim()} onClick={add}>
          + Добавить
        </button>
        {repoClass && <button onClick={() => setPicking((v) => !v)}>Из репозитория…</button>}
      </div>
      {repoMsg && <p className="muted dict-hint">{repoMsg}</p>}
      {picking && repoClass && (
        <RepoPicker
          cls={repoClass}
          taken={new Set(rows.map((r) => (r as unknown as { repo_id?: string | null }).repo_id).filter((x): x is string => !!x))}
          onClose={() => setPicking(false)}
          onPick={(obj) => {
            if (hasRepoObject(model, kind, obj.id)) return;
            onChange(addLinkedEntry(model, kind, obj).model);
            setPicking(false);
            setRepoMsg(`«${obj.name}» добавлена из репозитория.`);
          }}
        />
      )}

      <table className="dict-table">
        <thead>
          <tr>
            <th style={{ width: 36 }}>№</th>
            <th>Название</th>
            {options && <th style={{ width: 130 }}>Вид</th>}
            {kind === "kpi" && (
              <>
                <th style={{ width: 130 }}>Целевое значение</th>
                <th style={{ width: 100 }}>Ед. изм.</th>
              </>
            )}
            {kind === "risks" && <th>Мера снижения</th>}
            <th style={{ width: 200 }}>Описание</th>
            {withUsage && <th style={{ width: 150 }}>Используется</th>}
            <th style={{ width: repoClass ? 62 : 36 }} />
          </tr>
        </thead>
        <tbody>
          {shown.length === 0 && (
            <tr>
              <td colSpan={8} className="muted" style={{ padding: 14 }}>
                {rows.length === 0 ? "Справочник пуст." : "Ничего не найдено."}
              </td>
            </tr>
          )}
          {shown.map((r, i) => {
            const usage = withUsage ? usageOf(model, kind, r.id) : [];
            const rec = r as unknown as Record<string, string | null | undefined>;
            const repoLinked = !!rec.repo_id;
            return (
              <FragmentRows key={r.id}>
                <tr className={`${usage.length === 0 && withUsage ? "dict-unused" : ""} ${selectedId === r.id ? "dict-selected" : ""}`} onClick={() => onSelect(r.id)}>
                  <td className="muted">{i + 1}</td>
                  <td>
                    <CellInput value={r.name} onCommit={(v) => v && onChange(updateEntry(model, kind, r.id, { name: v }))} />
                    {repoLinked && (
                      <span className="repo-badge" title="Объект общего репозитория: изменения названия и карточки в репозитории попадают сюда">
                        репозиторий
                      </span>
                    )}
                  </td>
                  {options && (
                    <td>
                      <select value={rec.kind ?? ""} onChange={(e) => onChange(updateEntry(model, kind, r.id, { kind: e.target.value }))}>
                        {options.map(([v, l]) => (
                          <option key={v} value={v}>
                            {l}
                          </option>
                        ))}
                      </select>
                    </td>
                  )}
                  {kind === "kpi" && (
                    <>
                      <td>
                        <CellInput value={rec.target ?? ""} onCommit={(v) => onChange(updateEntry(model, kind, r.id, { target: v || null }))} />
                      </td>
                      <td>
                        <CellInput value={rec.unit ?? ""} onCommit={(v) => onChange(updateEntry(model, kind, r.id, { unit: v || null }))} />
                      </td>
                    </>
                  )}
                  {kind === "risks" && (
                    <td>
                      <CellInput value={rec.mitigation ?? ""} onCommit={(v) => onChange(updateEntry(model, kind, r.id, { mitigation: v || null }))} />
                    </td>
                  )}
                  <td className="dict-desc">
                    <CellInput value={rec.description ?? ""} onCommit={(v) => onChange(updateEntry(model, kind, r.id, { description: v || null }))} />
                  </td>
                  {withUsage && (
                    <td>
                      {usage.length > 0 ? (
                        <button className="link-button" onClick={() => setExpanded(expanded === r.id ? null : r.id)}>
                          {expanded === r.id ? "▾" : "▸"} {usage.length}
                        </button>
                      ) : (
                        <span className="muted">не используется</span>
                      )}
                    </td>
                  )}
                  <td>
                    {repoClass && !repoLinked && (
                      <button className="dict-repo" title="Передать в репозиторий организации, чтобы использовать в других процессах" onClick={() => publish(r.id)}>
                        ⇪
                      </button>
                    )}
                    <button className="dict-del" title="Удалить" onClick={() => remove(r.id, r.name)}>
                      ✕
                    </button>
                  </td>
                </tr>
                {expanded === r.id && usage.length > 0 && (
                  <tr className="dict-usage">
                    <td />
                    <td colSpan={7}>
                      {usage.map((u, k) => (
                        <button key={k} className="usage-chip" onClick={() => onGoto(u.nodeId)} title="Перейти к элементу на диаграмме">
                          {u.nodeName} <span className="muted">· {u.how}</span>
                        </button>
                      ))}
                    </td>
                  </tr>
                )}
              </FragmentRows>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Строка с раскрывающимся продолжением без лишней обёртки в таблице. */
function FragmentRows({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

/** Поле ячейки: правка применяется по Enter или потере фокуса, Escape возвращает прежнее значение. */
function CellInput({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [text, setText] = useState(value);
  const [prev, setPrev] = useState(value);
  if (value !== prev) {
    setPrev(value);
    setText(value);
  }
  const commit = () => {
    const v = text.trim();
    if (v !== value) onCommit(v);
    else setText(value);
  };
  return (
    <input
      className="cell-input"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          setText(value);
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}
