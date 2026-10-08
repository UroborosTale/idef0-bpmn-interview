import { POSITION_LABELS, eventSpec, triggerSummary, type EventTrigger } from "../shared/events.js";

/**
 * Модель в виде текста для агента: структура по кодам Соглашения с id для ссылок в предложениях. Полный JSON модели
 * велик (цитаты интервью, раскладка), поэтому агент по умолчанию читает этот конспект.
 */

interface N {
  id: string;
  type: string;
  subtype?: string;
  name: string;
  role_id?: string | null;
  inputs?: string[];
  outputs?: string[];
  controls?: string[];
  control_data_ids?: string[];
  system_ids?: string[];
  idef0_parent?: string | null;
  bpmn_scope?: string | null;
  attached_to?: string | null;
  trigger?: EventTrigger | null;
  status?: string;
}

export interface ModelView {
  processCode: string;
  updatedAt: string;
  codes: Record<string, string>;
  issues: { severity: string; rule: string; message: string; element_id: string | null }[];
  /** Замечания, которые аналитик принял с причиной: не исправлять и не предлагать «исправления». */
  accepted?: { rule: string; message: string; element_id: string | null; reason: string }[];
  model: {
    process: { name: string; code?: string | null; owner?: string; goal?: string; trigger?: string; result?: string };
    roles: { id: string; name: string; qualification?: string | null }[];
    systems: { id: string; name: string }[];
    data: { id: string; name: string; supplier?: string | null; consumer?: string | null }[];
    controls: { id: string; name: string }[];
    nodes: N[];
    flows: { id: string; from: string; to: string; condition?: string | null }[];
    assignments?: { node_id: string | null; role_id: string; kind: string; functions?: string[] }[];
    pools?: { id: string; name: string; code?: string | null }[];
    messages?: { id: string; from: string; to: string; name?: string | null }[];
  };
}

/** Событие в конспекте: вид и триггер с параметрами, например «промежуточное, ждёт — Таймер: P3D». */
function eventLabel(n: N): string {
  const spec = eventSpec(n, !!n.attached_to);
  const tr = spec.trigger === "none" ? "" : ` — ${triggerSummary(spec)}`;
  const dir = spec.position === "intermediate" ? (spec.throwing ? ", выбрасывает" : ", ждёт") : "";
  return `${POSITION_LABELS[spec.position].toLowerCase()}${dir}${tr}`;
}

const isFn = (n: N) => (n.type === "task" || n.type === "subprocess") && !n.bpmn_scope;

