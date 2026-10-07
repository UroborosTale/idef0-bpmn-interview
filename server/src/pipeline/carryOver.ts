import type { ProcessLogicModel, ProcessNode, ProcessFlow } from "../types/model.js";
import { normKey } from "./extract.js";

type M = ProcessLogicModel;

const CARD_FIELDS = ["description", "owner", "reference", "qualification", "supplier", "consumer", "value", "quality_standard"];

/** Пробелы, на которые аналитик уже ответил или которые отклонил, не должны снова открываться после пересчёта. */
export function keepGapStatuses(prev: M["gaps"], fresh: M["gaps"]): M["gaps"] {
  const closed = new Map(prev.filter((g) => g.status !== "open").map((g) => [`${g.rule}|${g.question}`, g] as const));
  const out = fresh.map((g) => {
    const old = closed.get(`${g.rule}|${g.question}`);
    return old ? { ...g, status: old.status, asked_count: old.asked_count } : g;
  });
  // открытые вопросы, заданные владельцем вручную, тоже сохраняются
  const ids = new Set(out.map((g) => g.id));
  return [...out, ...prev.filter((g) => g.rule === "owner_flagged" && g.status === "open" && !ids.has(g.id))];
}

/**
 * Повторная обработка текста строит модель заново, и id элементов в ней — новые (n1, n2… по порядку
 * извлечения). Чтобы не потерять работу аналитика, ручные правки прежней модели переносятся в новую:
 *
 * - шаги сопоставляются по типу и названию (без учёта падежей); у сопоставленных сохраняются позиции
 *   в редакторах, заметки, теги, подтверждения и ссылки на требования;
 * - шаги, созданные вручную (без источника в тексте) — в редакторе, Visio, декомпозиции IDEF0, —
 *   переносятся целиком вместе со связями между ними и сопоставленными шагами;
 * - роли, данные, регламенты и системы сопоставляются по названию; недостающие добавляются;
 * - атрибуты процесса, которые не извлекаются из текста (KPI, риски, код, уровень и т. п.), RACI,
 *   трассировка требований и интерфейсы берутся из прежней модели с пересчётом id.
 */
