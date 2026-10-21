import { nanoid } from "nanoid";
import type { Fragment, ProcessLogicModel, ProcessNode, Role, SystemEntity, DataEntity, ControlEntity, ProcessFlow, Statement } from "../types/model.js";
import { SCHEMA_VERSION } from "../types/model.js";
import type { LLMProvider, LLMFragmentInput, ExtractionChunkResult } from "../llm/types.js";
import { normalizeChunk } from "../llm/schema.js";
import { withLlmContext } from "../llm/usage.js";

/** Сколько фрагментов уходит в один вызов LLM. Переопределяется PM_CHUNK_SIZE (например, 1000 — считать документ целиком). */
export const CHUNK_SIZE = Number(process.env.PM_CHUNK_SIZE) || 18;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Ключ сущности для склейки упоминаний: регистр, «ё», пунктуация и падежные окончания не различаются —
 * «договор», «договора» и «Договор:» — одна сущность. Отображаемое имя — первое упоминание.
 */
const ENDING = /(ами|ями|ого|его|ому|ему|ыми|ими|ой|ей|ом|ем|ам|ям|ах|ях|ов|ев|ую|юю|ая|яя|ое|ее|ые|ие|ый|ий|а|я|ы|и|у|ю|е|о)$/;
export function normKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .map((w) => (w.length >= 5 ? w.replace(ENDING, "") : w))
    .join(" ");
}

/**
 * Название события из подсказки «что запускает / чем завершается»: убираем служебную рамку и по возможности
 * приводим первое слово к отглагольному существительному («после получения заявки» → «Получение заявки»).
 */
function eventNameFromHint(text: string, kind: "start" | "end"): string {
  let core = text
    .replace(/^.*?(?:запускается|начинается|стартует|инициируется|триггер\w*\s*[—:-]\s*|завершается|заканчивается|результат\w*\s*[—:-]\s*)/iu, "")
    .trim()
    .replace(/^(после|при|когда|с|со|от)\s+/iu, "")
    .replace(/[.;].*$/u, "")
    .trim();
  core = core
    .replace(/^([а-яё]{4,})(?:ия|ием)(?=\s|$)/iu, (_, w: string) => `${w}ие`)
    .replace(/^([а-яё]{4,})ей(?=\s|$)/iu, (_, w: string) => `${w}а`);
  if (!core) return kind === "start" ? "Начало процесса" : "Завершение процесса";
  return core.charAt(0).toUpperCase() + core.slice(1);
}

/** Что пошло не так при извлечении — показывается аналитику в проверках модели. */
export interface ExtractionReport {
  failedChunks: { index: number; fragmentIds: string[]; error: string }[];
  /** Элементы ответа LLM неверной формы (отброшены). */
  dropped: number;
  /** Элементы с цитатой, которой нет в тексте (стали гипотезами). */
  unverified: number;
}

interface EntityIndex<T extends { id: string; name: string }> {
  byKey: Map<string, T>;
  list: T[];
}

function makeIndex<T extends { id: string; name: string }>(): EntityIndex<T> {
  return { byKey: new Map(), list: [] };
}

function upsert<T extends { id: string; name: string; source: any[] }>(
  idx: EntityIndex<T>,
  name: string,
  prefix: string,
  extra: Omit<T, "id" | "name" | "source">,
  source: { fragment_id: string; quote: string }
): T {
  const key = normKey(name);
  const existing = idx.byKey.get(key);
  if (existing) {
    existing.source.push(source);
    return existing;
  }
  const entity = { id: `${prefix}${idx.list.length + 1}`, name: name.trim(), source: [source], ...extra } as T;
  idx.byKey.set(key, entity);
  idx.list.push(entity);
  return entity;
}

export interface ExtractProgress {
  chunkIndex: number;
  totalChunks: number;
}

export async function extractModel(
  fragments: Fragment[],
  provider: LLMProvider,
  opts: {
    processId: string;
    processName: string;
    modelType: "AS-IS" | "TO-BE";
    metaGoal?: string;
    metaTrigger?: string;
    metaResult?: string;
    department?: string;
    owner?: string;
    decompositionDepth?: number;
    onProgress?: (p: ExtractProgress) => void;
    llmModel?: string; // ФТ-М9.2.4: модель LLM, назначенная агенту-извлекателю
    fewShotContext?: string; // ФТ-М9.1.2: похожие утверждённые примеры из корпуса
    report?: ExtractionReport;
  }
): Promise<ProcessLogicModel> {
  // расход токенов записывается на сессию (processId — id сессии)
  return withLlmContext(opts.processId, () => extractModelImpl(fragments, provider, opts));
}

