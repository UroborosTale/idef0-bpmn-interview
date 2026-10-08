import type { ProcessLogicModel, ValidationIssue } from "../types/model.js";
import { idef0Codes, functionsOf as idef0Functions } from "./idef0Layout.js";
import { bpmnHosts, functionDepth, isStructured, parseProcessCode } from "./codes.js";
import { isBoundaryNode } from "./bpmnArtifacts.js";
import { TRIGGER_LABELS, eventSpec, triggerGaps, triggerProblem, triggerSummary } from "./events.js";
import { FUNCTION_CODE, blockKey, hasVerbalNoun, looksLikeFact, normalizeCode } from "./rules.js";

/**
 * Детерминированная валидация BPMN (5.1) и IDEF0 (5.2) + стиль наименований (5.3).
 * Ошибки (error) — модель некорректна (мешают завершить интервью), предупреждения (warning) — рекомендации.
 * Экспорт диаграмм доступен в обоих случаях.
 */
/** Пары «выбросил ссылку → принимает ссылку» по одинаковому имени (без учёта регистра) среди событий диаграммы. */
export function linkPairs(nodes: { id: string; type: string; subtype?: string | null; trigger?: unknown; attached_to?: string | null }[]): [string, string][] {
  const links = nodes.filter((n) => n.type === "event").map((n) => ({ id: n.id, spec: eventSpec(n as never, false) })).filter((x) => x.spec.trigger === "link" && x.spec.details.name?.trim());
  const key = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();
  return links.filter((t) => t.spec.throwing).flatMap((t) => links.filter((c) => !c.spec.throwing && key(c.spec.details.name) === key(t.spec.details.name)).map((c) => [t.id, c.id] as [string, string]));
}

