import { FUNCTION_CODE, normalizeCode } from "@shared/rules";
import { functionCodes, functionDepth, isStructured } from "@shared/codes";
import type { ProcessLogicModel, ProcessNode } from "../../types";
import { deleteNode, nextId } from "../bpmn-editor/model-ops";
import { addFunction } from "../idef0-editor/ops";
import { addOperationSkeleton, normalizedProcessCode } from "./quick-fixes";

/**
 * Операции над структурой процесса: перестановка и перенос функций (коды по Соглашению пересчитываются, ссылки на них
 * в текстовых полях обновляются), добавление дочерней функции, оценка удаления и создание структуры по текстовому
 * списку (мастер). Чистые функции над моделью — их история правок отменяется Ctrl+Z.
 */

type M = ProcessLogicModel;

const isFn = (n: ProcessNode) => (n.type === "task" || n.type === "subprocess") && !n.bpmn_scope;

/** Куда перенести функцию: перед или после другой, либо внутрь (последней дочерней). */
export type MoveTarget = { kind: "before" | "after" | "into"; id: string };

const parentOf = (m: M, target: MoveTarget): string | null | undefined => {
  const t = m.nodes.find((n) => n.id === target.id);
  if (!t || !isFn(t)) return undefined;
  return target.kind === "into" ? t.id : t.idef0_parent ?? null;
};

/** Высота поддерева функции: 1 — без вложенных, 2 — подпроцесс с операциями. */
function subtreeHeight(m: M, id: string, seen = new Set<string>()): number {
  if (seen.has(id)) return 0;
  seen.add(id);
  const kids = m.nodes.filter((n) => isFn(n) && n.idef0_parent === id);
  return 1 + Math.max(0, ...kids.map((k) => subtreeHeight(m, k.id, seen)));
}

function ancestorsOf(m: M, id: string | null): Set<string> {
  const out = new Set<string>();
  for (let cur = id ? m.nodes.find((n) => n.id === id) : undefined; cur && !out.has(cur.id); cur = cur.idef0_parent ? m.nodes.find((n) => n.id === cur!.idef0_parent) : undefined) out.add(cur.id);
  return out;
}

/** Причина, по которой перенос невозможен, или null. В модели с кодом процесса глубже операции функции не бывают. */
export function moveProblem(m: M, id: string, target: MoveTarget): string | null {
  const node = m.nodes.find((n) => n.id === id);
  if (!node || !isFn(node)) return "Переносить можно только функции";
  if (target.id === id) return "Функцию нельзя перенести саму на себя";
  const parent = parentOf(m, target);
  if (parent === undefined) return "Целью переноса может быть только функция";
  if (ancestorsOf(m, parent).has(id)) return "Функцию нельзя перенести внутрь самой себя";
  if (isStructured(m)) {
    const depth = parent === null ? 1 : functionDepth(m, parent) + 1;
    if (depth + subtreeHeight(m, id) - 1 > 2) return "По Соглашению подпроцесс делится на операции, глубже операции функции не бывают";
  }
  return null;
}

/** Коды функций, которые поменяются после переноса: «B002.01.02 → B002.01.03». */
export function previewMove(m: M, id: string, target: MoveTarget): { from: string; to: string } | null {
  if (moveProblem(m, id, target)) return null;
  const next = moveFunction(m, id, target);
  const from = functionCodes(m).get(id);
  const to = functionCodes(next).get(id);
  return from && to ? { from, to } : null;
}

/**
 * Коды функций, перечисленные в текстовых полях (поставщик и потребитель продуктов, код внешнего пула), после пересчёта
 * кодов остаются верными: «B002.01.02» в поле поставщика переписывается на новый код той же функции.
 */
export function remapCodes(before: M, after: M): M {
  if (!isStructured(after)) return after;
  const a = functionCodes(before);
  const b = functionCodes(after);
  const map = new Map<string, string>();
  for (const [id, code] of a) {
    const next = b.get(id);
    if (next && next !== code) map.set(code, next);
  }
  if (map.size === 0) return after;
  const fix = (text: string | null | undefined) => (text ? text.replace(FUNCTION_CODE, (raw) => map.get(normalizeCode(raw)) ?? raw) : text);
  return {
    ...after,
    data: after.data.map((d) => (d.supplier || d.consumer ? { ...d, supplier: fix(d.supplier), consumer: fix(d.consumer) } : d)),
    pools: (after.pools ?? []).map((p) => (p.code ? { ...p, code: fix(p.code) } : p)),
  };
}

/** Переносит функцию вместе с вложенными и шагами диаграмм; коды пересчитываются, ссылки на них в текстах обновляются. */
export function moveFunction(m: M, id: string, target: MoveTarget): M {
  if (moveProblem(m, id, target)) return m;
  const node = m.nodes.find((n) => n.id === id)!;
  const parent = parentOf(m, target)!;
  const rest = m.nodes.filter((n) => n.id !== id);
  const moved: ProcessNode = { ...node, idef0_parent: parent, ...(parent !== (node.idef0_parent ?? null) ? { idef0_layout: null } : {}) };
  const at = rest.findIndex((n) => n.id === target.id);
  let index: number;
  if (target.kind === "before") index = at;
  else if (target.kind === "after") index = at + 1;
  else {
    // последней дочерней: после последнего из уже имеющихся дочерних функций, иначе сразу за целью
    const kidsAt = rest.map((n, i) => (isFn(n) && n.idef0_parent === target.id ? i : -1)).filter((i) => i >= 0);
    index = kidsAt.length > 0 ? Math.max(...kidsAt) + 1 : at + 1;
  }
  const nodes = [...rest.slice(0, index), moved, ...rest.slice(index)];
  return remapCodes(m, { ...m, nodes });
}

