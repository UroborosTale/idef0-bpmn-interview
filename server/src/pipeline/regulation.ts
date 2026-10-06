import type { ProcessLogicModel, ProcessNode } from "../types/model.js";

/**
 * Регламент/положение из PLM (ФТ-М1.1). Промежуточное представление —
 * список абзацев с привязкой к элементам модели (sourceRefs), из которого
 * строится и HTML-предпросмотр, и .docx, и определение устаревших абзацев
 * (ФТ-М1.1.4) при сравнении с более ранней версией модели.
 */
export type RegulationSectionKey = "general" | "terms" | "order" | "responsibility" | "kpi" | "records" | "appendices";

export interface RegulationParagraph {
  id: string;
  section: RegulationSectionKey;
  kind: "heading" | "paragraph" | "listItem";
  indent: number;
  text: string;
  sourceRefs: string[]; // id элементов PLM (node/data/role/kpi/...), к которым привязан абзац
}

export const SECTION_LABELS: Record<RegulationSectionKey, string> = {
  general: "1. Общие положения, цель, область применения",
  terms: "2. Термины и сокращения",
  order: "3. Порядок выполнения",
  responsibility: "4. Ответственность",
  kpi: "5. Показатели",
  records: "6. Записи и документы",
  appendices: "7. Приложения",
};

const SECTION_ORDER: RegulationSectionKey[] = ["general", "terms", "order", "responsibility", "kpi", "records", "appendices"];

function heading(section: RegulationSectionKey): RegulationParagraph {
  return { id: `${section}-heading`, section, kind: "heading", indent: 0, text: SECTION_LABELS[section], sourceRefs: [] };
}

function buildGeneral(model: ProcessLogicModel): RegulationParagraph[] {
  const p = model.process;
  const out: RegulationParagraph[] = [heading("general")];
  out.push({
    id: "general-1",
    section: "general",
    kind: "paragraph",
    indent: 0,
    text: `Настоящий документ определяет порядок выполнения процесса «${p.name}»${p.department ? ` в подразделении «${p.department}»` : ""}.`,
    sourceRefs: [],
  });
  out.push({
    id: "general-2",
    section: "general",
    kind: "paragraph",
    indent: 0,
    text: `Цель процесса: ${p.goal ?? "не определена"}.`,
    sourceRefs: [],
  });
  out.push({
    id: "general-3",
    section: "general",
    kind: "paragraph",
    indent: 0,
    text: `Триггер (событие, инициирующее процесс): ${p.trigger ?? "не определён"}.`,
    sourceRefs: [],
  });
  out.push({
    id: "general-4",
    section: "general",
    kind: "paragraph",
    indent: 0,
    text: `Результат процесса: ${p.result ?? "не определён"}.`,
    sourceRefs: [],
  });
  if (p.owner) {
    out.push({ id: "general-5", section: "general", kind: "paragraph", indent: 0, text: `Владелец процесса: ${p.owner}.`, sourceRefs: [] });
  }
  return out;
}

function buildTerms(model: ProcessLogicModel): RegulationParagraph[] {
  const out: RegulationParagraph[] = [heading("terms")];
  for (const r of model.roles) {
    out.push({
      id: `terms-role-${r.id}`,
      section: "terms",
      kind: "listItem",
      indent: 0,
      text: `${r.name} — ${r.kind === "internal" ? "внутренняя" : "внешняя"} роль-участник процесса.`,
      sourceRefs: [r.id],
    });
  }
  for (const s of model.systems) {
    out.push({ id: `terms-sys-${s.id}`, section: "terms", kind: "listItem", indent: 0, text: `${s.name} — информационная система, используемая в процессе.`, sourceRefs: [s.id] });
  }
  for (const d of model.data) {
    out.push({
      id: `terms-data-${d.id}`,
      section: "terms",
      kind: "listItem",
      indent: 0,
      text: `${d.name} — ${d.kind === "document" ? "документ" : "данные"}, используемые в процессе.`,
      sourceRefs: [d.id],
    });
  }
  if (out.length === 1) out.push({ id: "terms-empty", section: "terms", kind: "paragraph", indent: 0, text: "Термины не выявлены.", sourceRefs: [] });
  return out;
}

