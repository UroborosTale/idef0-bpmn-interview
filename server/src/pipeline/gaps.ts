import type { Gap, ProcessLogicModel, ProcessNode } from "../types/model.js";

const UNCERTAINTY_MARKERS = ["обычно", "иногда", "если", "бывает", "как правило"];

function normName(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * Отметить отвеченные пробелы по журналу ответов (`session.qa`): повторная обработка строит пробелы заново,
 * у них другие id, поэтому сверяем по тексту вопроса — он у одного и того же пробела не меняется.
 */
export function applyAnsweredGaps(model: ProcessLogicModel, answers: { question: string; answerText: string }[]): number {
  if (answers.length === 0) return 0;
  const normQ = (s: string) => s.trim().toLowerCase().replace(/[«»"']/g, "").replace(/\s+/g, " ").replace(/[?!.]+$/, "");
  const entries = answers.map((a) => ({ key: normQ(a.question), answer: a.answerText }));
  const exact = new Map(entries.map((e) => [e.key, e.answer] as const));
  let n = 0;
  for (const g of model.gaps) {
    const key = normQ(g.question);
    let answer = exact.get(key);
    // имя шага могло измениться при пересборке — сравниваем вопросы по основе, а не по точному тексту
    if (answer === undefined) {
      answer = entries.find((e) => {
        if (key.length < 10 || e.key.length < 10) return false;
        const shorter = Math.min(key.length, e.key.length);
        const longer = Math.max(key.length, e.key.length);
        return (key.includes(e.key) || e.key.includes(key)) && shorter / longer >= 0.6;
      })?.answer;
    }
    if (answer === undefined) continue;
    const wasOpen = g.status !== "answered";
    g.status = "answered";
    g.answer = answer;
    if (wasOpen) n++;
    // ответ «кто выполняет» сразу назначает исполнителя, а не ждёт следующего извлечения
    if (g.rule === "missing_executor" && g.element_id) {
      const node = model.nodes.find((x) => x.id === g.element_id);
      if (node && !node.role_id) {
        const lower = answer.toLowerCase();
        const norm = (s: string) => s.trim().toLowerCase().replace(/[«»"']/g, "");
        const role = model.roles.find((r) => lower.includes(norm(r.name))) ?? model.roles.find((r) => norm(r.name).split(" ").every((w) => lower.includes(w)));
        if (role) node.role_id = role.id;
      }
    }
  }
  return n;
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

  // Узел с декомпозицией (дети по IDEF0 или шаги операции): исполнитель и продолжение
  // описаны внутри — на верхнем уровне их не спрашиваем, иначе пробелы ложные.
  const hasChildren = new Set<string>();
  for (const n of model.nodes) {
    if (n.idef0_parent) hasChildren.add(n.idef0_parent);
    if (n.bpmn_scope) hasChildren.add(n.bpmn_scope);
  }

  const outgoing = new Map<string, number>();
  const incoming = new Map<string, number>();
  for (const f of model.flows) {
    outgoing.set(f.from, (outgoing.get(f.from) ?? 0) + 1);
    incoming.set(f.to, (incoming.get(f.to) ?? 0) + 1);
  }

  // 4.1.a — у действия нет исполнителя (если есть декомпозиция, исполнитель задан в шагах)
  for (const n of model.nodes) {
    if (n.type === "task" && !n.role_id && !hasChildren.has(n.id)) {
      add("missing_executor", "critical", n.id, `Кто выполняет действие «${n.name}»?`);
    }
  }

  // 4.1.b — у ветвления нет условия. Слияние (один выход) и проходной шлюз пробелом не считаем:
  // отсутствие выхода ловит 4.1.c, а «альтернативная ветка» у слияния не нужна.
  for (const n of model.nodes) {
    if (n.type !== "gateway") continue;
    // параллельный шлюз и шлюз по событию ветвятся без условий: условия задают ветки, а не сам факт ветвления
    if (n.subtype === "parallel" || n.subtype === "event_based") continue;
    const outFlows = model.flows.filter((f) => f.from === n.id);
    if (outFlows.length < 2) continue;
    const hasConditions = outFlows.some((f) => f.condition && f.condition.trim().length > 0);
    if (!hasConditions) {
      add(
        "gateway_missing_condition",
        "important",
        n.id,
        `При каком условии выбирается каждый из вариантов в точке «${n.name}»?`
      );
    }
  }

  // 4.1.c — поток обрывается (тупик); у функции с декомпозицией продолжение описано внутри
  for (const n of model.nodes) {
    if (hasChildren.has(n.id)) continue;
    // событие-ссылка не имеет исходящего потока: продолжение — парное событие с тем же именем
    if (n.type === "event" && n.trigger?.type === "link") continue;
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

  // 4.1.e — у функции IDEF0 нет управления или выхода.
  // Правило только для функций IDEF0: у шагов BPMN (bpmn_scope) управление и результат — потоки и данные,
  // а не ICOM-стрелки, поэтому пустые controls/outputs у них пробелом не являются.
  for (const n of model.nodes) {
    if (n.type !== "task" && n.type !== "subprocess") continue;
    if (n.bpmn_scope) continue;
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
    // внешний потребитель/поставщик продукта — не пробел: продукт уходит из процесса или приходит извне
    if (produced.length > 0 && consumed.length === 0 && !d.consumer) {
      add(
        "orphan_output_document",
        "desirable",
        produced[0],
        `Где и кем используется документ «${d.name}» после его создания?`
      );
    }
    if (consumed.length > 0 && produced.length === 0 && !d.supplier) {
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
