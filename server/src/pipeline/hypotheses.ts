import { nanoid } from "nanoid";
import type { ProcessLogicModel, ProcessNode } from "../types/model.js";
import { parseDurationToMinutes } from "./timeUtils.js";
import { detectAntipatterns, type AntipatternFinding } from "./antipatterns.js";

/**
 * ФТ-М2.4.1: каталог из 6 шаблонов улучшения процесса. Два apply-варианта
 * automate_* соответствуют одному пункту каталога ("Автоматизация") — просто
 * структурно применяются по-разному в зависимости от антипаттерна-триггера.
 */
export type HypothesisTemplate = "parallelize" | "eliminate_step" | "automate_handoff" | "automate_duplicate" | "merge_roles" | "delegate" | "threshold";

export const TEMPLATE_LABEL: Record<HypothesisTemplate, string> = {
  parallelize: "Распараллеливание",
  eliminate_step: "Устранение шага",
  automate_handoff: "Автоматизация",
  automate_duplicate: "Автоматизация",
  merge_roles: "Объединение ролей",
  delegate: "Делегирование полномочий",
  threshold: "Введение порога",
};

const RISK_TEXT: Record<HypothesisTemplate, string> = {
  parallelize: "Требует отсутствия скрытой зависимости между шагами, не отражённой в модели (например, по ресурсам или неявным данным).",
  eliminate_step: "Нужно подтвердить, что результат шага действительно нигде не используется, в том числе в неформальных процессах вне модели.",
  automate_handoff: "Требует ИТ-доступности систем и бюджета на интеграцию; до реализации интеграции шаг нельзя просто убрать из регламента.",
  automate_duplicate: "Требует единого источника данных (мастер-системы) и синхронизации существующих записей при переходе.",
  merge_roles: "Объединённая роль должна иметь достаточную квалификацию; возможен конфликт разделения обязанностей (SoD) при объединении контролирующих функций.",
  delegate: "Требует пересмотра матрицы полномочий, обучения делегата и определения границ делегируемых решений.",
  threshold: "Порог должен быть согласован с владельцем риска и не должен снижать контроль ниже приемлемого уровня.",
};

const ASSUMPTION_TEXT: Record<HypothesisTemplate, string> = {
  parallelize: "Шаги действительно независимы по данным и ресурсам-исполнителям.",
  eliminate_step: "Шаг не создаёт объект данных и не служит точкой контроля, требуемой регламентом или аудитом.",
  automate_handoff: "Доступен API или иной программный канал обмена между системами на входе и выходе шага.",
  automate_duplicate: "Обе системы могут получать данные из единого источника (интеграция или мастер-система).",
  merge_roles: "Совмещение обязанностей не противоречит требованиям разделения полномочий (СМК, ИБ).",
  delegate: "Определён порог/критерий, при котором решение может приниматься на более низком уровне.",
  threshold: "Есть измеримый критерий (сумма, число попыток, срок), по которому можно ограничить цикл или чат согласований.",
};

export interface Hypothesis {
  id: string;
  template: HypothesisTemplate;
  title: string;
  description: string;
  affectedElementIds: string[];
  minutesSaved: number | null;
  costSaved: number | null;
  risks: string;
  assumptions: string;
}

function nodeById(model: ProcessLogicModel): Map<string, ProcessNode> {
  return new Map(model.nodes.map((n) => [n.id, n] as const));
}
function nodeMinutes(n: ProcessNode | undefined): number {
  if (!n) return 0;
  return (parseDurationToMinutes(n.time_processing) ?? parseDurationToMinutes(n.duration) ?? 0) + (parseDurationToMinutes(n.time_waiting) ?? 0);
}
function roleRate(roleId: string | null | undefined, rates: Map<string, number>, model: ProcessLogicModel): number | null {
  if (!roleId) return null;
  const role = model.roles.find((r) => r.id === roleId);
  if (!role) return null;
  const rate = rates.get(role.name.toLowerCase());
  return rate ?? null;
}

