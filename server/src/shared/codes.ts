/**
 * Структура процессной модели по Соглашению о моделировании (разд. 3): коды уровней, операции и
 * области BPMN. Чистые функции — их используют и сервер (диаграммы, документы, проверки), и редактор.
 *
 *   B002.00.00          процесс            — контекстная диаграмма IDEF0
 *   B002.01.00          подпроцесс         — детальная диаграмма IDEF0
 *   B002.01.01          операция           — диаграмма BPMN
 *   B002.01.01/001      подоперация        — шаг диаграммы BPMN операции
 */

export interface CodeNode {
  id: string;
  type: string;
  idef0_parent?: string | null;
  bpmn_scope?: string | null;
}

export interface CodeModel<N extends CodeNode = CodeNode> {
  nodes: N[];
  process?: { code?: string | null };
}

/** Код процесса по шаблону: группа (A, B, C — латиницей или кириллицей), номер в реестре, затем .00.00. */
const PROCESS_CODE = /^([ABCАВС])(\d{3})(?:\.00\.00)?$/u;

export function parseProcessCode(code: string | null | undefined): { group: string; number: string } | null {
  const m = PROCESS_CODE.exec((code ?? "").trim());
  return m ? { group: m[1], number: m[2] } : null;
}

/** Модель ведётся по структуре Соглашения: у процесса задан код нужного вида. */
export const isStructured = (m: Pick<CodeModel, "process">): boolean => parseProcessCode(m.process?.code) !== null;

const pad = (n: number, width: number) => String(n).padStart(width, "0");
const isFn = (n: CodeNode) => (n.type === "task" || n.type === "subprocess") && !n.bpmn_scope;

/** Функции IDEF0 одного уровня (шаги диаграмм BPMN в их число не входят). */
function siblings<N extends CodeNode>(m: CodeModel<N>, parentId: string | null): N[] {
  if (parentId) return m.nodes.filter((n) => isFn(n) && n.idef0_parent === parentId);
  const top = m.nodes.filter((n) => isFn(n) && !n.idef0_parent);
  return top.length > 0 ? top : m.nodes.filter((n) => n.type === "task" && !n.bpmn_scope);
}

/** Код процесса в целом: B002.00.00; у модели без кода — прежнее «A0». */
export function processCodeOf(m: Pick<CodeModel, "process">): string {
  const p = parseProcessCode(m.process?.code);
  return p ? `${p.group}${p.number}.00.00` : "A0";
}

/**
 * Коды функций IDEF0. Со структурным кодом процесса — по Соглашению (B002.01.00, B002.01.01); без него —
 * прежние A1, A21… Нумерация сквозная в пределах уровня и следует порядку функций в модели, поэтому
 * пропусков не бывает: при удалении функции следующие сдвигаются.
 */
export function functionCodes<N extends CodeNode>(m: CodeModel<N>): Map<string, string> {
  const codes = new Map<string, string>();
  const p = parseProcessCode(m.process?.code);
  const walk = (parentId: string | null, parentCode: string, depth: number) => {
    siblings(m, parentId).forEach((n, i) => {
      if (codes.has(n.id)) return; // защита от циклов в idef0_parent
      let code: string;
      if (!p) code = `${parentCode}${i + 1}`;
      else if (depth === 1) code = `${p.group}${p.number}.${pad(i + 1, 2)}.00`;
      else if (depth === 2) code = `${parentCode.slice(0, -2)}${pad(i + 1, 2)}`;
      else code = `${parentCode}/${pad(i + 1, 3)}`;
      codes.set(n.id, code);
      walk(n.id, code, depth + 1);
    });
  };
  walk(null, "A", 1);
  return codes;
}

/**
 * Номера блоков, как в Business Studio: A1, A2 — подпроцессы на диаграмме A0, A3.1 — операция в подпроцессе A3. Номер — позиция
 * блока на своей диаграмме, поэтому он есть и у моделей без кода процесса. Диаграмме BPMN операции соответствует номер
 * «<номер операции>.1» (A3.1.1) — его вычисляет навигатор.
 */
export function blockNumbers<N extends CodeNode>(m: CodeModel<N>): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (parentId: string | null, prefix: string) => {
    siblings(m, parentId).forEach((n, i) => {
      if (out.has(n.id)) return; // защита от циклов в idef0_parent
      const num = prefix ? `${prefix}.${i + 1}` : `A${i + 1}`;
      out.set(n.id, num);
      walk(n.id, num);
    });
  };
  walk(null, "");
  return out;
}

/** Глубина функции в дереве IDEF0: 1 — верхний уровень (подпроцесс), 2 — операция. 0 — не функция. */
// Словарь узлов по массиву: functionDepth вызывается для каждого узла, и построение словаря заново на каждый вызов давало квадрат.
// Массивы модели неизменяемы (правка создаёт новый); на случай правки на месте словарь пересобирается при несовпадении размера.
const nodeIndex = new WeakMap<object, { len: number; idx: Map<string, CodeNode> }>();
function indexOf<N extends CodeNode>(nodes: N[]): Map<string, N> {
  let hit = nodeIndex.get(nodes);
  if (!hit || hit.len !== nodes.length) {
    hit = { len: nodes.length, idx: new Map(nodes.map((n) => [n.id, n] as const)) };
    nodeIndex.set(nodes, hit);
  }
  return hit.idx as Map<string, N>;
}

export function functionDepth<N extends CodeNode>(m: CodeModel<N>, id: string): number {
  const byId = indexOf(m.nodes);
  let d = 0;
  let cur = byId.get(id);
  const seen = new Set<string>();
  while (cur && isFn(cur) && !seen.has(cur.id)) {
    seen.add(cur.id);
    d++;
    cur = cur.idef0_parent ? byId.get(cur.idef0_parent) : undefined;
  }
  return cur && !isFn(cur) ? 0 : d;
}

/**
 * Функции, у которых есть собственная диаграмма BPMN: операции (листья IDEF0 с глубиной 2 и больше),
 * а в структурированной модели ещё и подпроцессы без декомпозиции.
 */
export function bpmnHosts<N extends CodeNode>(m: CodeModel<N>): N[] {
  const hasKids = new Set(m.nodes.filter((n) => isFn(n) && n.idef0_parent).map((n) => n.idef0_parent as string));
  const structured = isStructured(m);
  return m.nodes.filter((n) => {
    if (!isFn(n) || hasKids.has(n.id)) return false;
    const d = functionDepth(m, n.id);
    return d >= 2 || (structured && d === 1);
  });
}

/** Коды подопераций: шаги-задачи диаграммы BPMN операции нумеруются B002.01.01/001, /002… */
export function stepCodes<N extends CodeNode>(m: CodeModel<N>): Map<string, string> {
  const fn = functionCodes(m);
  const out = new Map<string, string>();
  const counters = new Map<string, number>();
  for (const n of m.nodes) {
    if (!n.bpmn_scope || n.type !== "task") continue;
    const host = fn.get(n.bpmn_scope);
    if (!host) continue;
    const k = (counters.get(n.bpmn_scope) ?? 0) + 1;
    counters.set(n.bpmn_scope, k);
    out.set(n.id, `${host}/${pad(k, 3)}`);
  }
  return out;
}
