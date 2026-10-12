import { useCallback, useEffect, useState } from "react";
import { api, type RepoClass, type RepoListItem, type RepoUsage } from "../api/client";
import { routePath } from "../router";

const CLASSES: { cls: RepoClass; title: string; one: string }[] = [
  { cls: "role", title: "Роли", one: "роль" },
  { cls: "system", title: "Информационные системы", one: "информационную систему" },
  { cls: "data", title: "Документы и данные", one: "документ" },
];
const KINDS: Partial<Record<RepoClass, [string, string][]>> = {
  role: [["internal", "внутренняя"], ["external", "внешняя"]],
  data: [["document", "документ"], ["data", "данные"]],
};

/**
 * Общий репозиторий объектов организации (ТЗ, 3.2): роль, информационная система или документ хранятся один раз
 * и используются во многих процессах. Здесь их заводят, правят (изменения попадают в связанные модели),
 * сводят дубли и смотрят, где объект используется. Удалить используемый объект можно только с заменой.
 */
export default function RepositoryPage() {
  const [cls, setCls] = useState<RepoClass>("role");
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<RepoListItem[]>([]);
  const [others, setOthers] = useState<RepoListItem[]>([]);
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [usage, setUsage] = useState<RepoUsage[]>([]);
  const [name, setName] = useState("");
  const [kind, setKind] = useState("");

  const reload = useCallback(async () => {
    try {
      const [shown, all] = await Promise.all([api.listRepository({ class: cls, q: query.trim() }), api.listRepository({ class: cls })]);
      setRows(shown);
      setOthers(all);
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : String(e), error: true });
    }
  }, [cls, query]);

  useEffect(() => {
    const t = setTimeout(reload, 150);
    return () => clearTimeout(t);
  }, [reload]);

  useEffect(() => {
    setExpanded(null);
    setKind(KINDS[cls]?.[0][0] ?? "");
  }, [cls]);

  /** Выполнить действие, показать результат и обновить таблицу. */
  const run = async (action: () => Promise<string | void>) => {
    try {
      const text = await action();
      setMsg(text ? { text } : null);
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : String(e), error: true });
    }
    await reload();
  };

  const syncText = (r: { updated: number; skipped: number }) =>
    r.updated + r.skipped === 0
      ? "Сохранено."
      : `Сохранено. Обновлено процессов: ${r.updated}${r.skipped ? `; утверждённые версии не изменены: ${r.skipped}` : ""}.`;

  const toggleUsage = async (id: string) => {
    if (expanded === id) return setExpanded(null);
    setExpanded(id);
    setUsage([]);
    try {
      setUsage((await api.getRepositoryObject(id)).usage);
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : String(e), error: true });
    }
  };

  const remove = (o: RepoListItem) =>
    run(async () => {
      if (o.entries === 0) {
        if (!window.confirm(`Удалить «${o.name}» из репозитория?`)) return;
        await api.deleteRepositoryObject(o.id);
        return "Объект удалён.";
      }
      const choices = others.filter((x) => x.id !== o.id);
      if (choices.length === 0) throw new Error(`«${o.name}» используется в ${o.sessions} проц. — заменить её нечем: сначала заведите другой объект.`);
      const answer = window.prompt(
        `«${o.name}» используется в ${o.sessions} проц. Чтобы удалить, укажите замену — номер из списка:\n` + choices.map((x, i) => `${i + 1}. ${x.name}`).join("\n")
      );
      const target = choices[Number(answer) - 1];
      if (!target) return;
      const r = await api.deleteRepositoryObject(o.id, target.id);
      void r;
      return `Объект заменён на «${target.name}».`;
    });

  const merge = (o: RepoListItem) =>
    run(async () => {
      const choices = others.filter((x) => x.id !== o.id);
      if (choices.length === 0) throw new Error("Нет другого объекта этого класса, с которым можно объединить.");
      const answer = window.prompt(`Объединить «${o.name}» с объектом (номер). «${o.name}» станет синонимом, записи моделей перейдут на выбранный объект:\n` + choices.map((x, i) => `${i + 1}. ${x.name}`).join("\n"));
      const target = choices[Number(answer) - 1];
      if (!target) return;
      const r = await api.mergeRepositoryObject(o.id, target.id);
      return `Объединено с «${r.object.name}»: записей перенесено — ${r.relinked}.`;
    });

  const add = () =>
    run(async () => {
      await api.createRepositoryObject({ class: cls, name: name.trim(), kind: kind || null });
      setName("");
      return "Объект добавлен.";
    });

  const kinds = KINDS[cls];

  return (
    <div className="card" style={{ margin: 16 }}>
      <div className="toolbar">
        <h2 style={{ margin: 0 }}>Репозиторий объектов</h2>
        <div className="spacer" />
        {CLASSES.map((c) => (
          <button key={c.cls} className={cls === c.cls ? "active" : ""} onClick={() => setCls(c.cls)}>
            {c.title}
          </button>
        ))}
      </div>
      <p className="muted dict-hint">
        Объект хранится один раз и используется во всех процессах. Изменение названия, описания и ответственного переносится в связанные модели
        (утверждённые версии не меняются); прежнее название остаётся синонимом. В студии: «Справочники → Из репозитория…» и ⇪ у записи.
      </p>

      <div className="repo-add">
        <input
          className="repo-name"
          placeholder={`Новый объект: ${CLASSES.find((c) => c.cls === cls)!.one}`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && name.trim() && add()}
        />
        {kinds && (
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            {kinds.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        )}
        <button className="primary" disabled={!name.trim()} onClick={add}>
          + Добавить
        </button>
        <span className="spacer" />
        <input className="dict-search" placeholder="Поиск по названию и синонимам…" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      {msg && <p className={msg.error ? "validation-item error" : "muted dict-hint"}>{msg.text}</p>}

      <table className="dict-table">
        <thead>
          <tr>
            <th>Название</th>
            {kinds && <th style={{ width: 150 }}>Вид</th>}
            <th>Синонимы (через запятую)</th>
            <th>Описание</th>
            <th style={{ width: 150 }}>{cls === "role" ? "Подразделение" : "Ответственный"}</th>
            <th style={{ width: 110 }}>Используется</th>
            <th style={{ width: 130 }} />
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={7} className="muted" style={{ padding: 14 }}>
                {query.trim() ? "Ничего не найдено." : "Объектов пока нет."}
              </td>
            </tr>
          )}
          {rows.map((o) => (
            <RowGroup key={o.id}>
              <tr className={o.entries === 0 ? "dict-unused" : ""}>
                <td>
                  <Cell value={o.name} onCommit={(v) => v && run(async () => syncText(await api.patchRepositoryObject(o.id, { name: v })))} />
                </td>
                {kinds && (
                  <td>
                    <select value={o.kind ?? ""} onChange={(e) => run(async () => syncText(await api.patchRepositoryObject(o.id, { kind: e.target.value })))}>
                      {kinds.map(([v, l]) => (
                        <option key={v} value={v}>
                          {l}
                        </option>
                      ))}
                    </select>
                  </td>
                )}
                <td>
                  <Cell
                    value={o.synonyms.join(", ")}
                    onCommit={(v) =>
                      run(async () => {
                        await api.patchRepositoryObject(o.id, { synonyms: v.split(",").map((s) => s.trim()).filter(Boolean) });
                        return "Синонимы сохранены.";
                      })
                    }
                  />
                </td>
                <td>
                  <Cell value={o.description ?? ""} onCommit={(v) => run(async () => syncText(await api.patchRepositoryObject(o.id, { description: v || null })))} />
                </td>
                <td>
                  <Cell value={o.owner ?? ""} onCommit={(v) => run(async () => syncText(await api.patchRepositoryObject(o.id, { owner: v || null })))} />
                </td>
                <td>
                  {o.entries > 0 ? (
                    <button className="link-button" onClick={() => toggleUsage(o.id)}>
                      {expanded === o.id ? "▾" : "▸"} {o.sessions} проц.
                    </button>
                  ) : (
                    <span className="muted">не используется</span>
                  )}
                </td>
                <td>
                  <button title="Объединить с другим объектом (дубли)" onClick={() => merge(o)}>
                    ⇆
                  </button>{" "}
                  <button className="dict-del" title="Удалить" onClick={() => remove(o)}>
                    ✕
                  </button>
                </td>
              </tr>
              {expanded === o.id && (
                <tr className="dict-usage">
                  <td colSpan={7} className="repo-usage">
                    {usage.length === 0 && <span className="muted">Загрузка…</span>}
                    {usage.map((u) => (
                      <a key={`${u.sessionId}-${u.entryId}`} href={routePath({ name: "workspace", id: u.sessionId })} title={u.approved ? "Утверждённая версия" : undefined}>
                        {u.sessionTitle}
                        <span className="muted"> · {u.entryName === o.name ? `${u.uses} шаг.` : `как «${u.entryName}», ${u.uses} шаг.`}</span>
                        {u.approved ? " 🔒" : ""}
                      </a>
                    ))}
                  </td>
                </tr>
              )}
            </RowGroup>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RowGroup({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

/** Поле ячейки: правка применяется по Enter или потере фокуса, Escape возвращает прежнее значение. */
function Cell({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [text, setText] = useState(value);
  const [prev, setPrev] = useState(value);
  if (value !== prev) {
    setPrev(value);
    setText(value);
  }
  return (
    <input
      className="cell-input"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => (text.trim() !== value ? onCommit(text.trim()) : setText(value))}
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
