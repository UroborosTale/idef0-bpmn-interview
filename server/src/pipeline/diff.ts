import type { ProcessLogicModel } from "../types/model.js";

/**
 * Каноническая сериализация с рекурсивной сортировкой ключей объектов —
 * нужна для СРАВНЕНИЯ на равенство. Обычный JSON.stringify чувствителен
 * к порядку ключей: два семантически идентичных объекта, построенных
 * разными путями (например, один — через zod .parse() с default-заполнением,
 * другой — как есть из PUT-запроса), могут дать разные строки и ложно
 * считаться "изменёнными".
 */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** ФТ-М7.1.2: diff двух версий PLM — используется и историей версий, и анализом влияния (М7.3), и регламентом (М1.1.4). */
export function diffModels(a: ProcessLogicModel, b: ProcessLogicModel) {
  function diffList<T extends { id: string }>(an: T[], bn: T[]) {
    const aById = new Map(an.map((x) => [x.id, x] as const));
    const bById = new Map(bn.map((x) => [x.id, x] as const));
    const added = bn.filter((x) => !aById.has(x.id));
    const removed = an.filter((x) => !bById.has(x.id));
    const changed: { id: string; before: T; after: T }[] = [];
    for (const [id, av] of aById) {
      const bv = bById.get(id);
      if (bv && stableStringify(av) !== stableStringify(bv)) changed.push({ id, before: av, after: bv });
    }
    return { added, removed, changed };
  }
  return {
    process: stableStringify(a.process) !== stableStringify(b.process) ? { before: a.process, after: b.process } : null,
    nodes: diffList(a.nodes, b.nodes),
    flows: diffList(a.flows, b.flows),
    roles: diffList(a.roles, b.roles),
    systems: diffList(a.systems, b.systems),
    data: diffList(a.data, b.data),
    controls: diffList(a.controls, b.controls),
    kpi: diffList(a.process.kpi ?? [], b.process.kpi ?? []),
    raci: diffList(
      a.raci.map((r, i) => ({ ...r, id: `${r.node_id}:${r.role_id}:${r.type}:${i}` })),
      b.raci.map((r, i) => ({ ...r, id: `${r.node_id}:${r.role_id}:${r.type}:${i}` }))
    ),
  };
}

export type ModelDiff = ReturnType<typeof diffModels>;
