/**
 * Наборы объектов — именованные списки функций (как «группы управления» в Business Studio): фильтруют дерево навигатора и
 * ограничивают выгрузку. В набор входит функция и всё, что в ней вложено (подпроцесс — со своими операциями). Общий модуль
 * сервера (выгрузка) и редактора в браузере (web подключает его через псевдоним @shared).
 */

export interface ObjectSetLike {
  id: string;
  name: string;
  members: string[];
}

export interface SetModelNode {
  id: string;
  type: string;
  idef0_parent?: string | null;
  bpmn_scope?: string | null;
}

export interface SetModel {
  nodes: SetModelNode[];
  object_sets?: ObjectSetLike[];
}

const isFn = (n: SetModelNode) => (n.type === "task" || n.type === "subprocess") && !n.bpmn_scope;

/** Функции набора: перечисленные и все вложенные в них. Несуществующие id в наборе (функцию удалили) пропускаются. */
export function setMembers(m: SetModel, setId: string): Set<string> {
  const set = m.object_sets?.find((s) => s.id === setId);
  const out = new Set<string>();
  if (!set) return out;
  const fns = m.nodes.filter(isFn);
  const byId = new Map(fns.map((n) => [n.id, n] as const));
  const listed = new Set(set.members.filter((id) => byId.has(id)));
  for (const n of fns) {
    // входит ли сама или кто-то из её предков
    for (let cur: SetModelNode | undefined = n, guard = 0; cur && guard < 50; cur = cur.idef0_parent ? byId.get(cur.idef0_parent) : undefined, guard++) {
      if (listed.has(cur.id)) {
        out.add(n.id);
        break;
      }
    }
  }
  return out;
}

/** Функции, видимые в дереве при фильтре по набору: члены набора и их предки (путь к ним). */
export function setVisible(m: SetModel, setId: string): Set<string> {
  const members = setMembers(m, setId);
  const byId = new Map(m.nodes.filter(isFn).map((n) => [n.id, n] as const));
  const out = new Set(members);
  for (const id of members) {
    for (let cur = byId.get(id)?.idef0_parent, guard = 0; cur && !out.has(cur) && guard < 50; cur = byId.get(cur)?.idef0_parent, guard++) out.add(cur);
  }
  return out;
}
