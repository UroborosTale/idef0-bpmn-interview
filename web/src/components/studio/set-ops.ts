import { entryKey, setMembers, type DictKey } from "@shared/objectSets";
import type { ObjectSet, ProcessLogicModel } from "../../types";
import { nextId } from "../bpmn-editor/model-ops";

type M = ProcessLogicModel;

/**
 * Операции над наборами объектов (именованные списки функций; в набор входит функция и всё вложенное). Чистые функции
 * над моделью — шаги общей истории правок, их можно отменить Ctrl+Z.
 */

const isFn = (m: M, id: string) => m.nodes.some((n) => n.id === id && (n.type === "task" || n.type === "subprocess") && !n.bpmn_scope);

const withSets = (m: M, sets: ObjectSet[]): M => ({ ...m, object_sets: sets });

/** Новый набор с функциями members (несуществующие и не функции отбрасываются); id возвращается. */
export function createSet(m: M, name: string, members: string[] = []): { model: M; id: string } {
  const sets = m.object_sets ?? [];
  const id = nextId("set", sets.map((s) => s.id));
  const set: ObjectSet = { id, name: name.trim() || "Набор", members: [...new Set(members.filter((x) => isFn(m, x)))] };
  return { model: withSets(m, [...sets, set]), id };
}

export const renameSet = (m: M, id: string, name: string): M => {
  const next = name.trim();
  return next ? withSets(m, (m.object_sets ?? []).map((s) => (s.id === id ? { ...s, name: next } : s))) : m;
};

export const deleteSet = (m: M, id: string): M => withSets(m, (m.object_sets ?? []).filter((s) => s.id !== id));

/** Добавляет функцию в набор; если она уже входит (сама или через вложенность), модель не меняется. Вложенные ей члены набора становятся лишними и убираются. */
export function addToSet(m: M, setId: string, fnId: string): M {
  const set = (m.object_sets ?? []).find((s) => s.id === setId);
  if (!set || !isFn(m, fnId) || setMembers(m, setId).has(fnId)) return m;
  const inside = new Set<string>();
  const stack = [fnId];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const n of m.nodes) if (n.idef0_parent === cur && !n.bpmn_scope && !inside.has(n.id)) (inside.add(n.id), stack.push(n.id));
  }
  return withSets(m, (m.object_sets ?? []).map((s) => (s.id === setId ? { ...s, members: [...s.members.filter((x) => !inside.has(x)), fnId] } : s)));
}

/** Убирает функцию, перечисленную в наборе напрямую; вложенную в уже входящую функцию так убрать нельзя. */
export const removeFromSet = (m: M, setId: string, fnId: string): M =>
  withSets(m, (m.object_sets ?? []).map((s) => (s.id === setId ? { ...s, members: s.members.filter((x) => x !== fnId) } : s)));

/** Добавляет запись справочника в набор; повторное добавление и неизвестный набор модель не меняют. */
export function addEntryToSet(m: M, setId: string, dict: DictKey, id: string): M {
  const key = entryKey(dict, id);
  const set = (m.object_sets ?? []).find((s) => s.id === setId);
  if (!set || (set.entries ?? []).includes(key)) return m;
  return withSets(m, (m.object_sets ?? []).map((s) => (s.id === setId ? { ...s, entries: [...(s.entries ?? []), key] } : s)));
}

/** Убирает запись справочника из набора; когда записей не осталось, поле набора убирается. */
export function removeEntryFromSet(m: M, setId: string, dict: DictKey, id: string): M {
  const key = entryKey(dict, id);
  return withSets(
    m,
    (m.object_sets ?? []).map((s) => {
      if (s.id !== setId || !(s.entries ?? []).includes(key)) return s;
      const entries = (s.entries ?? []).filter((x) => x !== key);
      const { entries: _old, ...rest } = s;
      return entries.length === 0 ? rest : { ...rest, entries };
    })
  );
}

/** Удалённую запись справочника из всех наборов убирает; без наборов модель не меняется. */
export function dropEntryFromSets(m: M, dict: DictKey, id: string): M {
  const key = entryKey(dict, id);
  if (!(m.object_sets ?? []).some((s) => (s.entries ?? []).includes(key))) return m;
  return (m.object_sets ?? []).reduce((acc, s) => (s.entries?.includes(key) ? removeEntryFromSet(acc, s.id, dict, id) : acc), m);
}
