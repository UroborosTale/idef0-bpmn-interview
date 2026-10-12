import { useCallback, useEffect, useRef, useState } from "react";
import { api, type RepoClass, type RepoListItem, type RepoUsage } from "../api/client";
import { routePath } from "../router";
import ChoiceDialog, { type Choice } from "../components/ChoiceDialog";
import ConfirmDialog from "../components/ConfirmDialog";

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

  // ответы могут прийти не по порядку (быстрый ввод в поиске): показываем только самый свежий запрос
  const latest = useRef(0);
  const reload = useCallback(async () => {
    const mine = ++latest.current;
    try {
      const [shown, all] = await Promise.all([api.listRepository({ class: cls, q: query.trim() }), api.listRepository({ class: cls })]);
      if (mine !== latest.current) return;
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

  /** Открытое окно: слияние дублей, удаление используемого объекта (с заменой) или неиспользуемого (подтверждение). */
  const [dialog, setDialog] = useState<{ mode: "merge" | "replace" | "delete"; object: RepoListItem } | null>(null);
  const close = () => setDialog(null);

  const remove = (o: RepoListItem) => setDialog({ mode: o.entries === 0 ? "delete" : "replace", object: o });
  const merge = (o: RepoListItem) => setDialog({ mode: "merge", object: o });

  const choicesFor = (o: RepoListItem): Choice[] =>
    others
      .filter((x) => x.id !== o.id)
      .map((x) => ({
        id: x.id,
        title: x.name,
        details: [x.synonyms.length ? `синонимы: ${x.synonyms.join(", ")}` : "", x.entries ? `используется в ${x.sessions} проц.` : "не используется"].filter(Boolean).join(" · "),
      }));

  const sessionsText = (n: number) => `${n} проц.`;
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

      {dialog?.mode === "delete" && (
        <ConfirmDialog
          title="Удалить объект"
          text={<>Удалить «{dialog.object.name}» из репозитория? Объект нигде не используется.</>}
          confirmLabel="Удалить"
          danger
          onClose={close}
          onConfirm={() => {
            close();
            run(async () => {
              await api.deleteRepositoryObject(dialog.object.id);
              return "Объект удалён.";
            });
          }}
        />
      )}
      {dialog && dialog.mode !== "delete" && (
        <ChoiceDialog
          title={dialog.mode === "merge" ? `Объединить «${dialog.object.name}» с…` : `Заменить «${dialog.object.name}» на…`}
          description={
            dialog.mode === "merge"
              ? "Выберите объект, который останется. Название и синонимы этого объекта станут синонимами выбранного, а записи во всех процессах перейдут на выбранный."
              : `«${dialog.object.name}» используется в ${sessionsText(dialog.object.sessions)}, поэтому удалить его можно только с заменой: во всех процессах записи перейдут на выбранный объект.`
          }
          choices={choicesFor(dialog.object)}
          emptyText="Нет другого объекта этого класса. Сначала заведите объект, на который можно перейти."
          confirmLabel={dialog.mode === "merge" ? "Объединить" : "Заменить и удалить"}
          danger={dialog.mode === "replace"}
          preview={(c) => (
            <>
              «{dialog.object.name}» {dialog.mode === "merge" ? "станет синонимом" : "будет удалён, его название станет синонимом"} «{c.title}». Записи в {sessionsText(dialog.object.sessions)} получат название и карточку «{c.title}»; в утверждённых версиях меняется только ссылка.
            </>
          )}
          onClose={close}
          onConfirm={(c) => {
            const o = dialog.object;
            const mode = dialog.mode;
            close();
            run(async () => {
              const r = mode === "merge" ? await api.mergeRepositoryObject(o.id, c.id) : await api.deleteRepositoryObject(o.id, c.id);
              const done = r as { relinked?: number; skipped?: number; duplicated?: number } | undefined;
              const detail =
                done && typeof done === "object" && done.relinked !== undefined
                  ? ` Процессов обновлено: ${done.relinked}${done.skipped ? `; утверждённых версий не менялось: ${done.skipped}` : ""}.${done.duplicated ? ` В процессах (${done.duplicated}) теперь две записи с одним названием — объедините их в самой модели.` : ""}`
                  : "";
              return mode === "merge" ? `Объединено с «${c.title}».${detail}` : `Объект заменён на «${c.title}» и удалён.${detail}`;
            });
          }}
        />
      )}
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
