import type { Gap, ProcessLogicModel, ProcessNode } from "../types/model.js";

const UNCERTAINTY_MARKERS = ["обычно", "иногда", "если", "бывает", "как правило"];

function normName(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * Детерминированный движок выявления пробелов и противоречий (ФТ-4).
 * Правила полноты (4.1), противоречия (4.2), неявные ветвления (4.3),
 * приоритет + сформулированный вопрос (4.4).
 */
export function detectGaps(model: ProcessLogicModel): Gap[] {
  const gaps: Gap[] = [];
  let counter = 0;
  const add = (rule: string, priority: Gap["priority"], element_id: string | null, question: string, topic?: string) => {
    counter += 1;
    gaps.push({
      id: `gap${counter}`,
      rule,
      priority,
      element_id,
      question,
      status: "open",
      topic: topic ?? element_id ?? rule,
      asked_count: 0,
    });
  };

  const nodeById = new Map(model.nodes.map((n) => [n.id, n] as const));
  const dataById = new Map(model.data.map((d) => [d.id, d] as const));

  const outgoing = new Map<string, number>();
  const incoming = new Map<string, number>();
  for (const f of model.flows) {
    outgoing.set(f.from, (outgoing.get(f.from) ?? 0) + 1);
    incoming.set(f.to, (incoming.get(f.to) ?? 0) + 1);
  }

  // 4.1.a — у действия нет исполнителя
  for (const n of model.nodes) {
    if (n.type === "task" && !n.role_id) {
      add("missing_executor", "critical", n.id, `Кто выполняет действие «${n.name}»?`);
    }
  }

  // 4.1.b — у ветвления нет альтернативной ветки или условия
  for (const n of model.nodes) {
    if (n.type !== "gateway") continue;
    const outFlows = model.flows.filter((f) => f.from === n.id);
    const hasConditions = outFlows.some((f) => f.condition && f.condition.trim().length > 0);
    if (outFlows.length < 2) {
      add(
        "gateway_missing_branch",
        "important",
        n.id,
        `Какие варианты развития возможны в точке «${n.name}» и что происходит в каждом из них?`
      );
    } else if (!hasConditions) {
      add(
        "gateway_missing_condition",
        "important",
        n.id,
        `При каком условии выбирается каждый из вариантов в точке «${n.name}»?`
      );
    }
  }

  // 4.1.c — поток обрывается (тупик)
  for (const n of model.nodes) {
    const isEndEvent = n.type === "event" && (n.subtype === "end" || /заверш|оконч/iu.test(n.subtype ?? ""));
    if (isEndEvent) continue;
    if ((outgoing.get(n.id) ?? 0) === 0) {
      add(
        "dangling_flow",
        "critical",
        n.id,
        `Что происходит после «${n.name}»? Чем продолжается процесс или это его завершение?`
      );
    }
  }

  // 4.1.d — нет стартового / конечного события
  const hasStart = model.nodes.some((n) => n.type === "event" && n.subtype === "start");
  const hasEnd = model.nodes.some((n) => n.type === "event" && n.subtype === "end");
  if (!hasStart) {
    add("missing_start_event", "critical", null, "Что запускает процесс (какое событие или триггер)?", "process_trigger");
  }
  if (!hasEnd) {
    add("missing_end_event", "critical", null, "Чем процесс считается завершённым (какой результат)?", "process_result");
  }

  // 4.1.e — у функции IDEF0 нет управления или выхода (берём верхнеуровневые task/subprocess)
  for (const n of model.nodes) {
    if (n.type !== "task" && n.type !== "subprocess") continue;
    if (n.controls.length === 0) {
      add(
        "idef0_missing_control",
        "important",
        n.id,
        `Какими регламентами, правилами или нормативами регулируется выполнение действия «${n.name}»?`
      );
    }
    if (n.outputs.length === 0) {
      add(
        "idef0_missing_output",
        "important",
        n.id,
        `Что является результатом (выходом) действия «${n.name}»?`
      );
    }
  }

  // 4.1.f — документ создаётся, но не используется, и наоборот
  const producedBy = new Map<string, string[]>();
  const consumedBy = new Map<string, string[]>();
  for (const n of model.nodes) {
    for (const outId of n.outputs) {
      producedBy.set(outId, [...(producedBy.get(outId) ?? []), n.id]);
    }
    for (const inId of n.inputs) {
      consumedBy.set(inId, [...(consumedBy.get(inId) ?? []), n.id]);
    }
  }
  for (const d of model.data) {
    const produced = producedBy.get(d.id) ?? [];
    const consumed = consumedBy.get(d.id) ?? [];
    if (produced.length > 0 && consumed.length === 0) {
      add(
        "orphan_output_document",
        "desirable",
        produced[0],
        `Где и кем используется документ «${d.name}» после его создания?`
      );
    }
    if (consumed.length > 0 && produced.length === 0) {
      add(
        "orphan_input_document",
        "desirable",
        consumed[0],
        `Кто и на основании чего создаёт документ «${d.name}» до того, как он используется?`
      );
    }
  }

  // 4.2 — противоречия: разный исполнитель у похожих действий
  const byName = new Map<string, ProcessNode[]>();
  for (const n of model.nodes) {
    if (n.type !== "task") continue;
    const key = normName(n.name);
    byName.set(key, [...(byName.get(key) ?? []), n]);
  }
  for (const [, group] of byName) {
    if (group.length < 2) continue;
    const roles = new Set(group.map((n) => n.role_id).filter(Boolean));
    if (roles.size > 1) {
      add(
        "contradicting_executor",
        "important",
        group[0].id,
        `В интервью названы разные исполнители действия «${group[0].name}». Кто выполняет его на самом деле?`
      );
    }
  }

  // 4.3 — неявные ветвления по маркерам неопределённости
  for (const n of model.nodes) {
    if (n.type === "gateway") continue;
    const quote = n.source[0]?.quote ?? "";
    const lower = quote.toLowerCase();
    if (UNCERTAINTY_MARKERS.some((m) => lower.includes(m))) {
      add(
        "implicit_branch",
        "desirable",
        n.id,
        `Правильно ли понято, что «${n.name}» выполняется не во всех случаях? При каком условии это происходит, и что происходит иначе?`
      );
    }
  }

  return gaps;
}

export function gapPriorityWeight(p: Gap["priority"]): number {
  return p === "critical" ? 3 : p === "important" ? 2 : 1;
}

export function sortGapsByPriority(gaps: Gap[]): Gap[] {
  return [...gaps].sort((a, b) => gapPriorityWeight(b.priority) - gapPriorityWeight(a.priority));
}
