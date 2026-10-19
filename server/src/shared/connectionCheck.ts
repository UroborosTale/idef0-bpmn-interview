import { functionsOf, type ModelLike, type NodeLike } from "./idef0Layout.js";

/**
 * «Проверка соединения» (В10, как в Business Studio): проблемные концы стрелок диаграммы IDEF0.
 * Проверяются данные модели, а не геометрия: раскладка всегда ставит механизмы снизу и концы — на блоках,
 * поэтому «не прикреплённый визуально конец» в нашей модели означает ссылку на запись, которой нет.
 */
export type ConnectionIssueKind = "dup" | "both" | "missing";

export interface ConnectionIssue {
  /** Стабильный ключ: блок + вид замечания + сущность (нужен списку и тестам). */
  id: string;
  kind: ConnectionIssueKind;
  nodeId: string;
  message: string;
}

/** Записи справочников по id — для подписей замечаний. */
interface Names {
  data: Map<string, string>;
  controls: Map<string, string>;
  roles: Map<string, string>;
  systems: Map<string, string>;
}

export function checkConnections<N extends NodeLike>(m: ModelLike<N>, parentId: string | null = null): ConnectionIssue[] {
  const out: ConnectionIssue[] = [];
  const seen = new Set<string>();
  const add = (i: ConnectionIssue) => {
    if (seen.has(i.id)) return;
    seen.add(i.id);
    out.push(i);
  };
  const names: Names = {
    data: new Map(m.data.map((d) => [d.id, d.name] as const)),
    controls: new Map(m.controls.map((c) => [c.id, c.name] as const)),
    roles: new Map(m.roles.map((r) => [r.id, r.name] as const)),
    systems: new Map(m.systems.map((s) => [s.id, s.name] as const)),
  };
  const nameOf = (id: string) => names.data.get(id) ?? names.controls.get(id) ?? names.roles.get(id) ?? names.systems.get(id) ?? id;
  /** Что за раздел: входы и выходы — данные, управление — нормативные документы, механизмы — должности и системы. */
  const dictOf = (slot: "inputs" | "outputs" | "controls" | "system_ids") => (slot === "controls" ? names.controls : slot === "system_ids" ? names.systems : names.data);

  for (const n of functionsOf(m, parentId)) {
    const title = `${n.name}`;
    const slots: [("inputs" | "outputs" | "controls" | "system_ids"), string][] = [
      ["inputs", "Входы"],
      ["outputs", "Выходы"],
      ["controls", "Управление"],
      ["system_ids", "Системы"],
    ];
    for (const [slot, label] of slots) {
      const ids = (n[slot] ?? []) as string[];
      const once = new Set<string>();
      for (const id of ids) {
        if (once.has(id)) add({ id: `dup:${n.id}:${slot}:${id}`, kind: "dup", nodeId: n.id, message: `${title}: «${nameOf(id)}» указан в разделе «${label}» дважды.` });
        once.add(id);
        if (!dictOf(slot).has(id) && slot !== "system_ids") add({ id: `missing:${n.id}:${slot}:${id}`, kind: "missing", nodeId: n.id, message: `${title}: ${label.toLowerCase()} «${id}» нет в справочнике — конец стрелки не прикреплён к записи.` });
      }
    }
    // одна и та же запись не может быть у блока и входом, и выходом: это дубль сущности в одном виде
    for (const id of (n.inputs ?? []) as string[]) {
      if (((n.outputs ?? []) as string[]).includes(id)) add({ id: `both:${n.id}:${id}`, kind: "both", nodeId: n.id, message: `${title}: «${nameOf(id)}» одновременно вход и выход — у одного блока сущность показывается в одном виде.` });
    }
  }
  return out;
}
