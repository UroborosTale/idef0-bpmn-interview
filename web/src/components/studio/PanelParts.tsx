import { useEffect, useState } from "react";
import { api } from "../../api/client";
import type { Fragment, HistoryEvent, SourceRef } from "../../types";
import { TYPE_LABELS } from "../bpmn-editor/model-ops";
import { KIND_OPTIONS, LEVEL_OPTIONS } from "./dict-ops";

/** Вертикальные вкладки панели свойств, как в окнах свойств Business Studio: «Основные», «Дополнительно», «Связи». */
export type PropTab = "main" | "more" | "links" | "life";
export const PROP_TABS: { key: PropTab; title: string }[] = [
  { key: "main", title: "Основные" },
  { key: "more", title: "Дополнительно" },
  { key: "links", title: "Связи" },
  { key: "life", title: "Жизненный цикл" },
];
const LINKS_SECTIONS = new Set(["Источник в интервью", "Диаграммы", "Замечания проверки"]);
/** Вкладка «Жизненный цикл», как в Business Studio: статус, версия и история объекта. */
const LIFE_SECTIONS = new Set(["Жизненный цикл", "История"]);
const MORE_SECTIONS = new Set(["Ролевая модель", "Ролевая модель процесса", "RACI", "Стороны блока IDEF0", "Триггеры блока", "Граничные события", "Потоки сообщений", "Внешние пулы"]);
/** На какой вкладке показан раздел (по заголовку; остальные — на «Основных»). */
export const tabOfSection = (title: string): PropTab => (LIFE_SECTIONS.has(title) ? "life" : LINKS_SECTIONS.has(title) ? "links" : MORE_SECTIONS.has(title) ? "more" : "main");

/** Раздел панели свойств: сворачиваемый заголовок и тело. */
export function Section({ title, count, open = true, onToggle, children }: { title: string; count?: number; open?: boolean; onToggle?: (open: boolean) => void; children: React.ReactNode }) {
  return (
    <details className="prop-section" data-tab={tabOfSection(title)} open={open} onToggle={onToggle ? (e) => onToggle((e.currentTarget as HTMLDetailsElement).open) : undefined}>
      <summary>
        {title}
        {count !== undefined && <span className="prop-count">{count}</span>}
      </summary>
      <div className="prop-body">{children}</div>
    </details>
  );
}

const SPEAKER: Record<Fragment["speaker"], string> = { interviewer: "интервьюер", owner: "владелец процесса", participant: "участник", unknown: "собеседник" };

/** Цитаты из интервью, на которых основан элемент (трассировка). */
export function SourceList({ source, fragments }: { source: SourceRef[]; fragments: Fragment[] }) {
  if (source.length === 0) return <p className="muted prop-note">Создано вручную — в тексте интервью источника нет.</p>;
  return (
    <div className="prop-sources">
      {source.map((s, i) => {
        const f = fragments.find((x) => x.id === s.fragment_id);
        return (
          <blockquote key={i}>
            «{s.quote}»
            <footer className="muted">{f ? `${f.speaker_label || SPEAKER[f.speaker]}, фрагмент ${f.index + 1}` : s.fragment_id}</footer>
          </blockquote>
        );
      })}
    </div>
  );
}

const FIELD_LABELS: Record<string, string> = {
  name: "Название",
  kind: "Вид",
  owner: "Ответственный",
  description: "Описание",
  reference: "Реквизиты",
  target: "Целевое значение",
  unit: "Ед. изм.",
  period: "Периодичность",
  mitigation: "Мера снижения",
  level: "Уровень",
  type: "Тип",
  role_id: "Исполнитель",
  duration: "Длительность",
  note: "Заметка",
};

const VALUE_LABELS: Record<string, string> = {
  ...Object.fromEntries(Object.values(KIND_OPTIONS).flatMap((o) => o ?? [])),
  ...Object.fromEntries(LEVEL_OPTIONS),
  ...TYPE_LABELS,
};

const short = (s: string | null) => (s === null ? "пусто" : `«${VALUE_LABELS[s] ?? (s.length > 80 ? `${s.slice(0, 80)}…` : s)}»`);

/**
 * История записи по сохранённым версиям модели: когда появилась, что менялось, когда удалена.
 * Загружается при раскрытии раздела и обновляется после каждого сохранения (stamp).
 */
export function HistoryList({ sessionId, kind, id, stamp }: { sessionId: string; kind: string; id: string; stamp: string }) {
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<HistoryEvent[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    setEvents(null);
    setError("");
    if (!open) return;
    let dead = false;
    api
      .entryHistory(sessionId, kind, id)
      .then((e) => !dead && setEvents(e))
      .catch((e: Error) => !dead && setError(e.message));
    return () => {
      dead = true;
    };
  }, [open, sessionId, kind, id, stamp]);

  return (
    <Section title="История" open={false} onToggle={setOpen}>
      {error && <p className="prop-note st-err">Не удалось загрузить историю: {error}</p>}
      {!error && events === null && <p className="muted prop-note">Загрузка…</p>}
      {events && events.length === 0 && <p className="muted prop-note">В сохранённых версиях модели этой записи нет.</p>}
      {events && events.length > 0 && (
        <ol className="prop-history">
          {[...events].reverse().map((e) => (
            <li key={e.seq}>
              <div>
                <b>{e.event === "created" ? "Появилась" : e.event === "removed" ? "Удалена" : "Изменена"}</b> · версия {e.version}
              </div>
              <div className="muted">
                {new Date(e.ts).toLocaleString("ru-RU")} · {e.author}
                {e.note ? ` · ${e.note}` : ""}
              </div>
              {e.changes.map((c) => (
                <div key={c.field} className="prop-change">
                  {kind === "roles" && c.field === "owner" ? "Подразделение" : FIELD_LABELS[c.field] ?? c.field}: {short(c.from)} → {short(c.to)}
                </div>
              ))}
            </li>
          ))}
        </ol>
      )}
      {events && <p className="muted prop-note">Только сохранённые версии; несохранённые правки здесь не видны.</p>}
    </Section>
  );
}