/** Сдвиг функции на одну позицию среди равных: вверх (-1) или вниз (1); на краю списка модель не меняется. */
export function shiftFunction(m: M, id: string, dir: -1 | 1): M {
  const node = m.nodes.find((n) => n.id === id);
  if (!node) return m;
  const siblings = m.nodes.filter((n) => isFn(n) && (n.idef0_parent ?? null) === (node.idef0_parent ?? null));
  const i = siblings.findIndex((n) => n.id === id);
  const other = siblings[i + dir];
  if (!other) return m;
  return moveFunction(m, id, { kind: dir < 0 ? "before" : "after", id: other.id });
}

/** Дочерняя функция (операция в подпроцессе, подфункция) в конец списка; id новой возвращается. */
export function addChildFunction(m: M, parentId: string | null): { model: M; id: string } {
  const r = addFunction(m, parentId, 300, 300);
  return { model: r.model, id: r.id! };
}

/** Что исчезнет при удалении функции: функции, шаги диаграмм BPMN, стрелки — для подтверждения. */
export function deleteImpact(m: M, id: string): { functions: number; steps: number; flows: number } {
  const after = deleteNode(m, id);
  const kept = new Set(after.nodes.map((n) => n.id));
  const gone = m.nodes.filter((n) => !kept.has(n.id));
  return { functions: gone.filter(isFn).length, steps: gone.filter((n) => !!n.bpmn_scope).length, flows: m.flows.length - after.flows.length };
}

// --- структура по текстовому списку (мастер) ---

export interface OutlineItem {
  /** 0 — подпроцесс, 1 — операция. */
  level: 0 | 1;
  name: string;
  line: number;
}

/**
 * Разбор списка «подпроцесс → операции» с отступами. Номера, коды и маркеры в начале строк («B002.01.01 Название»,
 * «1.2. Название», «- Название») отбрасываются: коды выдаёт приложение. Всё, что глубже операции, считается операцией.
 */
export function parseOutline(text: string): { items: OutlineItem[]; problems: string[] } {
  const items: OutlineItem[] = [];
  const problems: string[] = [];
  const stack: number[] = [];
  text.split(/\r?\n/).forEach((raw, idx) => {
    if (!raw.trim()) return;
    const indent = raw.match(/^[ \t]*/)![0].replace(/\t/g, "    ").length;
    const name = raw
      .trim()
      .replace(/^[-*•–]\s+/, "")
      .replace(/^[ABCАВС]\d{3}(?:\.\d{2}\.\d{2})?\s+/u, "")
      .replace(/^\d+(?:\.\d+)*[.)]?\s+/, "")
      .trim();
    if (!name) return;
    while (stack.length > 0 && indent < stack[stack.length - 1]) stack.pop();
    if (stack.length === 0 || indent > stack[stack.length - 1]) stack.push(indent);
    const depth = stack.length - 1;
    const level: 0 | 1 = depth === 0 ? 0 : 1;
    if (depth > 1) problems.push(`Строка ${idx + 1}: «${name}» глубже операции — записана как операция (по Соглашению подпроцесс делится на операции, глубже функций нет).`);
    items.push({ level, name, line: idx + 1 });
  });
  const seen = new Map<string, number>();
  for (const it of items) {
    const key = it.name.toLowerCase().replace(/\s+/g, " ");
    if (seen.has(key)) problems.push(`Строка ${it.line}: название «${it.name}» повторяет строку ${seen.get(key)} — названия блоков должны быть уникальными.`);
    else seen.set(key, it.line);
  }
  items.forEach((it, i) => {
    if (it.level === 0 && items[i + 1]?.level !== 1) problems.push(`Строка ${it.line}: у подпроцесса «${it.name}» нет операций.`);
  });
  const subs = items.filter((i) => i.level === 0).length;
  if (subs > 0 && (subs < 3 || subs > 6)) problems.push(`Подпроцессов ${subs}: на диаграмме IDEF0 рекомендуется 3–6 блоков.`);
  return { items, problems };
}

export interface StructureOptions {
  /** Код процесса («B002», «b2», «B002.00.00»); пусто — оставить прежний. */
  code?: string;
  group?: string;
  /** Создать у каждой операции заготовку диаграммы BPMN (начало → шаг → конец). */
  skeletons?: boolean;
}

/** Добавляет в модель подпроцессы и операции из списка; при необходимости — код процесса, группу и заготовки диаграмм. */
export function applyStructure(m: M, items: OutlineItem[], opts: StructureOptions = {}): M {
  let model = m;
  const taken: string[] = [];
  const newId = () => {
    const id = nextId("n", [...model.nodes.map((n) => n.id), ...taken]);
    taken.push(id);
    return id;
  };
  const created: ProcessNode[] = [];
  let parent: string | null = null;
  const ops: string[] = [];
  for (const it of items) {
    const id = newId();
    if (it.level === 0) parent = id;
    else ops.push(id);
    created.push({
      id,
      type: "task",
      name: it.name,
      role_id: null,
      system_ids: [],
      inputs: [],
      outputs: [],
      controls: [],
      idef0_parent: it.level === 0 ? null : parent,
      status: "confirmed",
      confidence: 1,
      source: [],
      requirement_ids: [],
      tags: [],
      confirmed_by: [],
    });
  }
  const code = opts.code?.trim() ? normalizedProcessCode(opts.code) : null;
  model = {
    ...model,
    nodes: [...model.nodes, ...created],
    process: { ...model.process, ...(code ? { code } : {}), ...(opts.group?.trim() ? { group: opts.group.trim() } : {}) },
  };
  if (opts.skeletons) for (const id of ops) model = addOperationSkeleton(model, id);
  return model;
}