export function validateModel(model: Omit<ProcessLogicModel, "gaps">): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  let counter = 0;
  const add = (
    notation: ValidationIssue["notation"],
    severity: ValidationIssue["severity"],
    rule: string,
    message: string,
    element_id: string | null
  ) => {
    counter += 1;
    issues.push({ id: `val${counter}`, notation, severity, rule, message, element_id });
  };

  const codes = idef0Codes(model);
  const nodeById = new Map(model.nodes.map((n) => [n.id, n] as const));

  // Проверки BPMN идут по диаграммам: общая схема процесса (узлы без bpmn_scope) и диаграмма каждой операции.
  // Диаграмма процесса не включает детали декомпозиции IDEF0 (узлы с idef0_parent): их нет в BPMN,
  // поэтому и проверки потока (старт, конец, тупики, достижимость) относятся только к остальным узлам.
  const scopeIds = [...new Set(model.nodes.map((n) => n.bpmn_scope).filter((s): s is string => !!s))];
  const bpmnScopes: (string | null)[] = [null, ...scopeIds];
  for (const scope of bpmnScopes) {
    const where = scope ? `[${codes.get(scope) ?? scope}] ` : "";
    const bpmnNodes = model.nodes.filter((n) => (scope === null ? !n.idef0_parent && !n.bpmn_scope : n.bpmn_scope === scope));
    if (scope === null && bpmnNodes.length === 0 && scopeIds.length > 0) continue; // схема процесса пуста, зато есть диаграммы операций
    checkBpmn(where, bpmnNodes);
  }

  function checkBpmn(where: string, bpmnNodes: typeof model.nodes) {
  const bpmnIds = new Set(bpmnNodes.map((n) => n.id));
  const bpmnFlows = model.flows.filter((f) => bpmnIds.has(f.from) && bpmnIds.has(f.to));
  const outAdj = new Map<string, string[]>();
  const inCount = new Map<string, number>();
  for (const f of bpmnFlows) {
    outAdj.set(f.from, [...(outAdj.get(f.from) ?? []), f.to]);
    inCount.set(f.to, (inCount.get(f.to) ?? 0) + 1);
  }
  // события-ссылки: выбросивший ссылку «продолжает» поток у принимающего с тем же именем — это невидимая стрелка
  for (const [from, to] of linkPairs(bpmnNodes)) {
    outAdj.set(from, [...(outAdj.get(from) ?? []), to]);
    inCount.set(to, (inCount.get(to) ?? 0) + 1);
  }
  // --- BPMN 5.1 ---
  // Генератор диаграмм (bpmn.ts) сам достраивает начало и конец, если явных событий нет:
  // начало ведёт в узлы без входящих стрелок, конец — из узлов без исходящих. Поэтому
  // отсутствие явных событий — не ошибка, пока у процесса есть точка входа и выхода.
  // Проверки ниже должны оставаться согласованными с этой логикой.
  const startNodes = bpmnNodes.filter((n) => n.type === "event" && n.subtype === "start");
  const endNodes = bpmnNodes.filter((n) => n.type === "event" && n.subtype === "end");
  // граничное событие достижимо через свою задачу: у него нет входящих стрелок, но это не точка входа процесса
  const boundary = bpmnNodes.filter((n) => isBoundaryNode(n, bpmnNodes));
  const boundaryIds = new Set(boundary.map((n) => n.id));
  const reachAdj = new Map(outAdj);
  for (const b of boundary) reachAdj.set(b.attached_to!, [...(reachAdj.get(b.attached_to!) ?? []), b.id]);
  const entryNodes = bpmnNodes.filter((n) => (inCount.get(n.id) ?? 0) === 0 && !boundaryIds.has(n.id));
  const exitNodes = bpmnNodes.filter((n) => (outAdj.get(n.id) ?? []).length === 0);

  if (bpmnNodes.length === 0) {
    add("BPMN", "error", "bpmn_no_start", `${where}В модели нет ни одного элемента — нечего показывать на диаграмме.`, null);
  } else {
    if (startNodes.length === 0 && entryNodes.length === 0) {
      add("BPMN", "error", "bpmn_no_start", `${where}Нет точки входа: у каждого шага есть входящая стрелка (процесс замкнут). Добавьте начальное событие.`, null);
    }
    if (endNodes.length === 0 && exitNodes.length === 0) {
      add("BPMN", "error", "bpmn_no_end", `${where}Нет точки выхода: у каждого шага есть продолжение (процесс зациклен). Добавьте конечное событие.`, null);
    }
  }

  // недостижимые узлы: BFS от стартовых узлов (или от узлов без входящих связей, если старт не задан явно).
  // Без точки входа проверка бессмысленна — об этом уже сообщено выше.
  const roots = startNodes.length > 0 ? startNodes.map((n) => n.id) : entryNodes.map((n) => n.id);
  const reached = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (reached.has(cur)) continue;
    reached.add(cur);
    for (const next of reachAdj.get(cur) ?? []) queue.push(next);
  }
  if (roots.length > 0) {
    for (const n of bpmnNodes) {
      if (!reached.has(n.id)) {
        add("BPMN", "error", "bpmn_unreachable_node", `${where}Узел «${n.name}» недостижим из стартового события.`, n.id);
      }
    }
  }

  // тупики: узел без исходящих связей, не являющийся конечным событием. Если конечных событий
  // в модели нет, такие узлы — естественные концы процесса (к ним достраивается конец).
  if (endNodes.length > 0) {
    for (const n of bpmnNodes) {
      if (n.type === "event" && n.subtype === "end") continue;
      if (boundaryIds.has(n.id)) continue; // у граничного события свои правила (bpmn_boundary_no_outgoing)
      if ((outAdj.get(n.id) ?? []).length === 0) {
        add("BPMN", "error", "bpmn_dead_end", `${where}Узел «${n.name}» не имеет продолжения (тупик потока): ведите стрелку дальше или к конечному событию.`, n.id);
      }
    }
  }

  // парные шлюзы: шлюз с 1 входом и 1 выходом — вероятно, лишний / не сбалансирован
  for (const n of bpmnNodes) {
    if (n.type !== "gateway") continue;
    const outs = (outAdj.get(n.id) ?? []).length;
    const ins = inCount.get(n.id) ?? 0;
    if (outs <= 1 && ins <= 1) {
      add("BPMN", "warning", "bpmn_gateway_unbalanced", `${where}Шлюз «${n.name}» не разветвляет и не объединяет поток — проверьте необходимость.`, n.id);
    }
  }

  // простая проверка на возможный livelock: цикл без выхода
  const visited = new Set<string>();
  const stack = new Set<string>();
  function dfs(id: string, path: string[]): void {
    if (stack.has(id)) {
      const cycle = path.slice(path.indexOf(id));
      const hasExit = cycle.some((cid) => (reachAdj.get(cid) ?? []).some((t) => !cycle.includes(t)));
      if (!hasExit) {
        add(
          "BPMN",
          "warning",
          "bpmn_possible_livelock",
          `${where}Обнаружен цикл без выхода: ${cycle.map((cid) => nodeById.get(cid)?.name ?? cid).join(" → ")}.`,
          id
        );
      }
      return;
    }
    if (visited.has(id)) return;
    visited.add(id);
    stack.add(id);
    for (const next of reachAdj.get(id) ?? []) dfs(next, [...path, id]);
    stack.delete(id);
  }
  for (const n of bpmnNodes) dfs(n.id, []);

  // --- граничные события ---
  for (const n of bpmnNodes) {
    if (n.type !== "event" || !n.attached_to || boundaryIds.has(n.id)) continue;
    add("BPMN", "warning", "bpmn_boundary_no_host", `${where}Граничное событие «${n.name}» прикреплено к задаче, которой нет на этой диаграмме: прикрепите его к задаче или подпроцессу.`, n.id);
  }
  for (const b of boundary) {
    if ((inCount.get(b.id) ?? 0) > 0) add("BPMN", "error", "bpmn_boundary_incoming", `${where}В граничное событие «${b.name}» ведёт стрелка — граничное событие только начинает ветку, входящих стрелок у него нет.`, b.id);
    if ((outAdj.get(b.id) ?? []).length === 0) add("BPMN", "warning", "bpmn_boundary_no_outgoing", `${where}У граничного события «${b.name}» нет продолжения: проведите стрелку к шагу, который выполняется при его наступлении.`, b.id);
  }

  // --- триггеры событий ---
  const linkThrow = new Map<string, string>();
  const linkCatch = new Set<string>();
  for (const n of bpmnNodes) {
    if (n.type !== "event") continue;
    const spec = eventSpec(n, boundaryIds.has(n.id));
    const problem = triggerProblem(spec);
    if (spec.position === "boundary" && spec.trigger === "none" && boundaryIds.has(n.id)) {
      add("BPMN", "warning", "bpmn_boundary_no_trigger", `${where}У граничного события «${n.name}» не выбран триггер: укажите, что его запускает — таймер, сообщение, ошибка…`, n.id);
    } else if (problem) {
      add("BPMN", "error", "bpmn_event_trigger_invalid", `${where}Событие «${n.name}»: ${problem}.`, n.id);
    } else if (n.trigger) {
      // замечания о незаполненных параметрах — только у событий, где триггер задан явно (прежние записи без параметров не трогаем)
      const gaps = triggerGaps(spec);
      if (gaps.length > 0) add("BPMN", "warning", "bpmn_event_trigger_incomplete", `${where}Событие «${n.name}» (${TRIGGER_LABELS[spec.trigger].toLowerCase()}): ${gaps.join("; ")}.`, n.id);
    }
    if (spec.trigger === "link" && spec.details.name?.trim()) {
      if (spec.throwing) linkThrow.set(n.id, spec.details.name.trim().toLowerCase());
      else linkCatch.add(spec.details.name.trim().toLowerCase());
    }
  }
  const throwNames = new Set(linkThrow.values());
  for (const [id, name] of linkThrow) {
    if (!linkCatch.has(name)) add("BPMN", "warning", "bpmn_link_unpaired", `${where}Событие «${nodeById.get(id)!.name}» переходит по ссылке «${name}», но на этой диаграмме нет события, которое эту ссылку принимает.`, id);
  }
  for (const n of bpmnNodes) {
    if (n.type !== "event") continue;
    const spec = eventSpec(n, boundaryIds.has(n.id));
    const name = spec.details.name?.trim().toLowerCase();
    if (spec.trigger === "link" && !spec.throwing && name && !throwNames.has(name)) {
      add("BPMN", "warning", "bpmn_link_unpaired", `${where}Событие «${n.name}» принимает ссылку «${name}», но на этой диаграмме нет события, которое по ней переходит.`, n.id);
    }
  }

  // --- правила Соглашения о моделировании (только для модели со структурным кодом процесса) ---
  if (isStructured(model)) {
    const byId = new Map(bpmnNodes.map((n) => [n.id, n] as const));
    const insOf = (id: string) => bpmnFlows.filter((f) => f.to === id).map((f) => byId.get(f.from)).filter((x): x is (typeof bpmnNodes)[number] => !!x);
    const outsOf = (id: string) => bpmnFlows.filter((f) => f.from === id);
    // шлюз слияния (несколько входов, один выход) решения не принимает: смотрим, что стоит перед ним
    const sourcesBefore = (id: string, seen = new Set<string>()): (typeof bpmnNodes) => {
      if (seen.has(id)) return [];
      seen.add(id);
      return insOf(id).flatMap((s) => (s.type === "gateway" && insOf(s.id).length >= 2 && outsOf(s.id).length === 1 ? sourcesBefore(s.id, seen) : [s]));
    };
    const kindName = (n: { type: string }) => ({ event: "событие", gateway: "шлюз" }[n.type] ?? "элемент");
    for (const n of bpmnNodes) {
      if (n.type === "gateway") {
        const exclusive = !n.subtype || n.subtype === "exclusive";
        if (exclusive && outsOf(n.id).length >= 2) {
          for (const src of sourcesBefore(n.id).filter((s) => s.type !== "task" && s.type !== "subprocess")) {
            add("BPMN", "warning", "bpmn_xor_after_task", `${where}Перед развилкой «${n.name}» должна стоять задача (в ней принимается решение), а стоит ${kindName(src)} «${src.name}».`, n.id);
          }
        }
        continue;
      }
      if (boundaryIds.has(n.id)) continue;
      if (outsOf(n.id).length >= 2) add("BPMN", "warning", "bpmn_split_without_gateway", `${where}Поток из «${n.name}» разветвляется без шлюза — добавьте шлюз (XOR, AND или OR).`, n.id);
      const isEnd = n.type === "event" && n.subtype === "end";
      if (!isEnd && insOf(n.id).length >= 2) add("BPMN", "warning", "bpmn_merge_without_gateway", `${where}В «${n.name}» потоки сходятся без шлюза — объедините их шлюзом.`, n.id);
      // событие — это свершившийся факт: «Получена заявка», а не «Заявка» или «Получить заявку»
      if (n.type === "event" && eventSpec(n, false).trigger !== "timer" && n.name.trim() && !/^[\d\s\p{P}]+$/u.test(n.name) && !looksLikeFact(n.name)) {
        add("BPMN", "warning", "bpmn_event_not_fact", `${where}Событие «${n.name}» нужно сформулировать как факт, который произошёл (например: «Заявка получена»).`, n.id);
      }
    }
  }
  }

  // --- IDEF0 5.2 ---
  // 3–6 блоков на диаграмме: одно замечание на диаграмму с подсказкой, как исправить
  const fnOf = (parent: string | null) => model.nodes.filter((n) => (n.type === "task" || n.type === "subprocess") && !n.bpmn_scope && (n.idef0_parent ?? null) === parent);
  const topLevel = fnOf(null);
  if (topLevel.length > 6) {
    add("IDEF0", "warning", "idef0_block_count", `На A0 ${topLevel.length} функций — по правилам IDEF0 рекомендуется 3–6. Объедините близкие шаги: в редакторе IDEF0 создайте укрупнённую функцию и перенесите шаги в её декомпозицию.`, null);
  } else if (topLevel.length > 0 && topLevel.length < 3) {
    add("IDEF0", "warning", "idef0_block_count", `На A0 ${topLevel.length} функции — по правилам IDEF0 рекомендуется 3–6: процесс описан слишком крупно, уточните шаги.`, null);
  }
  const codesForCount = codes;
  for (const parent of new Set(model.nodes.map((n) => n.idef0_parent).filter((p): p is string => !!p))) {
    const kids = fnOf(parent);
    if (kids.length > 6) add("IDEF0", "warning", "idef0_block_count", `На диаграмме ${codesForCount.get(parent) ?? parent} ${kids.length} функций — рекомендуется 3–6, разбейте её на подуровни.`, parent);
  }
  // Одно предупреждение на правило, а не по одному на каждую функцию: когда управление или выходы
  // не заполнены у большинства шагов, это один общий пробел, а не десяток отдельных замечаний.
  const listNames = (ns: typeof topLevel) =>
    ns.length <= 3 ? ns.map((n) => `«${n.name}»`).join(", ") : `${ns.slice(0, 3).map((n) => `«${n.name}»`).join(", ")} и ещё ${ns.length - 3}`;
  const idef0Gap = (rule: string, missing: typeof topLevel, what: string, hint: string) => {
    if (missing.length === 0) return;
    const who = missing.length === topLevel.length && topLevel.length > 1 ? `У всех ${topLevel.length} функций` : `У ${missing.length} из ${topLevel.length} функций (${listNames(missing)})`;
    // при единственной функции предупреждение можно привязать к элементу
    add("IDEF0", "warning", rule, `${who} ${what}. ${hint}`, missing.length === 1 ? missing[0].id : null);
  };
  idef0Gap("idef0_no_control", topLevel.filter((n) => n.controls.length === 0 && (n.control_data_ids ?? []).length === 0), "не указано управление (control)", "Укажите, чем регулируется шаг: регламент, правило, норматив.");
  idef0Gap("idef0_no_output", topLevel.filter((n) => n.outputs.length === 0), "не указан выход (output)", "Укажите, какой документ или результат шаг создаёт.");

  // Баланс декомпозиции: ICOM-стрелки функции должны находиться среди дочерних функций и наоборот.
  const dataName = (id: string) => model.data.find((d) => d.id === id)?.name ?? id;
  const ctlName = (id: string) => model.controls.find((c) => c.id === id)?.name ?? id;
  const list = (ids: string[], nameOf: (id: string) => string) => ids.slice(0, 3).map((id) => `«${nameOf(id)}»`).join(", ") + (ids.length > 3 ? ` и ещё ${ids.length - 3}` : "");
  const diffText = (label: string, g: { inputs: string[]; controls: string[]; data: string[]; outputs: string[] }) =>
    [
      g.inputs.length ? `входы ${list(g.inputs, dataName)}` : "",
      g.controls.length ? `управление ${list(g.controls, ctlName)}` : "",
      g.data.length ? `управление-данные ${list(g.data, dataName)}` : "",
      g.outputs.length ? `выходы ${list(g.outputs, dataName)}` : "",
    ]
      .filter(Boolean)
      .map((s, i, all) => (i === 0 ? `${label}: ${s}` : s) + (i === all.length - 1 ? "" : ","))
      .join(" ");
  for (const parent of model.nodes) {
    const kids = idef0Functions(model, parent.id);
    if (kids.length === 0) continue;
    const kid = {
      inputs: new Set(kids.flatMap((k) => k.inputs)),
      outputs: new Set(kids.flatMap((k) => k.outputs)),
      controls: new Set(kids.flatMap((k) => k.controls)),
      data: new Set(kids.flatMap((k) => k.control_data_ids ?? [])),
    };
    const pIn = parent.inputs;
    const pCtl = parent.controls;
    const pData = parent.control_data_ids ?? [];
    const pOut = parent.outputs;
    const producedInside = new Set(kids.flatMap((k) => k.outputs));
    const consumedInside = new Set(kids.flatMap((k) => [...k.inputs, ...(k.control_data_ids ?? [])]));
    // у родителя есть, у дочерних нет (вход может использоваться и как управление-данные)
    const onlyParent = {
      inputs: pIn.filter((id) => !kid.inputs.has(id) && !kid.data.has(id)),
      controls: pCtl.filter((id) => !kid.controls.has(id)),
      data: pData.filter((id) => !kid.data.has(id) && !kid.inputs.has(id)),
      outputs: pOut.filter((id) => !kid.outputs.has(id)),
    };
    // у дочерних есть «снаружи», а у родителя нет
    const onlyKids = {
      inputs: [...kid.inputs].filter((id) => !producedInside.has(id) && !pIn.includes(id) && !pData.includes(id)),
      controls: [...kid.controls].filter((id) => !pCtl.includes(id)),
      data: [...kid.data].filter((id) => !producedInside.has(id) && !pData.includes(id) && !pIn.includes(id)),
      outputs: [...kid.outputs].filter((id) => !consumedInside.has(id) && !pOut.includes(id)),
    };
    const parts = [diffText("есть у родителя, но нет у дочерних функций", onlyParent), diffText("есть у дочерних функций, но нет у родителя", onlyKids)].filter(Boolean);
    if (parts.length > 0) {
      add("IDEF0", "warning", "idef0_unbalanced", `Декомпозиция ${codes.get(parent.id) ?? ""} «${parent.name}» не сбалансирована: ${parts.join("; ")}.`, parent.id);
    }
  }

  // --- 5.3 Стиль наименований ---
  // Инфинитив ищем среди слов названия. \b в JS не видит кириллицу как буквы, поэтому границы
  // слов задаём через \p{L}. Слова на «-ость» — существительные («готовность»), не глаголы.
  const hasInfinitive = (name: string) =>
    (name.toLowerCase().match(/[\p{L}-]+/gu) ?? []).some((w) => /(?:ть|ться|чь|ти|тись)$/u.test(w) && !/ость$/u.test(w));
  for (const n of model.nodes) {
    if (n.type === "task" || n.type === "subprocess") {
      // по Соглашению блок называется инфинитивом или отглагольным существительным («Актуализация реестра»)
      if (!hasInfinitive(n.name) && !(isStructured(model) && hasVerbalNoun(n.name))) {
        add(
          "MODEL",
          "warning",
          "naming_action_style",
          `Название действия «${n.name}» рекомендуется формулировать как «глагол в инфинитиве + объект» (например: «согласовать заявку»).`,
          n.id
        );
      }
    }
    if (n.type === "event") {
      // в модели по Соглашению о событии судит bpmn_event_not_fact
      if (hasInfinitive(n.name) && !isStructured(model)) {
        add(
          "MODEL",
          "warning",
          "naming_event_style",
          `Название события «${n.name}» рекомендуется формулировать как состояние объекта (например: «заявка одобрена»), а не как действие.`,
          n.id
        );
      }
    }
  }

  // --- ФТ-М1.3.2: матрица RACI — ровно один A и хотя бы один R на действие.
  // Проверяется только если RACI уже заполнена (фича опциональная, ФТ-М1.3).
  if (model.raci.length > 0) {
    for (const n of model.nodes) {
      if (n.type !== "task" && n.type !== "subprocess") continue;
      const forNode = model.raci.filter((r) => r.node_id === n.id);
      const aCount = forNode.filter((r) => r.type === "A").length;
      const rCount = forNode.filter((r) => r.type === "R").length;
      if (aCount === 0) {
        add("MODEL", "error", "raci_missing_a", `Действие «${n.name}» не имеет ответственного (A) в матрице RACI.`, n.id);
      } else if (aCount > 1) {
        add("MODEL", "error", "raci_multiple_a", `Действие «${n.name}» имеет более одного ответственного (A) в матрице RACI — должен быть ровно один.`, n.id);
      }
      if (rCount === 0) {
        add("MODEL", "warning", "raci_missing_r", `Действие «${n.name}» не имеет исполнителя (R) в матрице RACI.`, n.id);
      }
    }
  }

  // --- Структура модели и ролевая модель (Соглашение о моделировании, разд. 2–3) ---
  const rawCode = (model.process.code ?? "").trim();
  if (rawCode && !parseProcessCode(rawCode)) {
    add("MODEL", "warning", "process_code_format", `Код процесса «${rawCode}» не соответствует шаблону: буква группы (A, B, C), номер в реестре и «.00.00», например B002.00.00.`, null);
  }
  if (isStructured(model)) {
    const fns = model.nodes.filter((n) => (n.type === "task" || n.type === "subprocess") && !n.bpmn_scope);
    for (const n of fns) {
      if (functionDepth(model, n.id) >= 3) {
        add("MODEL", "warning", "structure_depth", `Функция ${codes.get(n.id) ?? ""} «${n.name}» лежит ниже операции. По Соглашению подпроцесс делится на операции (IDEF0), а операция описывается диаграммой BPMN — подоперации отдельных диаграмм IDEF0 не имеют.`, n.id);
      }
    }
    for (const host of bpmnHosts(model)) {
      const depth = functionDepth(model, host.id);
      const code = codes.get(host.id) ?? "";
      if (depth === 1) {
        add("MODEL", "warning", "structure_no_operations", `Подпроцесс ${code} «${host.name}» не разделён на операции: опишите его операции в декомпозиции IDEF0.`, host.id);
      } else if (!model.nodes.some((n) => n.bpmn_scope === host.id)) {
        add("MODEL", "warning", "operation_no_bpmn", `Для операции ${code} «${host.name}» нет диаграммы BPMN — опишите её шаги в редакторе BPMN.`, host.id);
      }
    }
    const assigned = (nodeId: string | null, kind: string) => (model.assignments ?? []).filter((a) => a.node_id === nodeId && a.kind === kind && model.roles.some((r) => r.id === a.role_id));
    if (assigned(null, "owner").length === 0) add("MODEL", "warning", "role_no_owner", "У процесса не назначен владелец — каждый процесс и подпроцесс должен иметь закреплённого владельца.", null);
    for (const n of fns) {
      const depth = functionDepth(model, n.id);
      const owners = assigned(n.id, "owner").length;
      if (depth === 1 && owners === 0) add("MODEL", "warning", "role_no_owner", `У подпроцесса ${codes.get(n.id) ?? ""} «${n.name}» не назначен владелец.`, n.id);
      if (owners > 1) add("MODEL", "warning", "role_multiple_owner", `У ${codes.get(n.id) ?? ""} «${n.name}» несколько владельцев: ответственность закрепляется за одним и не дублируется.`, n.id);
      const isOperation = depth >= 2 && !model.nodes.some((c) => c.idef0_parent === n.id && !c.bpmn_scope);
      if (isOperation && !n.role_id && assigned(n.id, "executor").length === 0) {
        add("MODEL", "warning", "role_no_executor", `У операции ${codes.get(n.id) ?? ""} «${n.name}» не назначен исполнитель.`, n.id);
      }
    }
  }

  // --- продукты и названия блоков (Соглашение о моделировании) ---
  if (isStructured(model)) {
    const fnsAll = model.nodes.filter((n) => (n.type === "task" || n.type === "subprocess") && !n.bpmn_scope);
    const label = (n: { id: string; name: string }) => `${codes.get(n.id) ?? ""} «${n.name}»`.trim();

    // блоки IDEF0 с одинаковыми названиями: каждое название блока уникально в модели
    const byName = new Map<string, typeof fnsAll>();
    for (const n of fnsAll) if (n.name.trim()) byName.set(blockKey(n.name), [...(byName.get(blockKey(n.name)) ?? []), n]);
    for (const group of byName.values()) {
      if (group.length > 1) add("IDEF0", "warning", "idef0_duplicate_name", `Блоки с одинаковым названием «${group[0].name}»: ${group.map((g) => codes.get(g.id) ?? g.id).join(", ")}. Название блока должно быть уникальным.`, group[0].id);
    }
    // петли: выход функции не должен возвращаться на её же вход или управление
    for (const n of fnsAll) {
      const back = n.outputs.filter((id) => n.inputs.includes(id) || (n.control_data_ids ?? []).includes(id));
      if (back.length > 0) add("IDEF0", "warning", "idef0_self_loop", `У функции ${label(n)} выход «${dataName(back[0])}» возвращается на её же вход или управление — петли в IDEF0 не допускаются.`, n.id);
    }

    // потоки сообщений идут от задач, подпроцессов и событий-сообщений; шлюз и таймер сообщения не отправляют и не получают
    const poolName = (id: string) => (model.pools ?? []).find((q) => q.id === id)?.name;
    for (const msg of model.messages ?? []) {
      const out = !!model.nodes.find((n) => n.id === msg.from);
      const node = model.nodes.find((n) => n.id === (out ? msg.from : msg.to));
      const pool = poolName(out ? msg.to : msg.from);
      if (!node || pool === undefined) continue;
      const trig = node.type === "event" ? eventSpec(node, !!node.attached_to).trigger : "none";
      const bad = node.type === "gateway" || ["timer", "error", "conditional", "escalation", "compensation", "cancel", "link", "terminate"].includes(trig);
      if (bad) {
        const who = node.type === "gateway" ? "шлюз" : trig === "timer" || trig === "error" ? "таймер и событие-ошибка" : `событие с триггером «${TRIGGER_LABELS[trig].toLowerCase()}»`;
        add("BPMN", "warning", "bpmn_message_endpoint", `${out ? "Сообщение в «" : "Сообщение из «"}${pool}» ${out ? "отправляет" : "получает"} «${node.name}», а ${who} сообщений не ${out ? "отправляют" : "получают"}: свяжите пул с задачей или событием-сообщением.`, node.id);
      }
    }
    // источник и назначение продуктов: внутри модели они выводятся из связей функций, снаружи — задаются в карточке
    const producersOf = (id: string) => fnsAll.filter((n) => n.outputs.includes(id));
    const consumersOf = (id: string) => fnsAll.filter((n) => n.inputs.includes(id) || (n.control_data_ids ?? []).includes(id));
    const names = (ids: string[]) => `${ids.slice(0, 3).map((x) => `«${dataName(x)}»`).join(", ")}${ids.length > 3 ? ` и ещё ${ids.length - 3}` : ""}`;
    const noSupplier = model.data.filter((d) => consumersOf(d.id).length > 0 && producersOf(d.id).length === 0 && !d.supplier?.trim()).map((d) => d.id);
    const noConsumer = model.data.filter((d) => producersOf(d.id).length > 0 && consumersOf(d.id).length === 0 && !d.consumer?.trim()).map((d) => d.id);
    if (noSupplier.length > 0) add("MODEL", "warning", "data_no_supplier", `У ${noSupplier.length} входов (${names(noSupplier)}) не определён источник: ни одна функция модели их не выпускает и внешний поставщик не указан в карточке продукта.`, noSupplier.length === 1 ? noSupplier[0] : null);
    if (noConsumer.length > 0) add("MODEL", "warning", "data_no_consumer", `У ${noConsumer.length} выходов (${names(noConsumer)}) не определено назначение: ни одна функция модели их не использует и внешний потребитель не указан в карточке продукта.`, noConsumer.length === 1 ? noConsumer[0] : null);

    // коды в полях «поставщик» и «потребитель»: код этого же процесса должен вести к функции, которая действительно выпускает или использует продукт
    const processPrefix = processCodePrefix(model.process.code);
    const knownCodes = new Map([...codes].map(([id, c]) => [c, id] as const));
    const check = (d: (typeof model.data)[number], text: string | null | undefined, role: "supplier" | "consumer") => {
      for (const raw of text?.match(FUNCTION_CODE) ?? []) {
        const code = normalizeCode(raw);
        if (!code.startsWith(`${processPrefix}.`)) continue; // код другого процесса — внешняя ссылка, здесь её проверить нечем
        const fnId = knownCodes.get(code);
        const who = role === "supplier" ? "поставщик" : "потребитель";
        if (!fnId) {
          add("MODEL", "warning", "data_ref_unknown_code", `У продукта «${d.name}» ${who} указан кодом ${code}, но такой функции в модели нет.`, d.id);
          continue;
        }
        const linked = (role === "supplier" ? producersOf(d.id) : consumersOf(d.id)).map((n) => n.id);
        if (linked.length > 0 && !linked.some((id) => id === fnId || isAncestorOrSelf(model, fnId, id) || isAncestorOrSelf(model, id, fnId))) {
          add("MODEL", "warning", "data_ref_mismatch", `У продукта «${d.name}» ${who} указан ${code}, а по связям функций это ${linked.map((id) => codes.get(id) ?? id).join(", ")}.`, d.id);
        }
      }
    };
    for (const d of model.data) {
      check(d, d.supplier, "supplier");
      check(d, d.consumer, "consumer");
    }
  }

  return issues;
}