async function extractModelImpl(fragments: Fragment[], provider: LLMProvider, opts: Parameters<typeof extractModel>[2]): Promise<ProcessLogicModel> {
  const factFragments = fragments; // интервьюер тоже передаётся как контекст (правило 3 промпта)
  const chunks = chunk(factFragments, CHUNK_SIZE);

  const roles = makeIndex<Role>();
  const systems = makeIndex<SystemEntity>();
  const data = makeIndex<DataEntity>();
  const controls = makeIndex<ControlEntity>();
  const nodes: ProcessNode[] = [];
  const flows: ProcessFlow[] = [];
  const usedFlowIds = new Set<string>();
  const nextFlowId = () => {
    let n = flows.length + 1;
    while (usedFlowIds.has(`flow${n}`)) n++;
    usedFlowIds.add(`flow${n}`);
    return `flow${n}`;
  };
  const statements: Statement[] = [];
  // Операции процесса (ФТ-3): блоки IDEF0, у каждого своя диаграмма BPMN из действий с operation_name.
  const opByKey = new Map<string, ProcessNode>();
  const opSteps = new Map<string, string[]>(); // id операции → id её действий
  const opOrder = new Map<string, number>(); // id операции → порядок первого действия
  // Подпроцессы (глубина декомпозиции 2+): блоки уровня 0, операции становятся их детьми.
  const subByKey = new Map<string, ProcessNode>();
  const opSubName = new Map<string, string>(); // id операции → название подпроцесса из ответа LLM

  const newFunctionNode = (id: string, name: string, source: { fragment_id: string; quote: string }, confidence: number): ProcessNode => ({
    id,
    type: "task",
    name: name.trim(),
    role_id: null,
    system_ids: [],
    inputs: [],
    outputs: [],
    controls: [],
    duration: null,
    frequency: null,
    idef0_parent: null,
    bpmn_scope: null,
    status: confidence >= 0.6 ? "confirmed" : "hypothesis",
    confidence,
    source: [source],
    requirement_ids: [],
    tags: [],
    confirmed_by: [],
  });

  const ensureSubprocess = (name: string, source: { fragment_id: string; quote: string }, confidence: number): ProcessNode => {
    const key = normKey(name);
    const known = subByKey.get(key);
    if (known) {
      known.source.push(source);
      return known;
    }
    const sub = newFunctionNode(`sp${subByKey.size + 1}`, name, source, confidence);
    subByKey.set(key, sub);
    return sub;
  };

  const ensureOperation = (name: string, source: { fragment_id: string; quote: string }, confidence: number): ProcessNode => {
    const key = normKey(name);
    const known = opByKey.get(key);
    if (known) {
      known.source.push(source);
      return known;
    }
    const op = newFunctionNode(`op${opByKey.size + 1}`, name, source, confidence);
    opByKey.set(key, op);
    opSteps.set(op.id, []);
    return op;
  };

  let goal = opts.metaGoal;
  let trigger = opts.metaTrigger;
  let result = opts.metaResult;

  let globalOrder = 0;
  // Глубина декомпозиции из паспорта: 2+ — операции группируются в подпроцессы, 1 — только операции процесса.
  const depth = Math.max(1, opts.decompositionDepth ?? 2);
  const report: ExtractionReport = opts.report ?? { failedChunks: [], dropped: 0, unverified: 0 };

  for (let ci = 0; ci < chunks.length; ci++) {
    const c = chunks[ci];
    const llmInput: LLMFragmentInput[] = c.map((f) => ({
      id: f.id,
      speaker: f.speaker,
      speaker_label: f.speaker_label,
      text: f.text,
    }));

    let chunkResult: ExtractionChunkResult;
    try {
      const raw = await provider.extractChunk(
        llmInput,
        { processName: opts.processName, modelType: opts.modelType, fewShotContext: ci === 0 ? opts.fewShotContext : undefined, decompositionDepth: depth },
        { model: opts.llmModel }
      );
      // ответ LLM не доверяем: проверяем форму и сверяем цитаты с текстом
      const normalized = normalizeChunk(raw, llmInput);
      chunkResult = normalized.result;
      report.dropped += normalized.check.dropped;
      report.unverified += normalized.check.unverified;
    } catch (err) {
      console.warn(`извлечение: часть ${ci + 1} из ${chunks.length} не обработана — ${(err as Error).message}`);
      report.failedChunks.push({ index: ci, fragmentIds: c.map((f) => f.id), error: (err as Error).message });
      opts.onProgress?.({ chunkIndex: ci + 1, totalChunks: chunks.length });
      continue;
    }

    if (!goal && chunkResult.process_hints?.goal) goal = chunkResult.process_hints.goal;
    if (!trigger && chunkResult.process_hints?.trigger) trigger = chunkResult.process_hints.trigger;
    if (!result && chunkResult.process_hints?.result) result = chunkResult.process_hints.result;

    for (const r of chunkResult.roles ?? []) {
      upsert(roles, r.name, "role", { kind: r.kind } as any, { fragment_id: r.source_fragment_id, quote: r.quote });
    }
    for (const s of chunkResult.systems ?? []) {
      upsert(systems, s.name, "sys", {} as any, { fragment_id: s.source_fragment_id, quote: s.quote });
    }
    for (const d of chunkResult.data ?? []) {
      upsert(data, d.name, "data", { kind: d.kind } as any, { fragment_id: d.source_fragment_id, quote: d.quote });
    }
    for (const ctl of chunkResult.controls ?? []) {
      upsert(controls, ctl.name, "ctl", { kind: ctl.kind } as any, { fragment_id: ctl.source_fragment_id, quote: ctl.quote });
    }

    // map order_hint (chunk-local) -> node id, для последующей сборки flows
    const orderToNodeId = new Map<number, string>();

    // подпроцессы и операции этого чанка: создаём блоки раньше действий, чтобы они шли перед своими действиями
    for (const s of chunkResult.subprocesses ?? []) {
      ensureSubprocess(s.name, { fragment_id: s.source_fragment_id, quote: s.quote }, s.confidence);
    }
    for (const o of chunkResult.operations ?? []) {
      const op = ensureOperation(o.name, { fragment_id: o.source_fragment_id, quote: o.quote }, o.confidence);
      if (o.role_name) {
        const role = upsert(roles, o.role_name, "role", { kind: "internal" } as any, {
          fragment_id: o.source_fragment_id,
          quote: o.quote,
        });
        op.role_id = role.id;
      }
      // принадлежность операции подпроцессу: разворачивается на глубине 2+ (по Соглашению глубже функций нет)
      if (depth >= 2 && o.subprocess_name && !opSubName.has(op.id)) opSubName.set(op.id, o.subprocess_name);
    }

    for (const n of chunkResult.nodes ?? []) {
      globalOrder += 1;
      const nodeId = `n${globalOrder}`;
      const role = n.role_name
        ? upsert(roles, n.role_name, "role", { kind: "internal" } as any, {
            fragment_id: n.source_fragment_id,
            quote: n.quote,
          })
        : null;
      const inputIds = (n.input_names ?? []).map(
        (dn) => upsert(data, dn, "data", { kind: "document" } as any, { fragment_id: n.source_fragment_id, quote: n.quote }).id
      );
      const outputIds = (n.output_names ?? []).map(
        (dn) => upsert(data, dn, "data", { kind: "document" } as any, { fragment_id: n.source_fragment_id, quote: n.quote }).id
      );
      const systemIds = (n.system_names ?? []).map(
        (sn) => upsert(systems, sn, "sys", {} as any, { fragment_id: n.source_fragment_id, quote: n.quote }).id
      );
      const controlIds = (n.control_names ?? []).map(
        (cn) => upsert(controls, cn, "ctl", { kind: "rule" } as any, { fragment_id: n.source_fragment_id, quote: n.quote }).id
      );

      // действие принадлежит операции — его диаграмме BPMN; операции без действия остаются на общей схеме
      const op = n.operation_name ? ensureOperation(n.operation_name, { fragment_id: n.source_fragment_id, quote: n.quote }, n.confidence) : null;
      const node: ProcessNode = {
        id: nodeId,
        type: n.type,
        subtype: n.subtype,
        name: n.name,
        role_id: role?.id ?? null,
        system_ids: systemIds,
        inputs: inputIds,
        outputs: outputIds,
        controls: controlIds,
        duration: n.duration ?? null,
        frequency: n.frequency ?? null,
        idef0_parent: null,
        bpmn_scope: op?.id ?? null,
        status: n.confidence >= 0.6 ? "confirmed" : "hypothesis",
        confidence: n.confidence,
        source: [{ fragment_id: n.source_fragment_id, quote: n.quote }],
        requirement_ids: [],
        tags: [],
        confirmed_by: [],
      };
      nodes.push(node);
      orderToNodeId.set(n.order_hint, nodeId);
      if (op) {
        opSteps.get(op.id)!.push(nodeId);
        const prev = opOrder.get(op.id);
        if (prev === undefined || globalOrder < prev) opOrder.set(op.id, globalOrder);
      }

      if (n.condition_branches && n.condition_branches.length > 0) {
        node.subtype = node.subtype || "exclusive";
      }
    }

    for (const fl of chunkResult.flows ?? []) {
      const from = orderToNodeId.get(fl.from_order_hint);
      const to = orderToNodeId.get(fl.to_order_hint);
      if (!from || !to) continue;
      flows.push({
        id: nextFlowId(),
        from,
        to,
        condition: fl.condition ?? null,
        source: [{ fragment_id: fl.source_fragment_id, quote: fl.quote }],
        confirmed_by: [],
      });
    }

    for (const st of chunkResult.statements ?? []) {
      statements.push({
        id: `st${statements.length + 1}`,
        kind: st.kind,
        text: st.text,
        source: [{ fragment_id: st.source_fragment_id, quote: st.quote }],
      });
    }

    opts.onProgress?.({ chunkIndex: ci + 1, totalChunks: chunks.length });
  }

  if (chunks.length > 0 && report.failedChunks.length === chunks.length) {
    throw new Error(`LLM не обработал ни одного фрагмента: ${report.failedChunks[0].error}`);
  }

  // Операция без собственной роли получает самого частого исполнителя своих шагов, а шаги без роли наследуют роль
  // операции: LLM часто называет исполнителя один раз на этап, и без этого шаги оставались «без исполнителя» (D4).
  const nodeById = new Map(nodes.map((n) => [n.id, n] as const));
  for (const op of opByKey.values()) {
    if (op.role_id) continue;
    const counts = new Map<string, number>();
    for (const id of opSteps.get(op.id) ?? []) {
      const rid = nodeById.get(id)?.role_id;
      if (rid) counts.set(rid, (counts.get(rid) ?? 0) + 1);
    }
    let best: string | null = null;
    let bestCount = 0;
    for (const [rid, c] of counts) if (c > bestCount) (best = rid), (bestCount = c);
    if (best) op.role_id = best;
  }
  for (const n of nodes) if (n.bpmn_scope && !n.role_id) n.role_id = opByKey.get(n.bpmn_scope)?.role_id ?? null;
  // F4: если исполнитель назван у соседнего шага той же операции, но не у этого, не оставляем его без роли.
  // Берём соседа только при единственной роли вокруг — иначе разные исполнители означают настоящее ветвление.
  const neighbors = new Map<string, Set<string>>();
  for (const f of flows) {
    const a = nodeById.get(f.from);
    const b = nodeById.get(f.to);
    if (!a || !b || a.bpmn_scope !== b.bpmn_scope || !a.bpmn_scope) continue;
    if (a.role_id) (neighbors.get(b.id) ?? neighbors.set(b.id, new Set()).get(b.id)!).add(a.role_id);
    if (b.role_id) (neighbors.get(a.id) ?? neighbors.set(a.id, new Set()).get(a.id)!).add(b.role_id);
  }
  for (const n of nodes) {
    if (!n.bpmn_scope || n.role_id) continue;
    const around = neighbors.get(n.id);
    if (around?.size === 1) n.role_id = [...around][0];
  }

  // Триггер и результат, названные в тексте, дают настоящие стартовое и конечное события. Это закрывает вопросы
  // «что запускает процесс» после ответа владельца (B3) и не оставляет офлайн-модель без событий (B1).
  const sourceOfHint = (hint: string) => {
    const fact = fragments.find((f) => f.text.includes(hint)) ?? fragments.find((f) => f.speaker === "owner" || f.speaker === "participant") ?? fragments[0];
    return { fragment_id: fact?.id ?? "f1", quote: hint };
  };
  const eventNode = (kind: "start" | "end", hint: string): ProcessNode => {
    const source = sourceOfHint(hint);
    return {
      id: `${kind === "start" ? "ev_start" : "ev_end"}_${hint.length}`,
      type: "event",
      subtype: kind,
      name: eventNameFromHint(hint, kind),
      role_id: null,
      system_ids: [],
      inputs: [],
      outputs: [],
      controls: [],
      duration: null,
      frequency: null,
      idef0_parent: null,
      bpmn_scope: null,
      status: "confirmed",
      confidence: 0.6,
      source: [source],
      requirement_ids: [],
      tags: [],
      confirmed_by: [],
    };
  };
  if (trigger && !nodes.some((n) => n.type === "event" && n.subtype === "start")) nodes.unshift(eventNode("start", trigger));
  if (result && !nodes.some((n) => n.type === "event" && n.subtype === "end")) nodes.push(eventNode("end", result));

  // Связи из конечного события и в начальное — заведомо ложные; LLM иногда соединяет два результата подряд (D5).
  const nodeByIdNow = new Map(nodes.map((n) => [n.id, n] as const));
  const saneFlows = flows.filter((f) => {
    const from = nodeByIdNow.get(f.from);
    const to = nodeByIdNow.get(f.to);
    if (!from || !to || from.id === to.id) return false;
    if (from.type === "event" && from.subtype === "end") return false;
    if (to.type === "event" && to.subtype === "start") return false;
    return true;
  });
  flows.length = 0;
  flows.push(...saneFlows);

  // Резервная линейная связка узлов там, где явные flow отсутствуют, чтобы поток не обрывался даже
  // при неполном извлечении связей. Такие связи без источника (source: []) — их видно как выведенные.
  // Из конечного события и в начальное связь не ведётся: это заведомо ложный поток.
  for (let i = 0; i < nodes.length - 1; i++) {
    const a = nodes[i];
    const b = nodes[i + 1];
    if (a.type === "event" && a.subtype === "end") continue;
    if (b.type === "event" && b.subtype === "start") continue;
    if (!flows.some((f) => f.from === a.id)) {
      // связь с событием — не выведенная: у неё есть источник, иначе сборка структуры отбросит её как «плоскую»
      const source = a.type === "event" ? a.source : b.type === "event" ? b.source : [];
      flows.push({ id: nextFlowId(), from: a.id, to: b.id, condition: null, source, confirmed_by: [] });
    }
  }

  // F1: внутри операции не должно быть разорванных шагов. Если LLM не вернул ни одной внутренней связи,
  // выстраиваем шаги операции в порядке извлечения — иначе диаграмма операции открывается без потока.
  for (const ids of opSteps.values()) {
    if (ids.length < 2) continue;
    if (flows.some((f) => ids.includes(f.from) && ids.includes(f.to))) continue;
    for (let i = 0; i < ids.length - 1; i++) {
      const from = nodes.find((n) => n.id === ids[i]);
      const to = nodes.find((n) => n.id === ids[i + 1]);
      flows.push({ id: nextFlowId(), from: ids[i], to: ids[i + 1], condition: null, source: from?.source ?? to?.source ?? [], confirmed_by: [] });
    }
  }

  // F1: шлюз или событие, связанные только с шагами одной операции, принадлежат её диаграмме, а не общей схеме.
  // Два прохода — чтобы конечное событие за шлюзом тоже получило область после назначения шлюза.
  const stepOwner = new Map<string, string>();
  for (const [opId, ids] of opSteps) for (const id of ids) stepOwner.set(id, opId);
  for (let pass = 0; pass < 2; pass++) {
    for (const n of nodes) {
      if (n.bpmn_scope || n.idef0_parent || n.type === "task" || n.type === "subprocess") continue;
      if (n.type === "event" && n.subtype === "start") continue;
      // выведенная линейная связка (source: []) не говорит, к какой операции относится шлюз:
      // она просто соединяет соседей по порядку и часто тянется из другой операции
      const touching = flows.filter((f) => f.source.length > 0 && (f.from === n.id || f.to === n.id));
      const around = touching.map((f) => nodeById.get(f.from === n.id ? f.to : f.from)).filter((x): x is ProcessNode => !!x);
      // не забираем в операцию шлюз на стыке с блоком общей схемы или со стартом процесса: тогда поток
      // операции начинался бы из несуществующего на её диаграмме узла
      if (around.some((x) => ((x.type === "task" || x.type === "subprocess") && !x.bpmn_scope) || (x.type === "event" && x.subtype === "start"))) continue;
      const owners = new Set(
        touching
          .map((f) => stepOwner.get(f.from === n.id ? f.to : f.from))
          .filter((x): x is string => !!x)
      );
      if (owners.size !== 1) continue;
      const opId = [...owners][0];
      n.bpmn_scope = opId;
      const ownerRole = opByKey.get(opId)?.role_id;
      const stepRole = opSteps.get(opId)?.map((id) => nodeById.get(id)?.role_id).find((r): r is string => !!r);
      n.role_id = ownerRole ?? stepRole ?? null;
      opSteps.get(opId)?.push(n.id);
      stepOwner.set(n.id, opId);
    }
  }

  // Сборка структуры (ФТ-3): операции становятся блоками общей схемы, а связи между действиями разных операций —
  // связями операций, тогда как сами действия остаются внутри диаграммы своей операции (bpmn_scope).
  // Без операций (короткий процесс или офлайн-экстрактор) модель остаётся плоской, как раньше.
  // Операция без действий блоком не становится: LLM иногда называет операцией само действие — иначе на общей схеме
  // появляются пустые блоки-дубликаты действий (видно на живом прогоне интервью).
  const usedOps = [...opByKey.values()].filter((op) => (opSteps.get(op.id) ?? []).length > 0);
  if (usedOps.length > 0) {
    // Глубина 2+: операции с подпроцессом становятся его детьми (уровень 1), подпроцесс — блоком уровня 0.
    // Подпроцесс с единственной операцией уровень не создаёт: лишний слой без содержания.
    const usedSubIds = new Set<string>();
    for (const op of usedOps) {
      const subName = opSubName.get(op.id);
      if (!subName) continue;
      const key = normKey(subName);
      const sub = subByKey.get(key);
      if (!sub) continue;
      const siblings = usedOps.filter((o) => { const n = opSubName.get(o.id); return !!n && normKey(n) === key; });
      if (siblings.length < 2) continue;
      op.idef0_parent = sub.id;
      usedSubIds.add(sub.id);
    }

    const scopeOf = new Map<string, string>();
    for (const [opId, stepIds] of opSteps) for (const s of stepIds) scopeOf.set(s, opId);
    const owner = (id: string) => scopeOf.get(id) ?? id;
    const kept: ProcessFlow[] = [];
    const seen = new Set<string>();
    for (const f of flows) {
      const a = owner(f.from);
      const b = owner(f.to);
      // связь внутри одной операции (или внутри общей схемы) остаётся между шагами; связь уровня операций — как есть
      if (a === b || ((a === f.from && b === f.to) && !scopeOf.has(f.from) && !scopeOf.has(f.to))) {
        kept.push(f);
        continue;
      }
      // выведенная связка плоской модели (source: []) между разными операциями не переносится: она была нужна,
      // чтобы не распадался плоский поток, а у операций будет своя связь (ниже, по порядку действий)
      if (f.source.length === 0) continue;
      const key = `${a}|${b}|${f.condition ?? ""}`;
      if (seen.has(key)) continue; // одно и то же направление между операциями — одной связью
      seen.add(key);
      kept.push({ ...f, from: a, to: b });
    }
    flows.length = 0;
    flows.push(...kept);

    // операции, у которых не осталось ни одной связи, выстраиваем в порядке их действий: общая схема не должна распадаться
    const wired = new Set<string>();
    for (const f of flows) {
      wired.add(f.from);
      wired.add(f.to);
    }
    const ordered = [...usedOps].sort((a, b) => (opOrder.get(a.id) ?? 0) - (opOrder.get(b.id) ?? 0));
    for (let i = 0; i < ordered.length - 1; i++) {
      if (wired.has(ordered[i].id)) continue;
      flows.push({ id: nextFlowId(), from: ordered[i].id, to: ordered[i + 1].id, condition: null, source: [], confirmed_by: [] });
    }
    for (const sub of subByKey.values()) if (usedSubIds.has(sub.id)) nodes.push(sub);
    for (const op of usedOps) nodes.push(op);
  }

  const model: ProcessLogicModel = {
    schema_version: SCHEMA_VERSION,
    process: {
      id: opts.processId,
      name: opts.processName,
      owner: opts.owner,
      department: opts.department,
      type: opts.modelType,
      goal,
      trigger,
      result,
      decomposition_depth: opts.decompositionDepth ?? 2,
      notations: ["IDEF0", "BPMN"],
      version: "0.1",
      status: "draft",
      kpi: [],
      risks: [],
    },
    roles: roles.list,
    systems: systems.list,
    data: data.list,
    controls: controls.list,
    nodes,
    flows,
    gaps: [],
    statements,
    interfaces: [],
    requirements_links: [],
    raci: [],
    assignments: [],
    pools: [],
    messages: [],
    accepted_issues: [],
    respondents: [],
    discrepancies: [],
  };

  return model;
}

export function newId(prefix: string): string {
  return `${prefix}_${nanoid(8)}`;
}