function buildOrder(model: ProcessLogicModel): RegulationParagraph[] {
  const out: RegulationParagraph[] = [heading("order")];
  const nodeById = new Map(model.nodes.map((n) => [n.id, n] as const));
  const roleById = new Map(model.roles.map((r) => [r.id, r.name] as const));
  const outAdj = new Map<string, typeof model.flows>();
  for (const f of model.flows) outAdj.set(f.from, [...(outAdj.get(f.from) ?? []), f]);

  const starts = model.nodes.filter((n) => n.type === "event" && n.subtype === "start");
  const inCount = new Map<string, number>();
  for (const f of model.flows) inCount.set(f.to, (inCount.get(f.to) ?? 0) + 1);
  const roots = starts.length > 0 ? starts : model.nodes.filter((n) => (inCount.get(n.id) ?? 0) === 0);

  let counter = 0;
  const globalVisitCount = new Map<string, number>();
  const MAX_REVISITS = 3; // защита от бесконечного разворачивания циклов в тексте

  function walk(nodeId: string, indent: number, pathVisited: Set<string>) {
    const node = nodeById.get(nodeId);
    if (!node) return;

    if (pathVisited.has(nodeId)) {
      out.push({ id: `order-${++counter}`, section: "order", kind: "listItem", indent, text: `Возврат к шагу «${node.name}» — цикл повторяется до выполнения условия выхода.`, sourceRefs: [nodeId] });
      return;
    }
    const visits = (globalVisitCount.get(nodeId) ?? 0) + 1;
    globalVisitCount.set(nodeId, visits);
    if (visits > MAX_REVISITS) return;

    const newPath = new Set(pathVisited);
    newPath.add(nodeId);

    if (node.type === "event") {
      if (node.subtype === "end") {
        out.push({ id: `order-${++counter}`, section: "order", kind: "listItem", indent, text: `Процесс завершается: «${node.name}».`, sourceRefs: [nodeId] });
        return;
      }
      for (const f of outAdj.get(nodeId) ?? []) walk(f.to, indent, newPath);
      return;
    }

    if (node.type === "gateway") {
      const nexts = outAdj.get(nodeId) ?? [];
      out.push({ id: `order-${++counter}`, section: "order", kind: "listItem", indent, text: `Проверяется условие: «${node.name}».`, sourceRefs: [nodeId] });
      for (const f of nexts) {
        const condLabel = f.condition ? f.condition : nexts.length > 1 ? "выполняется данное направление" : "условие выполнено";
        out.push({ id: `order-${++counter}`, section: "order", kind: "listItem", indent: indent + 1, text: `Если ${condLabel}, то:`, sourceRefs: [nodeId, f.id] });
        walk(f.to, indent + 2, newPath);
      }
      return;
    }

    // task / subprocess
    const roleName = node.role_id ? roleById.get(node.role_id) : null;
    const text = roleName ? `${node.name} (исполнитель: ${roleName}).` : `${node.name}.`;
    out.push({ id: `order-${++counter}`, section: "order", kind: "listItem", indent, text, sourceRefs: [nodeId] });
    for (const f of outAdj.get(nodeId) ?? []) walk(f.to, indent, newPath);
  }

  for (const r of roots) walk(r.id, 0, new Set());
  if (out.length === 1) out.push({ id: "order-empty", section: "order", kind: "paragraph", indent: 0, text: "Последовательность шагов не выявлена.", sourceRefs: [] });
  return out;
}