/** Номер процесса из кода: «B002.00.00» → «B002» (кириллица приводится к латинице). */
function processCodePrefix(code: string | null | undefined): string {
  return normalizeCode((code ?? "").trim().slice(0, 4));
}

/** ancestor — сама функция или её предок в дереве IDEF0. */
function isAncestorOrSelf(model: Pick<ProcessLogicModel, "nodes">, ancestor: string, id: string): boolean {
  const byId = new Map(model.nodes.map((n) => [n.id, n] as const));
  for (let cur = byId.get(id), guard = 0; cur && guard < 50; cur = cur.idef0_parent ? byId.get(cur.idef0_parent) : undefined, guard++) {
    if (cur.id === ancestor) return true;
  }
  return false;
}

export function hasBlockingErrors(issues: ValidationIssue[]): boolean {
  return issues.some((i) => i.severity === "error");
}

// --- принятые замечания ---

export interface AcceptanceLike {
  rule: string;
  element_id?: string | null;
  message?: string | null;
  reason: string;
  at?: string | null;
}

interface IssueLikeFull {
  rule: string;
  message: string;
  element_id: string | null;
  severity: string;
}

/** Ключ замечания: правило и элемент; у замечаний без элемента — ещё и текст (он меняется вместе с содержанием замечания). */
export const issueKey = (i: { rule: string; element_id?: string | null; message?: string | null }): string => (i.element_id ? `${i.rule}|${i.element_id}` : `${i.rule}||${i.message ?? ""}`);

/**
 * Делит замечания на действующие и принятые аналитиком. Ошибки принять нельзя — они всегда действующие: модель с ошибкой
 * некорректна, а не «нарисована как в документе».
 */
export function splitAccepted<I extends IssueLikeFull>(accepted: AcceptanceLike[] | undefined, issues: I[]): { active: I[]; accepted: (I & { reason: string; at: string | null })[] } {
  const byKey = new Map((accepted ?? []).map((a) => [issueKey(a), a] as const));
  const active: I[] = [];
  const done: (I & { reason: string; at: string | null })[] = [];
  for (const i of issues) {
    const a = i.severity === "error" ? undefined : byKey.get(issueKey(i));
    if (a) done.push({ ...i, reason: a.reason, at: a.at ?? null });
    else active.push(i);
  }
  return { active, accepted: done };
}