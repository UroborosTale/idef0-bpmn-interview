import { nanoid } from "nanoid";
import type { ProcessLogicModel, ProcessNode, ProcessFlow, Role, SystemEntity, DataEntity, ControlEntity, Discrepancy, DiscrepancyKind, SourceRef } from "../types/model.js";
import { emptyModel, SCHEMA_VERSION } from "../types/model.js";
import type { SessionMeta } from "../repo.js";

function normKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

interface TrackInput {
  trackId: string;
  respondentId: string;
  respondentName: string;
  weight: number;
  model: ProcessLogicModel;
}

interface EntityAcc<T extends { id: string; name: string }> {
  byKey: Map<string, T>;
}
function mergeEntityList<T extends { id: string; name: string }>(
  lists: { prefix: string; items: T[] }[],
  makeMerged: (id: string, first: T) => T
): { merged: T[]; remap: Map<string, Map<string, string>> } {
  // remap[trackPrefix] : localId -> mergedId
  const acc: EntityAcc<T> = { byKey: new Map() };
  const remap = new Map<string, Map<string, string>>();
  let counter = 0;
  for (const { prefix, items } of lists) {
    const localMap = new Map<string, string>();
    remap.set(prefix, localMap);
    for (const item of items) {
      const key = normKey(item.name);
      let merged = acc.byKey.get(key);
      if (!merged) {
        counter += 1;
        merged = makeMerged(`m${counter}`, item);
        acc.byKey.set(key, merged);
      }
      localMap.set(item.id, merged.id);
    }
  }
  return { merged: [...acc.byKey.values()], remap };
}

function remapIds(ids: string[], map: Map<string, string>): string[] {
  return [...new Set(ids.map((id) => map.get(id) ?? id))];
}

const GENERIC_QUESTIONS: Record<DiscrepancyKind, (name: string, variants: string[]) => string> = {
  step_presence: (name, variants) => `Шаг «${name}» упомянул(и) не все респонденты (${variants.join(", ")}) — этот шаг действительно выполняется всегда, или это особый случай?`,
  executor: (name, variants) => `Кто на самом деле выполняет шаг «${name}»? Варианты из интервью: ${variants.join("; ")}.`,
  timing: (name, variants) => `Какова фактическая длительность/срок шага «${name}»? Варианты из интервью: ${variants.join("; ")}.`,
  step_order: (name, variants) => `В каком порядке на самом деле выполняются шаги: ${name}? Респонденты описали это по-разному: ${variants.join("; ")}.`,
};

/**
 * ФТ-М4.1.2/4.1.3: сводит модели, извлечённые независимо из нескольких
 * "дорожек" интервью (по одной на респондента), в единую PLM. Совпадающие
 * по нормализованному имени элементы объединяются, каждый хранит список
 * подтвердивших респондентов (confirmed_by). Расхождения (наличие шага,
 * исполнитель, сроки, порядок) фиксируются в discrepancies с вариантами,
 * цитатами и сгенерированным вопросом для разрешения (4.1.4).
 * Вес респондента (ФТ-М4.1.5) определяет, какой вариант становится
 * рабочим значением модели при конфликте — расхождение при этом всё
 * равно остаётся зафиксированным для явного разрешения аналитиком.
 */
