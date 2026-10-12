import { useEffect, useState } from "react";
import { api, type RepoClass, type RepoListItem, type RepoObject } from "../../api/client";

/**
 * Выбор объекта из общего репозитория организации: поиск по названию и синонимам, объекты, которые уже есть
 * в модели, недоступны. Выбранный объект становится записью справочника модели со ссылкой на репозиторий.
 */
export default function RepoPicker({
  cls,
  taken,
  onPick,
  onClose,
}: {
  cls: RepoClass;
  /** id объектов, уже добавленных в модель. */
  taken: Set<string>;
  onPick: (obj: RepoObject) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<RepoListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      api
        .listRepository({ class: cls, q: query.trim() })
        .then((r) => live && (setRows(r), setError(null)))
        .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    }, 150);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [cls, query]);

  return (
    <div className="dict-picker" role="dialog" aria-label="Выбор из репозитория">
      <div className="dict-head">
        <h4>Из репозитория организации</h4>
        <span className="spacer" />
        <input className="dict-search" autoFocus placeholder="Поиск по названию и синонимам…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button onClick={onClose}>Закрыть</button>
      </div>
      {error && <p className="validation-item error">{error}</p>}
      {rows && rows.length === 0 && <p className="muted">{query.trim() ? "Ничего не найдено." : "В репозитории пока нет объектов этого класса — добавьте их на странице «Репозиторий» или передайте записи модели кнопкой ⇪."}</p>}
      <ul className="dict-picker-list">
        {(rows ?? []).map((o) => (
          <li key={o.id}>
            <div>
              <b>{o.name}</b>
              {o.synonyms.length > 0 && <span className="muted"> · {o.synonyms.join(", ")}</span>}
              <div className="muted">
                {o.description || "без описания"} · в {o.sessions} проц.
              </div>
            </div>
            <button className="primary" disabled={taken.has(o.id)} title={taken.has(o.id) ? "Уже есть в этой модели" : undefined} onClick={() => onPick(o)}>
              {taken.has(o.id) ? "Уже в модели" : "Добавить"}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