function buildResponsibility(model: ProcessLogicModel): RegulationParagraph[] {
  const out: RegulationParagraph[] = [heading("responsibility")];
  const roleById = new Map(model.roles.map((r) => [r.id, r.name] as const));
  const TYPE_LABEL: Record<string, string> = { R: "исполняет", A: "несёт ответственность за", C: "согласовывает", I: "уведомляется о результате" };
  const tasks = model.nodes.filter((n): n is ProcessNode => n.type === "task" || n.type === "subprocess");

  if (model.raci.length === 0) {
    for (const n of tasks) {
      if (!n.role_id) continue;
      out.push({ id: `resp-${n.id}`, section: "responsibility", kind: "listItem", indent: 0, text: `${roleById.get(n.role_id) ?? "—"} исполняет: «${n.name}».`, sourceRefs: [n.id, n.role_id] });
    }
  } else {
    for (const n of tasks) {
      const entries = model.raci.filter((r) => r.node_id === n.id);
      if (entries.length === 0) continue;
      const byType = entries.map((e) => `${roleById.get(e.role_id) ?? "—"} ${TYPE_LABEL[e.type]}`).join("; ");
      out.push({ id: `resp-${n.id}`, section: "responsibility", kind: "listItem", indent: 0, text: `«${n.name}»: ${byType}.`, sourceRefs: [n.id, ...entries.map((e) => e.role_id)] });
    }
  }
  if (out.length === 1) out.push({ id: "resp-empty", section: "responsibility", kind: "paragraph", indent: 0, text: "Распределение ответственности не выявлено.", sourceRefs: [] });
  return out;
}

function buildKpi(model: ProcessLogicModel): RegulationParagraph[] {
  const out: RegulationParagraph[] = [heading("kpi")];
  for (const k of model.process.kpi) {
    out.push({
      id: `kpi-${k.id}`,
      section: "kpi",
      kind: "listItem",
      indent: 0,
      text: `${k.name}${k.target ? ` — целевое значение: ${k.target}${k.unit ? ` ${k.unit}` : ""}` : ""}.`,
      sourceRefs: [k.id],
    });
  }
  if (out.length === 1) out.push({ id: "kpi-empty", section: "kpi", kind: "paragraph", indent: 0, text: "Показатели процесса не определены.", sourceRefs: [] });
  return out;
}

function buildRecords(model: ProcessLogicModel): RegulationParagraph[] {
  const out: RegulationParagraph[] = [heading("records")];
  for (const d of model.data) {
    out.push({ id: `rec-${d.id}`, section: "records", kind: "listItem", indent: 0, text: `${d.name} (${d.kind === "document" ? "документ" : "данные"}).`, sourceRefs: [d.id] });
  }
  for (const c of model.controls) {
    out.push({ id: `rec-ctl-${c.id}`, section: "records", kind: "listItem", indent: 0, text: `${c.name} — регламентирующий фактор (${c.kind}).`, sourceRefs: [c.id] });
  }
  if (out.length === 1) out.push({ id: "rec-empty", section: "records", kind: "paragraph", indent: 0, text: "Записи и документы не выявлены.", sourceRefs: [] });
  return out;
}

function buildAppendices(): RegulationParagraph[] {
  return [
    heading("appendices"),
    { id: "app-1", section: "appendices", kind: "listItem", indent: 0, text: "Диаграмма IDEF0 (контекст A-0 и декомпозиция A0).", sourceRefs: [] },
    { id: "app-2", section: "appendices", kind: "listItem", indent: 0, text: "Диаграмма BPMN 2.0.", sourceRefs: [] },
  ];
}

/** ФТ-М1.1.2/1.1.5: полный регламент или (structureOnly) только каркас разделов без текста. */
export function buildRegulation(model: ProcessLogicModel, opts?: { structureOnly?: boolean }): RegulationParagraph[] {
  if (opts?.structureOnly) {
    return SECTION_ORDER.map(heading);
  }
  return [
    ...buildGeneral(model),
    ...buildTerms(model),
    ...buildOrder(model),
    ...buildResponsibility(model),
    ...buildKpi(model),
    ...buildRecords(model),
    ...buildAppendices(),
  ];
}
