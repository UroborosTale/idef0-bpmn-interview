import { quoteMatches } from "../llm/schema.js";
import type { PatchError, PatchOp } from "../shared/patch.js";
import type { Fragment } from "../types/model.js";

/**
 * Цитаты в предложениях агента: если у новой записи указан источник (source: [{fragment_id, quote}]), фрагмент должен
 * существовать, а цитата — быть в его тексте дословно или почти (так же проверяется извлечение из текста). Выдуманные
 * цитаты в предложения не попадают: трассировка к интервью должна быть настоящей.
 */
export function sourceErrors(ops: PatchOp[], fragments: Fragment[]): PatchError[] {
  const byId = new Map(fragments.map((f) => [f.id, f] as const));
  const errors: PatchError[] = [];
  ops.forEach((op, index) => {
    const fields = op.op === "add" ? op.value : op.op === "update" ? op.patch : undefined;
    const source = (fields as { source?: unknown } | undefined)?.source;
    if (source === undefined) return;
    if (!Array.isArray(source)) {
      errors.push({ index, message: "source — список источников [{fragment_id, quote}]" });
      return;
    }
    for (const s of source as { fragment_id?: unknown; quote?: unknown }[]) {
      const fid = typeof s?.fragment_id === "string" ? s.fragment_id : "";
      const quote = typeof s?.quote === "string" ? s.quote : "";
      const fragment = byId.get(fid);
      if (!fragment) errors.push({ index, message: `источник: фрагмента «${fid}» нет в интервью (список — get_fragments)` });
      else if (!quote.trim() || !quoteMatches(quote, fragment.text)) errors.push({ index, message: `источник: цитаты «${quote.slice(0, 60)}» нет во фрагменте ${fid}` });
    }
  });
  return errors;
}