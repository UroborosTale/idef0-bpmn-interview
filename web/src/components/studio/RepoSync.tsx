import { useEffect, useState } from "react";
import { api } from "../../api/client";
import type { RepoObject } from "../../api/types";
import { Section } from "./PanelParts";

type Fields = { name: string; description?: string | null; owner?: string | null; kind?: string | null };
const KEYS = ["name", "description", "owner", "kind"] as const;
const LABELS: Record<(typeof KEYS)[number], string> = { name: "Название", description: "Описание", owner: "Ответственный", kind: "Вид" };
const norm = (v: string | null | undefined) => (v ?? "").trim();

/** Чем запись модели отличается от объекта репозитория (по общим полям); пустое и отсутствующее значение считаются одинаковыми. */
export function repoDiff(entry: Fields, obj: Pick<RepoObject, "name" | "description" | "owner" | "kind">): (typeof KEYS)[number][] {
  return KEYS.filter((k) => {
    // вид у записи есть не всегда (системы) — тогда сравнивать нечего
    if (k === "kind" && entry.kind === undefined) return false;
    return norm(entry[k]) !== norm(obj[k]);
  });
}

/**
 * Связь записи с общим репозиторием: если значения записи изменили в этом процессе, можно обновить объект (изменение
 * дойдёт до других процессов) или вернуть значения репозитория. Утверждённые версии других процессов не меняются.
 */
export default function RepoSync({ sessionId, repoId, entry, stamp, onTake }: { sessionId: string; repoId: string; entry: Fields; stamp: string; onTake: (patch: Record<string, unknown>) => void }) {
  const [obj, setObj] = useState<RepoObject | null | undefined>(undefined); // undefined — загрузка, null — объект удалён
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let alive = true;
    api
      .getRepositoryObject(repoId)
      .then((o) => alive && setObj(o))
      .catch(() => alive && setObj(null));
    return () => {
      alive = false;
    };
  }, [repoId, stamp, reload]);

  if (obj === undefined) return null;
  if (obj === null) {
    return (
      <Section title="Репозиторий">
        <p className="prop-note prop-warn">Объект репозитория удалён — запись больше не связана с ним.</p>
      </Section>
    );
  }
  const diff = repoDiff(entry, obj);

  const push = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const patch: Record<string, string | null> = {};
      for (const k of diff) patch[k] = k === "name" ? norm(entry.name) : norm(entry[k]) || null;
      const r = await api.patchRepositoryObject(repoId, patch, true, sessionId);
      setMsg(r.updated > 0 ? `Объект обновлён, изменения применены в других процессах: ${r.updated}.` : "Объект обновлён.");
      setReload((n) => n + 1);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const take = () => {
    const patch: Record<string, unknown> = {};
    for (const k of diff) patch[k] = k === "name" ? obj.name : obj[k] ?? null;
    onTake(patch);
    setMsg("Значения репозитория применены — не забудьте сохранить модель.");
  };

  return (
    <Section title="Репозиторий">
      {diff.length === 0 ? (
        <p className="muted prop-note">Объект общего репозитория «{obj.name}». Значения совпадают.</p>
      ) : (
        <div data-repo-diff>
          <p className="prop-note prop-warn">Запись отличается от объекта репозитория «{obj.name}»:</p>
          <ul className="repo-diff">
            {diff.map((k) => (
              <li key={k}>
                <b>{LABELS[k]}:</b> в репозитории «{norm(obj[k]) || "—"}» → здесь «{norm(entry[k]) || "—"}»
              </li>
            ))}
          </ul>
          <div className="bpe-actions">
            <button disabled={busy} onClick={() => void push()} title="Записать эти значения в объект репозитория: они появятся и в других процессах (кроме утверждённых версий)">
              Обновить объект в репозитории
            </button>
            <button disabled={busy} onClick={take} title="Вернуть в запись значения из репозитория">
              Взять из репозитория
            </button>
          </div>
        </div>
      )}
      {msg && <p className="muted prop-note">{msg}</p>}
    </Section>
  );
}
