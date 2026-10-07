import { nanoid } from "nanoid";
import type { Fragment, ProcessLogicModel, ProcessNode, Role, SystemEntity, DataEntity, ControlEntity, ProcessFlow, Statement } from "../types/model.js";
import { SCHEMA_VERSION } from "../types/model.js";
import type { LLMProvider, LLMFragmentInput, ExtractionChunkResult } from "../llm/types.js";
import { normalizeChunk } from "../llm/schema.js";
import { withLlmContext } from "../llm/usage.js";

export const CHUNK_SIZE = 18;

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
  const statements: Statement[] = [];

  let goal = opts.metaGoal;
  let trigger = opts.metaTrigger;
  let result = opts.metaResult;

  let globalOrder = 0;
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
        { processName: opts.processName, modelType: opts.modelType, fewShotContext: ci === 0 ? opts.fewShotContext : undefined },
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
        status: n.confidence >= 0.6 ? "confirmed" : "hypothesis",
        confidence: n.confidence,
        source: [{ fragment_id: n.source_fragment_id, quote: n.quote }],
        requirement_ids: [],
        tags: [],
        confirmed_by: [],
      };
      nodes.push(node);
      orderToNodeId.set(n.order_hint, nodeId);

      if (n.condition_branches && n.condition_branches.length > 0) {
        node.subtype = node.subtype || "exclusive";
      }
    }

    for (const fl of chunkResult.flows ?? []) {
      const from = orderToNodeId.get(fl.from_order_hint);
      const to = orderToNodeId.get(fl.to_order_hint);
      if (!from || !to) continue;
      flows.push({
        id: `flow${flows.length + 1}`,
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

  // Резервная линейная связка узлов там, где явные flow отсутствуют, чтобы поток не обрывался даже
  // при неполном извлечении связей. Такие связи без источника (source: []) — их видно как выведенные.
  // Из конечного события и в начальное связь не ведётся: это заведомо ложный поток.
  for (let i = 0; i < nodes.length - 1; i++) {
    const a = nodes[i];
    const b = nodes[i + 1];
    if (a.type === "event" && a.subtype === "end") continue;
    if (b.type === "event" && b.subtype === "start") continue;
    if (!flows.some((f) => f.from === a.id)) {
      flows.push({ id: `flow${flows.length + 1}`, from: a.id, to: b.id, condition: null, source: [], confirmed_by: [] });
    }
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
    respondents: [],
    discrepancies: [],
  };

  return model;
}

export function newId(prefix: string): string {
  return `${prefix}_${nanoid(8)}`;
}
