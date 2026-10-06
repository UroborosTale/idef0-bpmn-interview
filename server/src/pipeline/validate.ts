import type { ProcessLogicModel, ValidationIssue } from "../types/model.js";
import { idef0Codes, idef0Functions } from "./idef0.js";

/**
 * Детерминированная валидация BPMN (5.1) и IDEF0 (5.2) + стиль наименований (5.3).
 * Ошибки (error) блокируют экспорт, предупреждения (warning) — нет (5.4).
 */
export function validateModel(model: ProcessLogicModel): ValidationIssue[] {
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

  // Диаграмма процесса не включает детали декомпозиции IDEF0 (узлы с idef0_parent): их нет в BPMN,
  // поэтому и проверки потока (старт, конец, тупики, достижимость) относятся только к остальным узлам.
  const bpmnNodes = model.nodes.filter((n) => !n.idef0_parent);
  const bpmnIds = new Set(bpmnNodes.map((n) => n.id));
  const bpmnFlows = model.flows.filter((f) => bpmnIds.has(f.from) && bpmnIds.has(f.to));
  const nodeById = new Map(model.nodes.map((n) => [n.id, n] as const));
  const outAdj = new Map<string, string[]>();
  const inCount = new Map<string, number>();
  for (const f of bpmnFlows) {
    outAdj.set(f.from, [...(outAdj.get(f.from) ?? []), f.to]);
    inCount.set(f.to, (inCount.get(f.to) ?? 0) + 1);
  }

  // --- BPMN 5.1 ---
  // Генератор диаграмм (bpmn.ts) сам достраивает начало и конец, если явных событий нет:
  // начало ведёт в узлы без входящих стрелок, конец — из узлов без исходящих. Поэтому
  // отсутствие явных событий — не ошибка, пока у процесса есть точка входа и выхода.
  // Проверки ниже должны оставаться согласованными с этой логикой.
  const startNodes = bpmnNodes.filter((n) => n.type === "event" && n.subtype === "start");
  const endNodes = bpmnNodes.filter((n) => n.type === "event" && n.subtype === "end");
  const entryNodes = bpmnNodes.filter((n) => (inCount.get(n.id) ?? 0) === 0);
  const exitNodes = bpmnNodes.filter((n) => (outAdj.get(n.id) ?? []).length === 0);

  if (bpmnNodes.length === 0) {
    add("BPMN", "error", "bpmn_no_start", "В модели нет ни одного элемента — нечего показывать на диаграмме.", null);
  } else {
    if (startNodes.length === 0 && entryNodes.length === 0) {
      add("BPMN", "error", "bpmn_no_start", "Нет точки входа: у каждого шага есть входящая стрелка (процесс замкнут). Добавьте начальное событие.", null);
    }
    if (endNodes.length === 0 && exitNodes.length === 0) {
      add("BPMN", "error", "bpmn_no_end", "Нет точки выхода: у каждого шага есть продолжение (процесс зациклен). Добавьте конечное событие.", null);
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
    for (const next of outAdj.get(cur) ?? []) queue.push(next);
  }
  if (roots.length > 0) {
    for (const n of bpmnNodes) {
      if (!reached.has(n.id)) {
        add("BPMN", "error", "bpmn_unreachable_node", `Узел «${n.name}» недостижим из стартового события.`, n.id);
      }
    }
  }

  // тупики: узел без исходящих связей, не являющийся конечным событием. Если конечных событий
  // в модели нет, такие узлы — естественные концы процесса (к ним достраивается конец).
  if (endNodes.length > 0) {
    for (const n of bpmnNodes) {
      if (n.type === "event" && n.subtype === "end") continue;
      if ((outAdj.get(n.id) ?? []).length === 0) {
        add("BPMN", "error", "bpmn_dead_end", `Узел «${n.name}» не имеет продолжения (тупик потока): ведите стрелку дальше или к конечному событию.`, n.id);
      }
    }
  }

  // парные шлюзы: шлюз с 1 входом и 1 выходом — вероятно, лишний / не сбалансирован
  for (const n of bpmnNodes) {
    if (n.type !== "gateway") continue;
    const outs = (outAdj.get(n.id) ?? []).length;
    const ins = inCount.get(n.id) ?? 0;
    if (outs <= 1 && ins <= 1) {
      add("BPMN", "warning", "bpmn_gateway_unbalanced", `Шлюз «${n.name}» не разветвляет и не объединяет поток — проверьте необходимость.`, n.id);
    }
  }

  // простая проверка на возможный livelock: цикл без выхода
  const visited = new Set<string>();
  const stack = new Set<string>();
  function dfs(id: string, path: string[]): void {
    if (stack.has(id)) {
      const cycle = path.slice(path.indexOf(id));
      const hasExit = cycle.some((cid) => (outAdj.get(cid) ?? []).some((t) => !cycle.includes(t)));
      if (!hasExit) {
        add(
          "BPMN",
          "warning",
          "bpmn_possible_livelock",
          `Обнаружен цикл без выхода: ${cycle.map((cid) => nodeById.get(cid)?.name ?? cid).join(" → ")}.`,
          id
        );
      }
      return;
    }
    if (visited.has(id)) return;
    visited.add(id);
    stack.add(id);
    for (const next of outAdj.get(id) ?? []) dfs(next, [...path, id]);
    stack.delete(id);
  }
  for (const n of bpmnNodes) dfs(n.id, []);

  // --- IDEF0 5.2 ---
  const topLevel = model.nodes.filter((n) => (n.type === "task" || n.type === "subprocess") && !n.idef0_parent);
  if (topLevel.length > 0 && (topLevel.length < 3 || topLevel.length > 6)) {
    add(
      "IDEF0",
      "warning",
      "idef0_block_count",
      `На уровне декомпозиции A0 ${topLevel.length} блок(ов) — по правилам IDEF0 рекомендуется 3–6.${
        topLevel.length > 6 ? " Сгруппируйте близкие шаги в подпроцессы." : ""
      }`,
      null
    );
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
  const codes = idef0Codes(model);
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
      if (!hasInfinitive(n.name)) {
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
      if (hasInfinitive(n.name)) {
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

  return issues;
}

export function hasBlockingErrors(issues: ValidationIssue[]): boolean {
  return issues.some((i) => i.severity === "error");
}