/** ФТ-М2.4.1/2.4.2: генерация гипотез TO-BE по результатам антипаттернов (М2.3) и кандидатов на распараллеливание. */
export function generateHypotheses(model: ProcessLogicModel, rates: Map<string, number> = new Map()): Hypothesis[] {
  const findings = detectAntipatterns(model);
  const byId = nodeById(model);
  const hypotheses: Hypothesis[] = [];

  const findingsByRule = (rule: AntipatternFinding["rule"]) => findings.filter((f) => f.rule === rule);

  for (const f of findingsByRule("step_without_output")) {
    const n = byId.get(f.elementIds[0]);
    if (!n) continue;
    const minutes = nodeMinutes(n);
    const rate = roleRate(n.role_id, rates, model);
    hypotheses.push({
      id: `hyp_${nanoid(10)}`,
      template: "eliminate_step",
      title: `Устранить шаг «${n.name}»`,
      description: `Шаг «${n.name}» не производит объекта данных и не имеет потребителя результата — кандидат на полное исключение из процесса.`,
      affectedElementIds: [n.id],
      minutesSaved: minutes || null,
      costSaved: rate && minutes ? (rate / 60) * minutes : null,
      risks: RISK_TEXT.eliminate_step,
      assumptions: ASSUMPTION_TEXT.eliminate_step,
    });
  }

  for (const f of findingsByRule("manual_handoff")) {
    const manual = byId.get(f.elementIds[1]);
    if (!manual) continue;
    const minutes = nodeMinutes(manual);
    const rate = roleRate(manual.role_id, rates, model);
    hypotheses.push({
      id: `hyp_${nanoid(10)}`,
      template: "automate_handoff",
      title: `Автоматизировать передачу «${manual.name}»`,
      description: `Ручной перенос данных между системами («${manual.name}») можно заменить программной интеграцией.`,
      affectedElementIds: f.elementIds,
      minutesSaved: minutes || null,
      costSaved: rate && minutes ? (rate / 60) * minutes : null,
      risks: RISK_TEXT.automate_handoff,
      assumptions: ASSUMPTION_TEXT.automate_handoff,
    });
  }

  for (const f of findingsByRule("double_entry")) {
    const nodes = f.elementIds.map((id) => byId.get(id)).filter((n): n is ProcessNode => !!n);
    if (nodes.length < 2) continue;
    const duplicate = nodes[nodes.length - 1];
    const minutes = nodeMinutes(duplicate);
    const rate = roleRate(duplicate.role_id, rates, model);
    hypotheses.push({
      id: `hyp_${nanoid(10)}`,
      template: "automate_duplicate",
      title: `Устранить двойной ввод («${duplicate.name}»)`,
      description: `Объект данных вводится независимо в несколько систем — интеграция или единый источник данных устранит повторный ввод в шаге «${duplicate.name}».`,
      affectedElementIds: f.elementIds,
      minutesSaved: minutes || null,
      costSaved: rate && minutes ? (rate / 60) * minutes : null,
      risks: RISK_TEXT.automate_duplicate,
      assumptions: ASSUMPTION_TEXT.automate_duplicate,
    });
  }

  for (const f of findingsByRule("ping_pong")) {
    const nodes = f.elementIds.map((id) => byId.get(id)).filter((n): n is ProcessNode => !!n);
    const roleIds = [...new Set(nodes.map((n) => n.role_id).filter((x): x is string => !!x))];
    if (roleIds.length !== 2) continue;
    const roleNames = roleIds.map((id) => model.roles.find((r) => r.id === id)?.name ?? id);
    const minutes = nodes.length * 10; // приблизительные накладные расходы на передачу (10 мин/передача)
    hypotheses.push({
      id: `hyp_${nanoid(10)}`,
      template: "merge_roles",
      title: `Объединить роли «${roleNames[0]}» и «${roleNames[1]}»`,
      description: `Более двух передач подряд между «${roleNames[0]}» и «${roleNames[1]}» — объединение ролей устранит накладные расходы на пинг-понг.`,
      affectedElementIds: [...roleIds, ...f.elementIds],
      minutesSaved: minutes,
      costSaved: null,
      risks: RISK_TEXT.merge_roles,
      assumptions: ASSUMPTION_TEXT.merge_roles,
    });
  }

  for (const f of findingsByRule("excessive_approval")) {
    const chain = f.elementIds.map((id) => byId.get(id)).filter((n): n is ProcessNode => !!n);
    if (chain.length < 3) continue;
    const middle = chain.slice(1, -1);
    const minutes = middle.reduce((s, n) => s + nodeMinutes(n), 0);
    const cost = middle.reduce((s, n) => {
      const rate = roleRate(n.role_id, rates, model);
      return s + (rate ? (rate / 60) * nodeMinutes(n) : 0);
    }, 0);
    hypotheses.push({
      id: `hyp_${nanoid(10)}`,
      template: "delegate",
      title: `Делегировать часть согласований в цепочке «${chain[0].name} → … → ${chain[chain.length - 1].name}»`,
      description: `Цепочка из ${chain.length} согласований подряд — часть решений можно делегировать на более низкий уровень, оставив только финальное согласование.`,
      affectedElementIds: middle.map((n) => n.id),
      minutesSaved: minutes || null,
      costSaved: cost || null,
      risks: RISK_TEXT.delegate,
      assumptions: ASSUMPTION_TEXT.delegate,
    });
  }

  for (const f of findingsByRule("loop_without_exit")) {
    hypotheses.push({
      id: `hyp_${nanoid(10)}`,
      template: "threshold",
      title: `Ввести порог выхода из цикла возврата`,
      description: `Цикл возврата (${f.elementIds.map((id) => byId.get(id)?.name ?? id).join(" → ")}) не имеет условия выхода по счётчику/сроку — предлагается ввести ограничение числа повторов.`,
      affectedElementIds: f.elementIds,
      minutesSaved: null,
      costSaved: null,
      risks: RISK_TEXT.threshold,
      assumptions: ASSUMPTION_TEXT.threshold,
    });
  }

  // --- Кандидаты на распараллеливание: A -> B последовательно, разные роли, нет зависимости по данным ---
  const inCount = new Map<string, number>();
  const outCount = new Map<string, number>();
  for (const fl of model.flows) {
    inCount.set(fl.to, (inCount.get(fl.to) ?? 0) + 1);
    outCount.set(fl.from, (outCount.get(fl.from) ?? 0) + 1);
  }
  for (const fl of model.flows) {
    const a = byId.get(fl.from);
    const b = byId.get(fl.to);
    if (!a || !b || a.type !== "task" || b.type !== "task") continue;
    if ((outCount.get(a.id) ?? 0) !== 1 || (inCount.get(b.id) ?? 0) !== 1) continue; // однозначная последовательность, без ветвлений
    if (!a.role_id || !b.role_id || a.role_id === b.role_id) continue;
    const dataOverlap = a.outputs.some((o) => b.inputs.includes(o));
    if (dataOverlap) continue;
    const predFlow = model.flows.find((f2) => f2.to === a.id);
    const succFlow = model.flows.find((f2) => f2.from === b.id);
    if (!predFlow || !succFlow) continue; // нужен однозначный "вход" и "выход" вокруг пары, чтобы безопасно вставить развилку
    const minutesA = nodeMinutes(a);
    const minutesB = nodeMinutes(b);
    if (minutesA === 0 && minutesB === 0) continue;
    hypotheses.push({
      id: `hyp_${nanoid(10)}`,
      template: "parallelize",
      title: `Распараллелить «${a.name}» и «${b.name}»`,
      description: `Шаги «${a.name}» и «${b.name}» выполняются разными ролями и не зависят друг от друга по данным — их можно выполнять параллельно вместо последовательно.`,
      affectedElementIds: [a.id, b.id],
      minutesSaved: Math.min(minutesA, minutesB) || null,
      costSaved: null,
      risks: RISK_TEXT.parallelize,
      assumptions: ASSUMPTION_TEXT.parallelize,
    });
  }

  return hypotheses;
}

