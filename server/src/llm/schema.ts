import { z } from "zod";
import type { ExtractionChunkResult, LLMFragmentInput } from "./types.js";

/**
 * Проверка ответа LLM на извлечение. Модель может вернуть что угодно: лишние поля, строки вместо чисел,
 * пропущенные массивы, выдуманные id фрагментов и цитаты, которых нет в тексте. Здесь ответ приводится
 * к ExtractionChunkResult: неверные элементы отбрасываются, ссылки на фрагменты исправляются, а элементы
 * с непроверенной цитатой получают низкую уверенность (становятся гипотезами).
 */

const str = z.preprocess((v) => (v === null || v === undefined ? undefined : String(v)), z.string());
const optStr = z.preprocess((v) => (v === null || v === undefined || v === "" ? null : String(v)), z.string().nullable()).optional();
const conf = z.preprocess((v) => (v === undefined || v === null || v === "" ? 0.5 : Number(v)), z.number().min(0).max(1).catch(0.5));
const names = z.preprocess((v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()) : []), z.array(z.string()));
const orderHint = z.preprocess((v) => Number(v), z.number().int());

const sourced = { source_fragment_id: str, quote: str.catch(""), confidence: conf };

const Role = z.object({ name: str, kind: z.enum(["internal", "external"]).catch("internal"), ...sourced });
const System = z.object({ name: str, ...sourced });
const Data = z.object({ name: str, kind: z.enum(["document", "data"]).catch("document"), ...sourced });
const Control = z.object({ name: str, kind: z.enum(["regulation", "rule", "norm"]).catch("rule"), ...sourced });
/** Операция процесса: этап, к которому относятся действия (node.operation_name). */
const Operation = z.object({ name: str, subprocess_name: optStr, role_name: optStr, ...sourced });
/** Подпроцесс — группа операций (уровень 0); спрашивается при глубине декомпозиции 2+. */
const Subprocess = z.object({ name: str, ...sourced });
const Node = z.object({
  type: z.enum(["task", "event", "gateway", "subprocess"]),
  subtype: optStr.transform((v) => v ?? undefined),
  name: str,
  operation_name: optStr,
  role_name: optStr,
  system_names: names,
  input_names: names,
  output_names: names,
  control_names: names,
  duration: optStr,
  frequency: optStr,
  condition_branches: z.array(z.object({ condition: str, next_hint: optStr.transform((v) => v ?? undefined) })).catch([]).optional(),
  order_hint: orderHint,
  ...sourced,
});
const Flow = z.object({ from_order_hint: orderHint, to_order_hint: orderHint, condition: optStr, source_fragment_id: str, quote: str.catch("") });
const Statement = z.object({ kind: z.enum(["problem", "proposal"]), text: str, source_fragment_id: str, quote: str.catch("") });

export interface ChunkCheck {
  /** Отброшено элементов, не прошедших проверку формы. */
  dropped: number;
  /** Цитат, не найденных в тексте фрагмента (элементы помечены низкой уверенностью). */
  unverified: number;
}

const norm = (s: string) => s.toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Цитата есть во фрагменте дословно или почти (≥ 70% слов цитаты встречаются во фрагменте). */
export function quoteMatches(quote: string, text: string): boolean {
  const q = norm(quote);
  const t = norm(text);
  if (!q) return false;
  if (t.includes(q)) return true;
  const words = q.split(" ").filter((w) => w.length > 2);
  if (words.length === 0) return false;
  const tw = new Set(t.split(" "));
  return words.filter((w) => tw.has(w)).length / words.length >= 0.7;
}

function parseList<S extends z.ZodTypeAny>(schema: S, raw: unknown, check: ChunkCheck): z.output<S>[] {
  if (!Array.isArray(raw)) return [];
  const out: z.output<S>[] = [];
  for (const item of raw) {
    const r = schema.safeParse(item);
    if (r.success) out.push(r.data);
    else check.dropped++;
  }
  return out;
}

/** Приводит сырой ответ LLM к ExtractionChunkResult и сверяет ссылки на фрагменты с текстом чанка. */
export function normalizeChunk(raw: unknown, fragments: LLMFragmentInput[]): { result: ExtractionChunkResult; check: ChunkCheck } {
  const check: ChunkCheck = { dropped: 0, unverified: 0 };
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const byId = new Map(fragments.map((f) => [f.id, f] as const));

  // ссылка на фрагмент: если id не из этого чанка — ищем фрагмент по цитате; цитата не найдена — уверенность снижается
  const fix = <T extends { source_fragment_id: string; quote: string; confidence?: number }>(item: T): T => {
    let fid = item.source_fragment_id;
    if (!byId.has(fid)) fid = fragments.find((f) => item.quote && quoteMatches(item.quote, f.text))?.id ?? fragments[0]?.id ?? fid;
    const ok = !!item.quote && byId.has(fid) && quoteMatches(item.quote, byId.get(fid)!.text);
    if (!ok) check.unverified++;
    return { ...item, source_fragment_id: fid, ...(item.confidence !== undefined && !ok ? { confidence: Math.min(item.confidence, 0.4) } : {}) };
  };

  const hints = (obj.process_hints && typeof obj.process_hints === "object" ? obj.process_hints : {}) as Record<string, unknown>;
  const hint = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);

  const result: ExtractionChunkResult = {
    roles: parseList(Role, obj.roles, check).map(fix),
    systems: parseList(System, obj.systems, check).map(fix),
    data: parseList(Data, obj.data, check).map(fix),
    controls: parseList(Control, obj.controls, check).map(fix),
    operations: parseList(Operation, obj.operations, check).map(fix),
    subprocesses: parseList(Subprocess, obj.subprocesses, check).map(fix),
    nodes: parseList(Node, obj.nodes, check).map(fix) as ExtractionChunkResult["nodes"],
    flows: parseList(Flow, obj.flows, check).map(fix),
    statements: parseList(Statement, obj.statements, check).map(fix),
    process_hints: { goal: hint(hints.goal), trigger: hint(hints.trigger), result: hint(hints.result) },
  };
  return { result, check };
}