export function carryOverManualEdits(prev: M, next: M): { model: M; matched: number; kept: number } {
  const model: M = structuredClone(next);

  // карточка записи (описание, ответственный, реквизиты) — ручной ввод, из текста не извлекается: у сопоставленной записи сохраняется
  const inherit = <T extends { id: string; name: string }>(newList: T[], hitId: string, old: T) => {
    const target = newList.find((x) => x.id === hitId) as Record<string, unknown> | undefined;
    if (!target) return;
    for (const k of CARD_FIELDS) {
      const v = (old as Record<string, unknown>)[k];
      if (v != null && v !== "" && (target[k] == null || target[k] === "")) target[k] = v;
    }
  };

  // --- справочники: id прежней сущности → id в новой модели ---
  const mapEntities = <T extends { id: string; name: string }>(oldList: T[], newList: T[], prefix: string): Map<string, string> => {
    const byKey = new Map(newList.map((e) => [normKey(e.name), e.id] as const));
    const used = new Set(newList.map((e) => e.id));
    const map = new Map<string, string>();
    for (const e of oldList) {
      const hit = byKey.get(normKey(e.name));
      if (hit) {
        inherit(newList, hit, e);
        map.set(e.id, hit);
        continue;
      }
      let id = used.has(e.id) ? `${prefix}${used.size + 1}` : e.id;
      while (used.has(id)) id = `${id}_`;
      used.add(id);
      newList.push({ ...e, id });
      byKey.set(normKey(e.name), id);
      map.set(e.id, id);
    }
    return map;
  };
  // сущности добавляются в новую модель лениво: только те, на которые ссылаются перенесённые элементы
  const lazy = <T extends { id: string; name: string }>(oldList: T[], newList: T[], prefix: string) => {
    const byKey = new Map(newList.map((e) => [normKey(e.name), e.id] as const));
    const map = new Map<string, string>();
    return (oldId: string): string | undefined => {
      if (map.has(oldId)) return map.get(oldId);
      const e = oldList.find((x) => x.id === oldId);
      if (!e) return undefined;
      const hit = byKey.get(normKey(e.name));
      if (hit) {
        inherit(newList, hit, e);
        map.set(oldId, hit);
        return hit;
      }
      const sub = mapEntities([e], newList, prefix);
      const id = sub.get(oldId)!;
      byKey.set(normKey(e.name), id);
      map.set(oldId, id);
      return id;
    };
  };
  // карточки переносятся всем сопоставленным записям, даже если ни один перенесённый шаг на них не ссылается
  for (const [oldList, newList] of [[prev.roles, model.roles], [prev.data, model.data], [prev.controls, model.controls], [prev.systems, model.systems]] as const) {
    const byKey = new Map((newList as { id: string; name: string }[]).map((e) => [normKey(e.name), e.id] as const));
    for (const e of oldList as { id: string; name: string }[]) {
      const hit = byKey.get(normKey(e.name));
      if (hit) inherit(newList as { id: string; name: string }[], hit, e);
    }
  }
  // карточки переносятся всем сопоставленным записям, даже если ни один перенесённый шаг на них не ссылается
  for (const [oldList, newList] of [[prev.roles, model.roles], [prev.data, model.data], [prev.controls, model.controls], [prev.systems, model.systems]] as const) {
    const byKey = new Map((newList as { id: string; name: string }[]).map((e) => [normKey(e.name), e.id] as const));
    for (const e of oldList as { id: string; name: string }[]) {
      const hit = byKey.get(normKey(e.name));
      if (hit) inherit(newList as { id: string; name: string }[], hit, e);
    }
  }
  const role = lazy(prev.roles, model.roles, "role");
  const data = lazy(prev.data, model.data, "data");
  const control = lazy(prev.controls, model.controls, "ctl");
  const system = lazy(prev.systems, model.systems, "sys");
  const mapIds = (ids: string[] | undefined, f: (id: string) => string | undefined) => [...new Set((ids ?? []).flatMap((id) => f(id) ?? []))];
  const union = (a: string[] = [], b: string[] = []) => [...new Set([...a, ...b])];

  // --- шаги ---
  const nodeKey = (n: ProcessNode) => `${n.type}|${normKey(n.name)}`;
  const nextByKey = new Map<string, ProcessNode>();
  for (const n of model.nodes) if (!nextByKey.has(nodeKey(n))) nextByKey.set(nodeKey(n), n);
  const nodeMap = new Map<string, string>(); // id прежнего шага → id в новой модели
  let matched = 0;
  for (const o of prev.nodes) {
    if (o.source.length === 0) continue; // ручные шаги — ниже
    const n = nextByKey.get(nodeKey(o));
    if (!n || [...nodeMap.values()].includes(n.id)) continue;
    nodeMap.set(o.id, n.id);
    matched++;
    n.layout = o.layout ?? n.layout;
    n.idef0_layout = o.idef0_layout ?? n.idef0_layout;
    if (o.note) n.note = o.note;
    n.tags = union(n.tags, o.tags);
    n.confirmed_by = union(n.confirmed_by, o.confirmed_by);
    n.requirement_ids = union(n.requirement_ids, o.requirement_ids);
    if (o.status === "confirmed" && o.confidence >= 1) {
      n.status = "confirmed";
      n.confidence = 1;
    }
  }

  // ручные шаги (и вложенные в них функции) переносятся целиком
  const manual = prev.nodes.filter((o) => o.source.length === 0);
  const usedIds = new Set(model.nodes.map((n) => n.id));
  for (const o of manual) {
    let id = o.id;
    while (usedIds.has(id)) id = `${id}m`;
    usedIds.add(id);
    nodeMap.set(o.id, id);
  }
  for (const o of manual) {
    // родитель декомпозиции должен остаться в модели, иначе функция «повиснет»
    if (o.idef0_parent && !nodeMap.has(o.idef0_parent)) continue;
    // шаг диаграммы BPMN операции остаётся при операции, которая сохранилась
    if (o.bpmn_scope && !nodeMap.has(o.bpmn_scope)) continue;
    model.nodes.push({
      ...o,
      id: nodeMap.get(o.id)!,
      bpmn_scope: o.bpmn_scope ? nodeMap.get(o.bpmn_scope)! : o.bpmn_scope,
      idef0_parent: o.idef0_parent ? nodeMap.get(o.idef0_parent)! : o.idef0_parent,
      role_id: o.role_id ? role(o.role_id) ?? null : o.role_id,
      inputs: mapIds(o.inputs, data),
      outputs: mapIds(o.outputs, data),
      control_data_ids: o.control_data_ids ? mapIds(o.control_data_ids, data) : undefined,
      controls: mapIds(o.controls, control),
      system_ids: mapIds(o.system_ids, system),
    });
  }
  const kept = model.nodes.length - next.nodes.length;
  const present = new Set(model.nodes.map((n) => n.id));

  // связи с участием ручных шагов
  const manualIds = new Set(manual.map((o) => o.id));
  for (const f of prev.flows) {
    if (!manualIds.has(f.from) && !manualIds.has(f.to)) continue;
    const from = nodeMap.get(f.from);
    const to = nodeMap.get(f.to);
    if (!from || !to || !present.has(from) || !present.has(to)) continue;
    if (model.flows.some((x) => x.from === from && x.to === to)) continue;
    let id = f.id;
    while (model.flows.some((x) => x.id === id)) id = `${id}m`;
    model.flows.push({ ...f, id, from, to } as ProcessFlow);
  }

  // атрибуты процесса, которых нет в тексте интервью
  model.process = {
    ...prev.process,
    goal: next.process.goal ?? prev.process.goal,
    trigger: next.process.trigger ?? prev.process.trigger,
    result: next.process.result ?? prev.process.result,
  };

  const nodeOrNull = (id: string) => (nodeMap.has(id) && present.has(nodeMap.get(id)!) ? nodeMap.get(id)! : undefined);
  model.raci = prev.raci.flatMap((r) => {
    const node = nodeOrNull(r.node_id);
    const rid = role(r.role_id);
    return node && rid ? [{ ...r, node_id: node, role_id: rid }] : [];
  });
  model.assignments = prev.assignments.flatMap((a) => {
    const rid = role(a.role_id);
    const node = a.node_id === null ? null : nodeOrNull(a.node_id);
    return rid && node !== undefined ? [{ ...a, node_id: node, role_id: rid }] : [];
  });
  model.requirements_links = prev.requirements_links.flatMap((l) => {
    const el = nodeOrNull(l.element_id);
    return el ? [{ ...l, element_id: el }] : [];
  });
  model.interfaces = prev.interfaces.flatMap((i) => {
    const did = data(i.data_id);
    return did ? [{ ...i, data_id: did }] : [];
  });
  model.respondents = prev.respondents.length ? prev.respondents : model.respondents;

  return { model, matched, kept };
}