export function mergeTracks(inputs: TrackInput[], meta: SessionMeta, processId: string): { model: ProcessLogicModel; discrepancies: Discrepancy[] } {
  if (inputs.length === 0) {
    return { model: emptyModel({ id: processId, name: meta.processName }), discrepancies: [] };
  }

  const { merged: roles, remap: roleRemap } = mergeEntityList<Role>(
    inputs.map((t) => ({ prefix: t.trackId, items: t.model.roles })),
    (id, first) => ({ ...first, id })
  );
  const { merged: systems, remap: sysRemap } = mergeEntityList<SystemEntity>(
    inputs.map((t) => ({ prefix: t.trackId, items: t.model.systems })),
    (id, first) => ({ ...first, id })
  );
  const { merged: data, remap: dataRemap } = mergeEntityList<DataEntity>(
    inputs.map((t) => ({ prefix: t.trackId, items: t.model.data })),
    (id, first) => ({ ...first, id })
  );
  const { merged: controls, remap: ctlRemap } = mergeEntityList<ControlEntity>(
    inputs.map((t) => ({ prefix: t.trackId, items: t.model.controls })),
    (id, first) => ({ ...first, id })
  );

  // группы узлов по нормализованному имени: каждая группа — один "реальный" шаг
  interface NodeVariant {
    node: ProcessNode;
    trackId: string;
    respondentId: string;
    respondentName: string;
    weight: number;
  }
  const nodeGroups = new Map<string, NodeVariant[]>();
  const nodeLocalToGroupKey = new Map<string, Map<string, string>>(); // trackId -> localNodeId -> groupKey

  for (const t of inputs) {
    const localMap = new Map<string, string>();
    nodeLocalToGroupKey.set(t.trackId, localMap);
    for (const n of t.model.nodes) {
      const key = normKey(n.name);
      localMap.set(n.id, key);
      const arr = nodeGroups.get(key) ?? [];
      arr.push({ node: n, trackId: t.trackId, respondentId: t.respondentId, respondentName: t.respondentName, weight: t.weight });
      nodeGroups.set(key, arr);
    }
  }

  const discrepancies: Discrepancy[] = [];
  const mergedNodes: ProcessNode[] = [];
  const nodeGroupToMergedId = new Map<string, string>();
  let nodeCounter = 0;

  const remapId = (kind: "role" | "sys" | "data" | "ctl", trackId: string, localId: string | null | undefined): string | null => {
    if (!localId) return null;
    const map = kind === "role" ? roleRemap : kind === "sys" ? sysRemap : kind === "data" ? dataRemap : ctlRemap;
    return map.get(trackId)?.get(localId) ?? localId;
  };
  const remapIdList = (kind: "sys" | "data" | "ctl", trackId: string, ids: string[]): string[] => {
    const map = kind === "sys" ? sysRemap : kind === "data" ? dataRemap : ctlRemap;
    const local = map.get(trackId);
    if (!local) return ids;
    return remapIds(ids, local);
  };

  for (const [key, variants] of nodeGroups) {
    nodeCounter += 1;
    const mergedId = `n${nodeCounter}`;
    nodeGroupToMergedId.set(key, mergedId);

    // выбираем "рабочий" вариант по наибольшему весу респондента (при равенстве — первый)
    const primary = [...variants].sort((a, b) => b.weight - a.weight)[0];
    const primaryRoleId = remapId("role", primary.trackId, primary.node.role_id);

    const confirmedBy = [...new Set(variants.map((v) => v.respondentId))];
    const source: SourceRef[] = variants.flatMap((v) => v.node.source);

    // расхождение "исполнитель": разные респонденты называют разную роль.
    // Один респондент может дать НЕСКОЛЬКО вариантов узла в своей дорожке
    // (например, экстрактор разбивает описание на несколько предложений) —
    // среди них предпочитаем вариант с указанной ролью, а не первый/последний
    // попавшийся, иначе пустой вариант молча затирает информативный.
    const roleVariantsByRespondent = new Map<string, string>();
    for (const v of variants) {
      const rid = remapId("role", v.trackId, v.node.role_id);
      const roleName = rid ? roles.find((r) => r.id === rid)?.name ?? rid : null;
      const existing = roleVariantsByRespondent.get(v.respondentId);
      if (roleName && (!existing || existing === "не указан")) {
        roleVariantsByRespondent.set(v.respondentId, roleName);
      } else if (!existing) {
        roleVariantsByRespondent.set(v.respondentId, "не указан");
      }
    }
    const distinctRoleNames = new Set(roleVariantsByRespondent.values());
    if (distinctRoleNames.size > 1) {
      discrepancies.push({
        id: `disc_${nanoid(8)}`,
        element_id: mergedId,
        kind: "executor",
        question: GENERIC_QUESTIONS.executor(primary.node.name, [...roleVariantsByRespondent.entries()].map(([rid, role]) => `${variants.find((v) => v.respondentId === rid)?.respondentName ?? rid}: ${role}`)),
        variants: variants.map((v) => ({
          respondent_id: v.respondentId,
          value: roleVariantsByRespondent.get(v.respondentId) ?? "—",
          source: v.node.source,
        })),
        status: "open",
        resolved_value: null,
      });
    }

    // расхождение "сроки": разные значения duration (тот же принцип — не
    // затирать информативный вариант респондента пустым).
    const durationByRespondent = new Map<string, string>();
    for (const v of variants) {
      if (v.node.duration && !durationByRespondent.has(v.respondentId)) {
        durationByRespondent.set(v.respondentId, v.node.duration);
      }
    }
    if (new Set(durationByRespondent.values()).size > 1) {
      discrepancies.push({
        id: `disc_${nanoid(8)}`,
        element_id: mergedId,
        kind: "timing",
        question: GENERIC_QUESTIONS.timing(primary.node.name, [...durationByRespondent.entries()].map(([rid, d]) => `${variants.find((v) => v.respondentId === rid)?.respondentName ?? rid}: ${d}`)),
        variants: [...durationByRespondent.entries()].map(([rid, value]) => ({
          respondent_id: rid,
          value,
          source: variants.find((v) => v.respondentId === rid)?.node.source ?? [],
        })),
        status: "open",
        resolved_value: null,
      });
    }

    mergedNodes.push({
      ...primary.node,
      id: mergedId,
      role_id: primaryRoleId,
      system_ids: remapIdList("sys", primary.trackId, primary.node.system_ids),
      inputs: remapIdList("data", primary.trackId, primary.node.inputs),
      outputs: remapIdList("data", primary.trackId, primary.node.outputs),
      controls: remapIdList("ctl", primary.trackId, primary.node.controls),
      source,
      confirmed_by: confirmedBy,
    });
  }

  // ФТ-М4.1.3 "наличие шага": узел с ролью R подтверждён не всеми респондентами,
  // которые в своих дорожках описывали ДРУГИЕ шаги с той же ролью R —
  // то есть респондент явно говорил "от лица" этой роли, но пропустил шаг.
  if (inputs.length > 1) {
    const respondentNodeRoleKeys = new Map<string, Set<string>>(); // respondentId -> set of role merged ids they ever assigned
    for (const t of inputs) {
      for (const n of t.model.nodes) {
        const rid = remapId("role", t.trackId, n.role_id);
        if (!rid) continue;
        const set = respondentNodeRoleKeys.get(t.respondentId) ?? new Set();
        set.add(rid);
        respondentNodeRoleKeys.set(t.respondentId, set);
      }
    }
    for (const [key, variants] of nodeGroups) {
      const mergedId = nodeGroupToMergedId.get(key)!;
      const node = mergedNodes.find((n) => n.id === mergedId)!;
      if (!node.role_id) continue;
      const confirmedRespondents = new Set(variants.map((v) => v.respondentId));
      const expectedRespondents = [...respondentNodeRoleKeys.entries()]
        .filter(([, roleSet]) => roleSet.has(node.role_id!))
        .map(([rid]) => rid);
      const missing = expectedRespondents.filter((rid) => !confirmedRespondents.has(rid));
      if (missing.length > 0 && expectedRespondents.length > 1) {
        const allNames = inputs.filter((t) => confirmedRespondents.has(t.respondentId)).map((t) => t.respondentName);
        discrepancies.push({
          id: `disc_${nanoid(8)}`,
          element_id: mergedId,
          kind: "step_presence",
          question: GENERIC_QUESTIONS.step_presence(node.name, allNames),
          variants: [
            ...variants.map((v) => ({ respondent_id: v.respondentId, value: "упомянул(а)", source: v.node.source })),
            ...missing.map((rid) => ({ respondent_id: rid, value: "не упомянул(а)", source: [] })),
          ],
          status: "open",
          resolved_value: null,
        });
      }
    }
  }

  // потоки: remap + дедуп по паре узлов, объединяя confirmed_by
  const flowByPair = new Map<string, ProcessFlow & { respondents: Set<string> }>();
  for (const t of inputs) {
    const localNodeMap = nodeLocalToGroupKey.get(t.trackId)!;
    for (const f of t.model.flows) {
      const fromKey = localNodeMap.get(f.from);
      const toKey = localNodeMap.get(f.to);
      if (!fromKey || !toKey) continue;
      const fromId = nodeGroupToMergedId.get(fromKey);
      const toId = nodeGroupToMergedId.get(toKey);
      if (!fromId || !toId || fromId === toId) continue;
      const pairKey = `${fromId}->${toId}`;
      let existing = flowByPair.get(pairKey);
      if (!existing) {
        existing = { id: `flow${flowByPair.size + 1}`, from: fromId, to: toId, condition: f.condition, source: [], confirmed_by: [], respondents: new Set() };
        flowByPair.set(pairKey, existing);
      }
      existing.source.push(...f.source);
      existing.respondents.add(t.respondentId);
    }
  }
  const mergedFlows: ProcessFlow[] = [...flowByPair.values()].map((f) => ({
    id: f.id,
    from: f.from,
    to: f.to,
    condition: f.condition,
    source: f.source,
    confirmed_by: [...f.respondents],
  }));

  // ФТ-М4.1.3 "порядок шагов": противоречивое направление между одной парой узлов
  const seenPairs = new Set<string>();
  for (const f of mergedFlows) {
    const pairKey = [f.from, f.to].sort().join("|");
    if (seenPairs.has(pairKey)) continue;
    seenPairs.add(pairKey);
    const reverse = mergedFlows.find((g) => g.from === f.to && g.to === f.from);
    if (reverse) {
      const fromName = mergedNodes.find((n) => n.id === f.from)?.name ?? f.from;
      const toName = mergedNodes.find((n) => n.id === f.to)?.name ?? f.to;
      const respNames = (ids: string[]) => ids.map((id) => inputs.find((t) => t.respondentId === id)?.respondentName ?? id).join(", ");
      discrepancies.push({
        id: `disc_${nanoid(8)}`,
        element_id: f.id,
        kind: "step_order",
        question: GENERIC_QUESTIONS.step_order(`«${fromName}» → «${toName}»`, [
          `${respNames(f.confirmed_by)}: сначала «${fromName}», затем «${toName}»`,
          `${respNames(reverse.confirmed_by)}: сначала «${toName}», затем «${fromName}»`,
        ]),
        variants: [
          { respondent_id: f.confirmed_by[0] ?? "—", value: `${fromName} → ${toName}`, source: f.source },
          { respondent_id: reverse.confirmed_by[0] ?? "—", value: `${toName} → ${fromName}`, source: reverse.source },
        ],
        status: "open",
        resolved_value: null,
      });
    }
  }

  const first = inputs[0].model;
  const model: ProcessLogicModel = {
    schema_version: SCHEMA_VERSION,
    process: { ...first.process, id: processId, name: meta.processName },
    roles,
    systems,
    data,
    controls,
    nodes: mergedNodes,
    flows: mergedFlows,
    gaps: [],
    statements: inputs.flatMap((t) => t.model.statements),
    interfaces: [],
    requirements_links: [],
    raci: [],
    respondents: inputs.map((t) => ({ id: t.respondentId, name: t.respondentName, role_id: null, session_ids: [t.trackId], weight: t.weight })),
    discrepancies,
  };

  return { model, discrepancies };
}