// --- Применение гипотезы к копии модели (ФТ-М2.4.3) — никогда не вызывается автоматически (2.4.4) ---

function cloneModel(model: ProcessLogicModel): ProcessLogicModel {
  return JSON.parse(JSON.stringify(model));
}

function removeNodeRewire(model: ProcessLogicModel, nodeId: string): void {
  const preds = model.flows.filter((f) => f.to === nodeId);
  const succs = model.flows.filter((f) => f.from === nodeId);
  model.flows = model.flows.filter((f) => f.from !== nodeId && f.to !== nodeId);
  for (const p of preds) {
    for (const s of succs) {
      const exists = model.flows.some((f) => f.from === p.from && f.to === s.to);
      if (!exists) {
        model.flows.push({ id: `fl_${nanoid(8)}`, from: p.from, to: s.to, condition: p.condition ?? s.condition ?? null, source: [], confirmed_by: [] });
      }
    }
  }
  model.nodes = model.nodes.filter((n) => n.id !== nodeId);
}

export function applyHypothesis(model: ProcessLogicModel, hyp: Hypothesis): ProcessLogicModel {
  const out = cloneModel(model);
  out.process = { ...out.process, type: "TO-BE" };

  switch (hyp.template) {
    case "eliminate_step": {
      removeNodeRewire(out, hyp.affectedElementIds[0]);
      break;
    }
    case "automate_handoff": {
      const manualId = hyp.affectedElementIds[1];
      removeNodeRewire(out, manualId);
      for (const id of [hyp.affectedElementIds[0], hyp.affectedElementIds[2]]) {
        const n = out.nodes.find((x) => x.id === id);
        if (n && !n.tags.includes("automated_integration")) n.tags = [...n.tags, "automated_integration"];
      }
      break;
    }
    case "automate_duplicate": {
      const keep = hyp.affectedElementIds[0];
      for (const id of hyp.affectedElementIds.slice(1)) removeNodeRewire(out, id);
      const n = out.nodes.find((x) => x.id === keep);
      if (n && !n.tags.includes("automated_integration")) n.tags = [...n.tags, "automated_integration"];
      break;
    }
    case "merge_roles": {
      const [roleAId, roleBId] = hyp.affectedElementIds;
      out.nodes = out.nodes.map((n) => (n.role_id === roleBId ? { ...n, role_id: roleAId } : n));
      out.raci = out.raci.map((r) => (r.role_id === roleBId ? { ...r, role_id: roleAId } : r));
      out.roles = out.roles.filter((r) => r.id !== roleBId);
      break;
    }
    case "delegate": {
      for (const id of hyp.affectedElementIds) removeNodeRewire(out, id);
      break;
    }
    case "threshold": {
      const cycleIds = hyp.affectedElementIds;
      const backEdge = out.flows.find((f) => f.from === cycleIds[cycleIds.length - 1] && f.to === cycleIds[0]) ?? out.flows.find((f) => cycleIds.includes(f.from) && cycleIds.includes(f.to) && f.to === cycleIds[0]);
      if (backEdge) {
        backEdge.condition = `${backEdge.condition ? backEdge.condition + "; " : ""}не более 3 повторов — далее эскалация`;
      }
      break;
    }
    case "parallelize": {
      const [aId, bId] = hyp.affectedElementIds;
      const predFlow = out.flows.find((f) => f.to === aId);
      const succFlow = out.flows.find((f) => f.from === bId);
      const directFlow = out.flows.find((f) => f.from === aId && f.to === bId);
      if (predFlow && succFlow && directFlow) {
        const splitId = `gw_${nanoid(8)}`;
        const joinId = `gw_${nanoid(8)}`;
        out.nodes.push(
          { id: splitId, type: "gateway", subtype: "parallel", name: "Параллельное разветвление", role_id: null, system_ids: [], inputs: [], outputs: [], controls: [], status: "hypothesis", confidence: 0.6, source: [], time_processing: null, time_waiting: null, cost_estimate: null, requirement_ids: [], tags: ["tobe_generated"], confirmed_by: [] },
          { id: joinId, type: "gateway", subtype: "parallel", name: "Слияние параллельных веток", role_id: null, system_ids: [], inputs: [], outputs: [], controls: [], status: "hypothesis", confidence: 0.6, source: [], time_processing: null, time_waiting: null, cost_estimate: null, requirement_ids: [], tags: ["tobe_generated"], confirmed_by: [] }
        );
        out.flows = out.flows.filter((f) => f !== directFlow && f !== predFlow && f !== succFlow);
        out.flows.push(
          { id: `fl_${nanoid(8)}`, from: predFlow.from, to: splitId, condition: null, source: [], confirmed_by: [] },
          { id: `fl_${nanoid(8)}`, from: splitId, to: aId, condition: null, source: [], confirmed_by: [] },
          { id: `fl_${nanoid(8)}`, from: splitId, to: bId, condition: null, source: [], confirmed_by: [] },
          { id: `fl_${nanoid(8)}`, from: aId, to: joinId, condition: null, source: [], confirmed_by: [] },
          { id: `fl_${nanoid(8)}`, from: bId, to: joinId, condition: null, source: [], confirmed_by: [] },
          { id: `fl_${nanoid(8)}`, from: joinId, to: succFlow.to, condition: null, source: [], confirmed_by: [] }
        );
      }
      break;
    }
  }

  return out;
}