export function outline(view: ModelView, scope?: string): string {
  const { model, codes } = view;
  const name = <T extends { id: string; name: string }>(xs: T[], id: string) => xs.find((x) => x.id === id)?.name ?? id;
  const names = (xs: { id: string; name: string }[], ids?: string[]) => (ids ?? []).map((i) => `«${name(xs, i)}» [${i}]`).join(", ");
  const lines: string[] = [];
  const p = model.process;
  lines.push(`Процесс «${p.name}»${p.code ? ` — код ${view.processCode}` : " — кода нет"}; версия модели (updatedAt): ${view.updatedAt}`);
  for (const [k, label] of [["owner", "Владелец"], ["goal", "Цель"], ["trigger", "Начало"], ["result", "Результат"]] as const) if (p[k]) lines.push(`${label}: ${p[k]}`);

  const rootId = scope ? (model.nodes.find((n) => n.id === scope) ?? model.nodes.find((n) => codes[n.id] === scope))?.id : undefined;
  if (scope && !rootId) return `Функция «${scope}» не найдена: укажите id или код (например B002.01.01).`;

  const inScope = new Set<string>();
  if (rootId) {
    const add = (id: string) => {
      inScope.add(id);
      for (const n of model.nodes) if ((n.idef0_parent === id || n.bpmn_scope === id) && !inScope.has(n.id)) add(n.id);
    };
    add(rootId);
    for (let a = model.nodes.find((n) => n.id === rootId)?.idef0_parent; a; a = model.nodes.find((n) => n.id === a)?.idef0_parent) inScope.add(a);
  }
  const visible = (id: string) => !rootId || inScope.has(id);

  lines.push("", "Должности:");
  for (const r of model.roles) lines.push(`  [${r.id}] ${r.name}${r.qualification ? ` — ${r.qualification}` : ""}`);
  if (model.roles.length === 0) lines.push("  (нет)");

  lines.push("", "Функции IDEF0 (код [id] название):");
  const assignedTo = (id: string | null) =>
    (model.assignments ?? [])
      .filter((a) => a.node_id === id)
      .map((a) => `${a.kind}: ${name(model.roles, a.role_id)} [${a.role_id}]${a.functions?.length ? ` (${a.functions.join("; ")})` : ""}`)
      .join("; ");
  const procRoles = assignedTo(null);
  if (procRoles) lines.push(`  Роли процесса — ${procRoles}`);
  const walk = (parent: string | null, indent: string) => {
    for (const n of model.nodes.filter((x) => isFn(x) && (x.idef0_parent ?? null) === parent)) {
      if (!visible(n.id)) continue;
      const parts = [
        n.role_id ? `исполнитель: ${name(model.roles, n.role_id)} [${n.role_id}]` : "",
        assignedTo(n.id) ? `роли: ${assignedTo(n.id)}` : "",
        n.inputs?.length ? `вход: ${names(model.data, n.inputs)}` : "",
        n.outputs?.length ? `выход: ${names(model.data, n.outputs)}` : "",
        n.control_data_ids?.length ? `управление-данные: ${names(model.data, n.control_data_ids)}` : "",
        n.controls?.length ? `регламенты: ${names(model.controls, n.controls)}` : "",
        n.system_ids?.length ? `системы: ${names(model.systems, n.system_ids)}` : "",
      ].filter(Boolean);
      lines.push(`${indent}${codes[n.id] ?? "?"} [${n.id}] ${n.name}${n.status === "hypothesis" ? " (гипотеза)" : ""}${parts.length ? ` — ${parts.join("; ")}` : ""}`);
      const steps = model.nodes.filter((s) => s.bpmn_scope === n.id);
      if (steps.length > 0) {
        lines.push(`${indent}  BPMN операции:`);
        for (const s of steps) {
          const kind = s.type === "event" ? `событие ${eventLabel(s)}` : s.type === "gateway" ? `шлюз ${s.subtype ?? ""}` : `задача ${s.subtype ?? ""}`.trim();
          const extra = [s.role_id ? `исполнитель ${s.role_id}` : "", s.attached_to ? `на границе ${s.attached_to}` : "", s.inputs?.length ? `вход ${s.inputs.join(",")}` : "", s.outputs?.length ? `выход ${s.outputs.join(",")}` : "", s.system_ids?.length ? `системы ${s.system_ids.join(",")}` : ""].filter(Boolean);
          lines.push(`${indent}    ${codes[s.id] ? `${codes[s.id]} ` : ""}[${s.id}] ${kind.trim()} «${s.name}»${extra.length ? ` (${extra.join("; ")})` : ""}`);
        }
        const ids = new Set(steps.map((s) => s.id));
        const flows = model.flows.filter((f) => ids.has(f.from) && ids.has(f.to));
        if (flows.length) lines.push(`${indent}    стрелки: ${flows.map((f) => `${f.from}→${f.to}${f.condition ? ` (${f.condition})` : ""} [${f.id}]`).join(", ")}`);
      }
      walk(n.id, `${indent}  `);
    }
  };
  walk(null, "  ");
  const top = model.nodes.filter((n) => !n.idef0_parent && !n.bpmn_scope && visible(n.id));
  const loose = top.filter((n) => !isFn(n));
  if (loose.length > 0) {
    lines.push("  Общая схема процесса (не функции):");
    for (const n of loose) lines.push(`    [${n.id}] ${n.type} ${n.subtype ?? ""} «${n.name}»`);
  }

  if (!rootId) {
    lines.push("", "Документы и данные [id] (поставщик → потребитель):");
    for (const d of model.data) lines.push(`  [${d.id}] ${d.name}${d.supplier || d.consumer ? ` (${d.supplier ?? "—"} → ${d.consumer ?? "—"})` : ""}`);
    if (model.data.length === 0) lines.push("  (нет)");
    lines.push("", `Регламенты: ${model.controls.map((c) => `[${c.id}] ${c.name}`).join("; ") || "(нет)"}`);
    lines.push(`Информационные системы: ${model.systems.map((s) => `[${s.id}] ${s.name}`).join("; ") || "(нет)"}`);
  }
  if ((model.pools ?? []).length > 0) {
    lines.push("", "Внешние пулы:");
    for (const q of model.pools!) lines.push(`  [${q.id}] ${q.code ? `${q.code} ` : ""}${q.name}`);
    for (const m of model.messages ?? []) lines.push(`  сообщение [${m.id}] ${m.from} → ${m.to}${m.name ? ` «${m.name}»` : ""}`);
  }

  const issues = view.issues.filter((i) => !rootId || !i.element_id || visible(i.element_id));
  lines.push("", `Замечания проверок: ${issues.length}`);
  for (const i of issues.slice(0, 60)) lines.push(`  [${i.severity}] ${i.rule}${i.element_id ? ` (${i.element_id})` : ""}: ${i.message}`);
  if (issues.length > 60) lines.push(`  … и ещё ${issues.length - 60}`);
  const accepted = (view.accepted ?? []).filter((i) => !rootId || !i.element_id || visible(i.element_id));
  if (accepted.length > 0) {
    lines.push("", `Принято аналитиком (не исправлять): ${accepted.length}`);
    for (const i of accepted.slice(0, 30)) lines.push(`  ${i.rule}${i.element_id ? ` (${i.element_id})` : ""}: ${i.message} — причина: ${i.reason}`);
  }
  return lines.join("\n");
}
