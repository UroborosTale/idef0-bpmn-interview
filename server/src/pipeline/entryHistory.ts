import type { ProcessLogicModel } from "../types/model.js";

type M = ProcessLogicModel;

export type HistoryKind = "roles" | "systems" | "data" | "controls" | "kpi" | "risks" | "node";
export const HISTORY_KINDS: HistoryKind[] = ["roles", "systems", "data", "controls", "kpi", "risks", "node"];

export interface HistoryChange {
  field: string;
  from: string | null;
  to: string | null;
}

export interface HistoryEvent {
  seq: number;
  version: string;
  ts: string;
  author: string;
  note: string;
  event: "created" | "changed" | "removed";
  changes: HistoryChange[];
}

/** Поля записи, изменения которых попадают в историю. */
const FIELDS: Record<HistoryKind, string[]> = {
  roles: ["name", "kind", "owner", "qualification", "description"],
  systems: ["name", "owner", "description"],
  data: ["name", "kind", "supplier", "consumer", "value", "quality_standard", "owner", "description"],
  controls: ["name", "kind", "reference", "owner", "description"],
  kpi: ["name", "target", "unit", "period", "owner", "description"],
  risks: ["name", "mitigation", "level", "owner", "description"],
  node: ["name", "type", "role_id", "duration", "note"],
};

type Rec = Record<string, unknown>;

function find(m: M, kind: HistoryKind, id: string): Rec | undefined {
  const list: Rec[] =
    kind === "roles" ? m.roles : kind === "systems" ? m.systems : kind === "data" ? m.data : kind === "controls" ? m.controls : kind === "kpi" ? m.process.kpi : kind === "risks" ? m.process.risks : m.nodes;
  return list.find((x) => x.id === id);
}

/** Значение поля для показа: пустое — null, исполнитель шага — по названию из той же версии модели. */
function shown(m: M, field: string, rec: Rec): string | null {
  const v = rec[field];
  if (v == null || v === "") return null;
  if (field === "role_id") return m.roles.find((r) => r.id === v)?.name ?? String(v);
  return String(v);
}

/**
 * История записи справочника (или шага) по сохранённым версиям модели: когда появилась, что и в какой
 * версии менялось, когда удалена. Версии идут по возрастанию seq; версии без изменений записи пропускаются.
 */
export function entryHistory(versions: { seq: number; version: string; ts: string; author: string; note: string; model: M }[], kind: HistoryKind, id: string): HistoryEvent[] {
  const out: HistoryEvent[] = [];
  let prev: { m: M; rec: Rec } | undefined;
  for (const v of versions) {
    const rec = find(v.model, kind, id);
    const base = { seq: v.seq, version: v.version, ts: v.ts, author: v.author, note: v.note };
    if (rec && !prev) {
      out.push({ ...base, event: "created", changes: [] });
    } else if (!rec && prev) {
      out.push({ ...base, event: "removed", changes: [] });
    } else if (rec && prev) {
      const changes: HistoryChange[] = [];
      for (const f of FIELDS[kind]) {
        const from = shown(prev.m, f, prev.rec);
        const to = shown(v.model, f, rec);
        if (from !== to) changes.push({ field: f, from, to });
      }
      if (changes.length) out.push({ ...base, event: "changed", changes });
    }
    prev = rec ? { m: v.model, rec } : undefined;
  }
  return out;
}
