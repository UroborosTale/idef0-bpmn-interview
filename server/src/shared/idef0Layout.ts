/**
 * Раскладка диаграмм IDEF0 — общая для сервера (SVG, VSDX, draw.io) и редактора в браузере
 * (web подключает этот файл через псевдоним @shared). Только чистые функции без зависимостей:
 * модель описана структурно, чтобы подходили и серверные, и клиентские типы.
 */

import { functionCodes } from "./codes.js";
import { wrapText } from "./bpmnLabels.js";
import { orthogonalPath, type Side } from "./bpmnManual.js";

export type Pt = [number, number];
export type LabelSide = "left" | "right" | "top" | "bottom" | "mid";
export type ArrowKind = "input" | "link" | "output" | "control" | "controlData" | "controlLink" | "role" | "system";

/** Ручной маршрут стрелки (структурно совпадает с ArrowRoute модели): чего нет — выбирает автоматическая прокладка. */
export interface ArrowRoute {
  /** Положение конца у блока функции стрелки вдоль стороны: 0…1 слева направо (верх, низ) или сверху вниз (лево, право). */
  pos?: number;
  /** У связи между функциями — положение конца на правой стороне блока-источника. */
  from_pos?: number;
  /** Внутренние точки излома от начала стрелки к концу. */
  points?: Pt[];
  /** Свободный конец внешней стрелки. */
  end?: Pt;
  /** Сдвиг подписи от обычного места. */
  label?: Pt;
}

/** Ключ маршрута в arrow_routes функции. */
export const arrowRouteKey = (kind: ArrowKind, entityId: string) => `${kind}:${entityId}`;

/**
 * Туннель стрелки (в IDEF0 — скобки у конца): стрелка не продолжается на соседней диаграмме. up — у свободного конца
 * (на диаграмме выше её нет), down — у блока (на диаграмме ниже, в декомпозиции функции, её нет). Ключ — вид:сущность,
 * как у ручных маршрутов. Туннелируются только внешние стрелки: входы, выходы, управление и управление-данные.
 */
export interface ArrowTunnel {
  up?: boolean;
  down?: boolean;
  /** Вид помеченного конца: «tunnel» — скобки (стрелка продолжается на другой диаграмме), «boundary» — штрих:
   *  стрелка кончается на рамке диаграммы и дальше не идёт (как «Граница» в Business Studio), «offpage» — ссылка
   *  на диаграмму: значок страницы у конца (В11). */
  upKind?: "tunnel" | "boundary" | "offpage";
  downKind?: "tunnel" | "boundary" | "offpage";
}
export const TUNNEL_KINDS: ReadonlySet<ArrowKind> = new Set<ArrowKind>(["input", "output", "control", "controlData"]);

/** Дуга скобки туннеля — квадратичная кривая; одни и те же дуги рисуют редактор, SVG и Visio. */
export interface TunnelArc {
  from: Pt;
  ctl: Pt;
  to: Pt;
}

/**
 * Скобки «( )» у помеченных концов стрелки: у свободного конца (tunnelUp) и у блока (tunnelDown). Скобки охватывают
 * конец стрелки: центр на 7 px внутрь от конца, расстояние между скобками 10 px, высота 14 px.
 */
export function tunnelArcs(a: { kind: ArrowKind; points: Pt[]; tunnelUp?: boolean; tunnelDown?: boolean; boundaryUp?: boolean; boundaryDown?: boolean }): TunnelArc[] {
  const pts = a.points;
  if (pts.length < 2 || !TUNNEL_KINDS.has(a.kind) || (!a.tunnelUp && !a.tunnelDown && !a.boundaryUp && !a.boundaryDown)) return [];
  const last = pts.length - 1;
  const freeAtEnd = FREE_END[a.kind] === "end";
  const free = freeAtEnd ? { at: pts[last], from: pts[last - 1] } : { at: pts[0], from: pts[1] };
  const block = freeAtEnd ? { at: pts[0], from: pts[1] } : { at: pts[last], from: pts[last - 1] };
  const out: TunnelArc[] = [];
  for (const [on, boundary, end] of [[a.tunnelUp, false, free], [a.tunnelDown, false, block], [a.boundaryUp, true, free], [a.boundaryDown, true, block]] as const) {
    if (!on) continue;
    const len = Math.hypot(end.at[0] - end.from[0], end.at[1] - end.from[1]) || 1;
    const t = [(end.at[0] - end.from[0]) / len, (end.at[1] - end.from[1]) / len];
    const n = [-t[1], t[0]];
    const c = [end.at[0] - t[0] * 7, end.at[1] - t[1] * 7];
    if (boundary) {
      // «Граница»: один прямой штрих поперёк стрелки у самого конца (ctl в середине — кривая вырождается в отрезок,
      // поэтому редактор, SVG и Visio рисуют его одной и той же веткой кода).
      out.push({ from: [c[0] + n[0] * 8, c[1] + n[1] * 8], ctl: [c[0], c[1]], to: [c[0] - n[0] * 8, c[1] - n[1] * 8] });
      continue;
    }
    for (const s of [-1, 1]) {
      const b = [c[0] + t[0] * s * 5, c[1] + t[1] * s * 5];
      out.push({
        from: [b[0] + n[0] * 7, b[1] + n[1] * 7],
        ctl: [b[0] + t[0] * s * 4, b[1] + t[1] * s * 4],
        to: [b[0] - n[0] * 7, b[1] - n[1] * 7],
      });
    }
  }
  return out;
}

/**
 * В11: значки «ссылка на диаграмму» (OffPageReference) у помеченных концов стрелки. Центр страницы — на 12 px
 * внутрь от конца: значок стоит перед наконечником и не выходит за рамку диаграммы.
 */
export function offpageMarks(a: { kind: ArrowKind; points: Pt[]; offpageUp?: boolean; offpageDown?: boolean }): Pt[] {
  const pts = a.points;
  if (pts.length < 2 || (!a.offpageUp && !a.offpageDown)) return [];
  const last = pts.length - 1;
  const freeAtEnd = FREE_END[a.kind] === "end";
  const free = freeAtEnd ? { at: pts[last], from: pts[last - 1] } : { at: pts[0], from: pts[1] };
  const block = freeAtEnd ? { at: pts[0], from: pts[1] } : { at: pts[last], from: pts[last - 1] };
  const out: Pt[] = [];
  const put = (end: { at: Pt; from: Pt }) => {
    const len = Math.hypot(end.at[0] - end.from[0], end.at[1] - end.from[1]) || 1;
    out.push([end.at[0] - ((end.at[0] - end.from[0]) / len) * 12, end.at[1] - ((end.at[1] - end.from[1]) / len) * 12]);
  };
  if (a.offpageUp) put(free);
  if (a.offpageDown) put(block);
  return out;
}

/** В12: примечание к функции — жёлтый блок справа от неё; ширина 150, строки по 22 знака. */
export const NOTE_W = 150;
export const NOTE_GAP = 12;

export function noteBox(b: Box, text: string): { x: number; y: number; w: number; h: number; lines: string[] } | null {
  const lines = wrapText(text, 22, 8);
  if (lines.length === 0) return null;
  return { x: b.x + b.w + NOTE_GAP, y: b.y, w: NOTE_W, h: Math.max(34, lines.length * 13 + 10), lines };
}

/**
 * Стороны стрелки в направлении от начала к концу: из какой стороны выходит начало (куда идёт первый отрезок) и в какую сторону
 * смотрит нормаль у конца (с какой стороны подходит последний отрезок). Для orthogonalPath и ручек редактора.
 */
export const ARROW_DIRS: Record<ArrowKind, { from: Side; to: Side }> = {
  input: { from: "R", to: "L" },
  link: { from: "R", to: "L" },
  output: { from: "R", to: "L" },
  control: { from: "B", to: "T" },
  controlData: { from: "B", to: "T" },
  controlLink: { from: "R", to: "T" },
  role: { from: "T", to: "B" },
  system: { from: "T", to: "B" },
};
/** Сторона блока функции стрелки, у которой лежит конец стрелки (вход — слева, управление — сверху, выход — справа, механизм — снизу). */
export const PORT_SIDE: Record<ArrowKind, Side> = { input: "L", link: "L", output: "R", control: "T", controlData: "T", controlLink: "T", role: "B", system: "B" };
/** Конец без блока (внешняя стрелка): у входа, управления и механизма — начало, у выхода — конец. */
export const FREE_END: Partial<Record<ArrowKind, "start" | "end">> = { input: "start", control: "start", controlData: "start", role: "start", system: "start", output: "end" };
/** Меньше этого расстояния свободный конец не подводят к блоку: не поместятся стрелка и её наконечник. */
export const MIN_FREE = 48;

export const BLOCK_W = 170;
export const BLOCK_H = 90;
export const STEP_X = 340;
export const STEP_Y = 150;
export const MARGIN = 220;
const STUB_CTRL = 46; // управление сверху
const STUB_MECH = 40; // механизмы снизу

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Минимум полей узла, нужный раскладке. */
export interface NodeLike {
  id: string;
  type: string;
  name: string;
  idef0_parent?: string | null;
  bpmn_scope?: string | null;
  idef0_layout?: { x: number; y: number } | null;
  arrow_routes?: Record<string, ArrowRoute> | null;
  tunnels?: Record<string, ArrowTunnel> | null;
  role_id?: string | null;
  inputs: string[];
  outputs: string[];
  controls: string[];
  control_data_ids?: string[];
  system_ids: string[];
}

interface Named {
  id: string;
  name: string;
}

export interface ModelLike<N extends NodeLike = NodeLike> {
  nodes: N[];
  data: Named[];
  controls: Named[];
  roles: Named[];
  systems: Named[];
  process?: { code?: string | null };
  /** Назначения ролей: должности владельца, исполнителя, соисполнителя и контролёра — механизмы функции. */
  assignments?: { node_id: string | null; role_id: string; kind: string }[];
}

/** Виды ролей, которые на диаграмме IDEF0 показываются механизмами (наблюдатель — только информационный поток). */
const MECHANISM_KINDS = new Set(["owner", "executor", "coexecutor", "controller"]);

/** Должности-механизмы функции: исполнитель по умолчанию, затем назначенные роли в порядке назначения. */
export function mechanismRoleIds(m: { assignments?: { node_id: string | null; role_id: string; kind: string }[] }, node: { id: string; role_id?: string | null }): string[] {
  const ids: string[] = [];
  if (node.role_id) ids.push(node.role_id);
  for (const a of m.assignments ?? []) if (a.node_id === node.id && MECHANISM_KINDS.has(a.kind) && !ids.includes(a.role_id)) ids.push(a.role_id);
  return ids;
}

export interface Arrow {
  key: string; // вид:функция:сущность — стабилен, пока не меняется состав связей
  kind: ArrowKind;
  entityId: string;
  label: string;
  nodeId: string; // функция, к которой привязана стрелка (для link/controlLink — потребитель)
  fromId?: string; // для link/controlLink — источник
  points: Pt[];
  side: LabelSide;
  /** Ряд подписи (0, 1, 2): соседние подписи сверху/снизу блока разносятся по высоте, чтобы не налезать. */
  labelRow?: number;
  /** Сдвиг подписи от обычного места (ручной маршрут). */
  labelOffset?: Pt;
  /** Туннель у свободного конца (стрелки нет на диаграмме выше) и у блока (нет на диаграмме ниже): скобки у этих концов. */
  tunnelUp?: boolean;
  tunnelDown?: boolean;
  /** Конец стрелки помечен «Границей» — штрих на конце (см. tunnelArcs). */
  boundaryUp?: boolean;
  boundaryDown?: boolean;
  /** В11: конец стрелки — ссылка на диаграмму («OffPageReference»): у конца рисуется значок страницы. */
  offpageUp?: boolean;
  offpageDown?: boolean;
  /** Маршрут правился вручную: положение конца, точки излома, свободный конец или подпись заданы пользователем. */
  manual?: boolean;
  /** Подпись не рисуется: механизм общий для нескольких блоков, подпись стоит на «шине» у одной из его стрелок. */
  labelHidden?: boolean;
  /** Стрелка общего механизма с подписью: подпись одной строкой над «шиной», от её начала. */
  bus?: boolean;
  /** ICOM-код на конце у блока (I1, C2, O1, M1): номер — на сущность в классе, как в Business Studio. */
  code?: string;
  /** Где рисовать код: сразу снаружи блока у того конца, которым стрелка входит в него или выходит. */
  codeAt?: Pt;
  codeAnchor?: "start" | "end";
}

export interface FunctionBlock<N extends NodeLike = NodeLike> {
  node: N;
  code: string;
  box: Box;
  hasChildren: boolean;
}

export interface Idef0Layout<N extends NodeLike = NodeLike> {
  functions: FunctionBlock<N>[];
  arrows: Arrow[];
}

// Шаги диаграммы BPMN операции (bpmn_scope) — подоперации, а не функции IDEF0.
const isFn = (n: NodeLike) => (n.type === "task" || n.type === "subprocess") && !n.bpmn_scope;

/**
 * Функции одной диаграммы: parentId = null — уровень A0 (верхний; если верхних нет — все задачи),
 * иначе — вложенные функции указанного узла (декомпозиция вглубь через idef0_parent).
 */
export function functionsOf<N extends NodeLike>(m: { nodes: N[] }, parentId: string | null = null): N[] {
  if (parentId) return m.nodes.filter((n) => isFn(n) && n.idef0_parent === parentId);
  const top = m.nodes.filter((n) => isFn(n) && !n.idef0_parent);
  return top.length > 0 ? top : m.nodes.filter((n) => n.type === "task" && !n.bpmn_scope);
}

export const hasChildren = (m: { nodes: NodeLike[] }, id: string) => m.nodes.some((c) => isFn(c) && c.idef0_parent === id);

/**
 * Коды функций: по Соглашению о моделировании (B002.01.00, B002.01.01), если у процесса задан код нужного вида,
 * иначе иерархические A1, A2, A31… (подробности — shared/codes.ts).
 */
export function idef0Codes(m: { nodes: NodeLike[]; process?: { code?: string | null } }): Map<string, string> {
  return functionCodes(m);
}
export const defaultPos = (i: number) => ({ x: MARGIN + i * STEP_X, y: MARGIN + i * STEP_Y });

/** Равномерно раскладывает n стрелок вдоль стороны длиной len, не плотнее max. */
const spread = (len: number, n: number, max: number, pad: number) => (n > 1 ? Math.min(max, (len - 2 * pad) / (n - 1)) : 0);
/** Ряд подписи i-й из n стрелок на одной стороне: подписи шире шага между стрелками, поэтому чередуем до трёх рядов. */
const rowOf = (i: number, n: number) => (n > 1 ? i % Math.min(3, n) : 0);
const LABEL_ROW_H = 12;
/** Подпись управления/механизма начинается чуть правее своей вертикали, чтобы линия стрелки не перечёркивала текст. */
const LABEL_START_DX = 3;

/** Подпись стрелки переносится по словам: до 34 знаков в строке и до 3 строк (как у Business Studio), строки разделены «\n». */
export const wrapLabel = (text: string, wide: boolean | "side" = false): string => (wide === "side" ? wrapText(text, 55, 2) : wide ? wrapText(text, 60, 2) : wrapText(text, 40, 2)).join("\n");
/** Ширина подписи стрелки в пикселях (кегль 10,5): по самой длинной строке после переноса. */
export const labelWidth = (wrapped: string): number => Math.max(1, ...wrapped.split("\n").map((l) => l.length)) * 6 + 4;
/** Зазор между подписями в одной строке. */
const LABEL_GAP = 6;
/** Строк подписей над блоком или под ним — не больше: дальше они уходят слишком далеко от стрелки. */
const MAX_LABEL_ROWS = 14;

export interface LabelRect {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}
const rectsHit = (a: LabelRect, b: LabelRect) => a.x0 < b.x1 + LABEL_GAP && b.x0 < a.x1 + LABEL_GAP && a.y0 < b.y1 && b.y0 < a.y1;

/**
 * Строки подписей стрелок, стоящих в ряд (управление сверху, механизмы снизу): подпись садится в первую строку, где она не
 * налезает на уже поставленные по ширине (по x), а если задана высота строки `y` — ещё и на чужие подписи `obstacles` (подписи
 * связей между блоками и внешних стрелок), иначе — в следующую. Раньше строки шли по кругу «0, 1, 2, 0…», и подписи шире шага между
 * стрелками налезали друг на друга через две.
 */
export function assignLabelRows(items: { x: number; label: string }[], opts: { obstacles?: LabelRect[]; /** y первой строки подписи из `lines` строк, поставленной в ряд `row`. */ y?: (item: number, row: number, lines: number) => number } = {}): number[] {
  // справа налево: у правой стрелки подпись ближе всего к блоку, а длинные подписи левых уходят выше (ниже), как в Business Studio
  const order = items.map((_, i) => i).sort((i, j) => items[j].x - items[i].x);
  const rows: { x: number; w: number }[][] = [];
  const placed: LabelRect[] = [];
  const out: number[] = new Array(items.length).fill(0);
  for (const i of order) {
    const wrapped = wrapLabel(items[i].label, true); // в рядах — подписи над блоком и под ним: длинная строка
    const w = labelWidth(wrapped);
    // многострочная подпись занимает столько рядов, сколько в ней строк
    const h = wrapped.split("\n").length;
    let r = 0;
    const blocked = (row: number) => {
      if (opts.y) {
        // высоты строк заданы: подписи сравниваются настоящими прямоугольниками (начала стрелок могут стоять на разной глубине)
        const y = opts.y(i, row, h);
        const mine = { x0: items[i].x + LABEL_START_DX, x1: items[i].x + LABEL_START_DX + w, y0: y - 10, y1: y + 2 + (h - 1) * LABEL_ROW_H };
        return placed.some((o) => rectsHit(mine, o)) || (opts.obstacles ?? []).some((o) => rectsHit(mine, o));
      }
      for (let k = row; k < row + h; k++) if ((rows[k] ?? []).some((q) => items[i].x < q.x + q.w + LABEL_GAP && q.x < items[i].x + w + LABEL_GAP)) return true;
      return false;
    };
    while (r < MAX_LABEL_ROWS - h && blocked(r)) r++;
    for (let k = r; k < r + h; k++) (rows[k] ??= []).push({ x: items[i].x, w });
    if (opts.y) {
      const y = opts.y(i, r, h);
      placed.push({ x0: items[i].x + LABEL_START_DX, x1: items[i].x + LABEL_START_DX + w, y0: y - 10, y1: y + 2 + (h - 1) * LABEL_ROW_H });
    }
    out[i] = r;
  }
  return out;
}

/** Блоки и ICOM-стрелки диаграммы (parentId = null — A0). */
export function layoutIdef0<N extends NodeLike>(m: ModelLike<N>, parentId: string | null = null): Idef0Layout<N> {
  const dataById = new Map(m.data.map((d) => [d.id, d] as const));
  const controlById = new Map(m.controls.map((c) => [c.id, c] as const));
  const roleById = new Map(m.roles.map((r) => [r.id, r] as const));
  const systemById = new Map(m.systems.map((s) => [s.id, s] as const));
  const codes = idef0Codes(m);

  const fnNodes = functionsOf(m, parentId);
  const functions: FunctionBlock<N>[] = fnNodes.map((node, i) => ({
    node,
    code: codes.get(node.id) ?? `A${i + 1}`,
    box: { x: node.idef0_layout?.x ?? defaultPos(i).x, y: node.idef0_layout?.y ?? defaultPos(i).y, w: BLOCK_W, h: BLOCK_H },
    hasChildren: hasChildren(m, node.id),
  }));
  const blockOf = new Map(functions.map((f) => [f.node.id, f] as const));
  // I1: правый край листа — по самому правому блоку; внешние выходы доходят до него, а не обрываются в поле.
  // Запас справа — под самую длинную подпись выхода, чтобы она не вышла за лист.
  const outLabelW = Math.max(0, ...fnNodes.flatMap((n) => n.outputs.filter((id) => dataById.has(id)).map((id) => labelWidth(wrapLabel(dataById.get(id)!.name, "side")))));
  const frameRight = Math.max(640, Math.ceil((Math.max(...functions.map((f) => f.box.x + f.box.w), 0) + Math.max(170, outLabelW + 30)) / 20) * 20);

  // данные → функция, которая их выпускает (первая на этой диаграмме)
  const producedBy = new Map<string, string>();
  for (const n of fnNodes) for (const o of n.outputs) if (!producedBy.has(o)) producedBy.set(o, n.id);

  /** Слот выхода источника: y и номер (по номеру разносятся вертикали связей, чтобы они не сливались). */
  const outSlot = (pf: FunctionBlock<N>, did: string) => {
    const outs = pf.node.outputs.filter((o) => dataById.has(o));
    const k = Math.max(0, outs.indexOf(did));
    return { sy: pf.box.y + 14 + k * spread(pf.box.h, outs.length, 18, 14), k };
  };

  const routeOf = (n: N, kind: ArrowKind, id: string): ArrowRoute | undefined => n.arrow_routes?.[arrowRouteKey(kind, id)] ?? undefined;
  /** Ручной маршрут поверх автоматической ломаной: подпись сдвигается, а точки излома и свободный конец прокладываются заново (положения концов учтены при построении). */
  const finish = (a: Arrow, route: ArrowRoute | undefined): Arrow => {
    if (!route) return a;
    const out: Arrow = { ...a };
    if (route.label) out.labelOffset = [route.label[0], route.label[1]];
    if (route.pos !== undefined || route.from_pos !== undefined || route.label) out.manual = true;
    if (route.points || route.end) {
      const free = FREE_END[a.kind];
      const first = free === "start" && route.end ? route.end : a.points[0];
      const last = free === "end" && route.end ? route.end : a.points[a.points.length - 1];
      out.points = orthogonalPath(first, ARROW_DIRS[a.kind].from, route.points ?? [], last, ARROW_DIRS[a.kind].to);
      out.manual = true;
    }
    return out;
  };

  const arrows: Arrow[] = [];
  for (const { node: n, box: b } of functions) {
    // управление (сверху): регламенты — снаружи; данные-управление — от функции-источника, если она на диаграмме
    const ctrls = [
      ...n.controls.filter((id) => controlById.has(id)).map((id) => ({ id, name: controlById.get(id)!.name, data: false })),
      ...(n.control_data_ids ?? []).filter((id) => dataById.has(id)).map((id) => ({ id, name: dataById.get(id)!.name, data: true })),
    ];
    const cStep = spread(b.w, ctrls.length, 26, 20);
    ctrls.forEach((c, ci) => {
      const producer = c.data ? producedBy.get(c.id) : undefined;
      const linked = !!producer && producer !== n.id && blockOf.has(producer);
      const kind: ArrowKind = linked ? "controlLink" : c.data ? "controlData" : "control";
      const route = routeOf(n, kind, c.id);
      const cx = route?.pos !== undefined ? b.x + route.pos * b.w : b.x + 20 + ci * cStep;
      if (linked) {
        const pf = blockOf.get(producer!)!;
        const slot = outSlot(pf, c.id);
        const sy = route?.from_pos !== undefined ? pf.box.y + route.from_pos * pf.box.h : slot.sy;
        const sx = pf.box.x + pf.box.w;
        const trunk = sx + 16 + 8 * slot.k;
        const topY = b.y - 24;
        arrows.push(finish({ key: `controlLink:${n.id}:${c.id}`, kind, entityId: c.id, label: c.name, nodeId: n.id, fromId: producer, points: [[sx, sy], [trunk, sy], [trunk, topY], [cx, topY], [cx, b.y]], side: "mid" }, route));
      } else {
        arrows.push(finish({ key: `${kind}:${n.id}:${c.id}`, kind, entityId: c.id, label: c.name, nodeId: n.id, points: [[cx, b.y - STUB_CTRL], [cx, b.y]], side: "top", labelRow: rowOf(ci, ctrls.length) }, route));
      }
    });

    // входы (слева): от функции-источника или снаружи
    const ins = n.inputs.filter((id) => dataById.has(id));
    const iStep = spread(b.h, ins.length, 40, 14);
    ins.forEach((id, di) => {
      const label = dataById.get(id)!.name;
      const producer = producedBy.get(id);
      const linked = !!producer && producer !== n.id && blockOf.has(producer);
      const kind: ArrowKind = linked ? "link" : "input";
      const route = routeOf(n, kind, id);
      const y = route?.pos !== undefined ? b.y + route.pos * b.h : b.y + 14 + di * iStep;
      if (linked) {
        const pf = blockOf.get(producer!)!;
        const pb = pf.box;
        const slot = outSlot(pf, id);
        const sy = route?.from_pos !== undefined ? pb.y + route.from_pos * pb.h : slot.sy;
        const k = slot.k;
        const sx = pb.x + pb.w;
        const trunk = sx + 16 + 8 * k;
        let points: Pt[];
        if (b.x >= trunk + 32) {
          points = [[sx, sy], [trunk, sy], [trunk, y], [b.x, y]];
        } else {
          // потребитель не правее источника: обратная связь обходит оба блока сверху
          const top = Math.min(pb.y, b.y) - 30 - 8 * k;
          const entry = b.x - 16 - 6 * di;
          points = [[sx, sy], [trunk, sy], [trunk, top], [entry, top], [entry, y], [b.x, y]];
        }
        arrows.push(finish({ key: `link:${n.id}:${id}`, kind, entityId: id, label, nodeId: n.id, fromId: producer, points, side: "mid" }, route));
      } else {
        arrows.push(finish({ key: `input:${n.id}:${id}`, kind, entityId: id, label, nodeId: n.id, points: [[0, y], [b.x, y]], side: "left" }, route));
      }
    });

    // выходы (справа) — если не потреблены на этой диаграмме, уходят за границу
    const outs = n.outputs.filter((id) => dataById.has(id));
    const oStep = spread(b.h, outs.length, 40, 14);
    outs.forEach((id, i) => {
      const consumed = fnNodes.some((o) => o.id !== n.id && (o.inputs.includes(id) || (o.control_data_ids ?? []).includes(id)));
      if (consumed) return;
      const route = routeOf(n, "output", id);
      const y = route?.pos !== undefined ? b.y + route.pos * b.h : b.y + 14 + i * oStep;
      arrows.push(finish({ key: `output:${n.id}:${id}`, kind: "output", entityId: id, label: dataById.get(id)!.name, nodeId: n.id, points: [[b.x + b.w, y], [frameRight, y]], side: "right" }, route));
    });

    // механизмы (снизу): должности (исполнитель и назначенные роли) и системы
    const mech: { kind: "role" | "system"; id: string; name: string }[] = [];
    for (const rid of mechanismRoleIds(m, n)) if (roleById.has(rid)) mech.push({ kind: "role", id: rid, name: roleById.get(rid)!.name });
    for (const sid of n.system_ids) if (systemById.has(sid)) mech.push({ kind: "system", id: sid, name: systemById.get(sid)!.name });
    const mStep = spread(b.w, mech.length, 40, 20);
    mech.forEach((mm, i) => {
      const route = routeOf(n, mm.kind, mm.id);
      const x = route?.pos !== undefined ? b.x + route.pos * b.w : b.x + 20 + i * mStep;
      arrows.push(finish({ key: `${mm.kind}:${n.id}:${mm.id}`, kind: mm.kind, entityId: mm.id, label: mm.name, nodeId: n.id, points: [[x, b.y + b.h + STUB_MECH], [x, b.y + b.h]], side: "bottom", labelRow: rowOf(i, mech.length) }, route));
    });
  }
  // Общий механизм (одна должность или система у нескольких блоков), как в Business Studio: под блоками идёт горизонтальная «шина»
  // на своей глубине, от её начала стрелки поднимаются в каждый блок, подпись одна — над шиной. Чем левее вертикаль в первом
  // блоке, тем глубже шина, а в следующих блоках порядок обратный — так «лесенки» не пересекаются.
  {
    const entityKey = (a: Arrow) => `${a.kind}:${a.entityId}`;
    const bottoms = new Map<string, Arrow[]>();
    for (const a of arrows) if (a.side === "bottom") bottoms.set(a.nodeId, [...(bottoms.get(a.nodeId) ?? []), a]);
    const holders = new Map<string, Arrow[]>();
    for (const list of bottoms.values()) for (const a of list) holders.set(entityKey(a), [...(holders.get(entityKey(a)) ?? []), a]);
    const sharedKeys = [...holders].filter(([, list]) => list.length >= 2 && list.every((a) => !a.manual)).map(([k]) => k);
    if (sharedKeys.length > 0) {
      const boxOf = (a: Arrow) => blockOf.get(a.nodeId)!.box;
      const headOf = (key: string) => [...holders.get(key)!].sort((p, q) => boxOf(p).x - boxOf(q).x)[0].nodeId;
      // глубина шины: по возрасту — первый в списке блока самый глубокий
      const order = [...sharedKeys].sort((k1, k2) => {
        const [h1, h2] = [headOf(k1), headOf(k2)];
        if (h1 !== h2) return boxOf(holders.get(k1)!.find((a) => a.nodeId === h1)!).x - boxOf(holders.get(k2)!.find((a) => a.nodeId === h2)!).x;
        return (bottoms.get(h1)!.findIndex((a) => entityKey(a) === k1)) - (bottoms.get(h1)!.findIndex((a) => entityKey(a) === k2));
      });
      const depth = new Map(order.map((k, i) => [k, i] as const)); // 0 — самая глубокая
      const involved = new Set(order.flatMap((k) => holders.get(k)!.map((a) => a.nodeId)));
      const lowest = Math.max(...[...involved].map((id) => blockOf.get(id)!.box.y + blockOf.get(id)!.box.h));
      const busY = (k: string) => lowest + 24 + (order.length - 1 - depth.get(k)!) * 18;
      // порядок вертикалей по низу каждого блока: сначала общие, у которых блок не первый (по возрастанию глубины), потом свои,
      // потом общие, у которых блок первый (по убыванию глубины — самая глубокая шина слева)
      for (const [nodeId, list] of bottoms) {
        const b = blockOf.get(nodeId)!.box;
        const kindOf = (a: Arrow) => (sharedKeys.includes(entityKey(a)) ? (headOf(entityKey(a)) === nodeId ? 2 : 0) : 1);
        const sorted = [...list].sort((p, q) => kindOf(p) - kindOf(q) || (kindOf(p) === 2 ? depth.get(entityKey(p))! - depth.get(entityKey(q))! : kindOf(p) === 0 ? depth.get(entityKey(q))! - depth.get(entityKey(p))! : 0));
        const step = spread(b.w, sorted.length, 40, 20);
        sorted.forEach((a, i) => {
          if (a.manual) return;
          const x = b.x + 20 + i * step;
          a.points = [[x, b.y + b.h + STUB_MECH], [x, b.y + b.h]];
        });
      }
      for (const key of order) {
        const list = [...holders.get(key)!].sort((p, q) => boxOf(p).x - boxOf(q).x);
        const head = list[0];
        const tee: Pt = [head.points[0][0], busY(key)];
        head.points = [tee, head.points[1]];
        head.labelHidden = true;
        list.slice(1).forEach((a, i) => {
          const end = a.points[1];
          a.points = [tee, [end[0], tee[1]], end];
          a.side = "mid";
          if (i > 0) a.labelHidden = true;
        });
        // подпись — над шиной, у первой стрелки после головной
        if (list.length > 1) (list[1].labelHidden = false, (list[1].bus = true));
      }
    }
  }
  // «Разбитая стрелка» (как «Разбить стрелку» в Business Studio): одна сущность в одном виде уходит в несколько
  // блоков (или выходит из нескольких) — подпись ставится один раз, остальные копии её не повторяют. Должности и
  // системы не трогаем: у них своя шина (bus) выше.
  const branches = new Map<string, typeof arrows>();
  for (const a of arrows) {
    if (!TUNNEL_KINDS.has(a.kind) || !a.label) continue;
    const key = arrowRouteKey(a.kind, a.entityId);
    (branches.get(key) ?? branches.set(key, []).get(key)!).push(a);
  }
  for (const list of branches.values()) {
    if (list.length < 2) continue;
    for (const copy of list.slice(1)) copy.labelHidden = true;
  }
  // В8: ствол разветвления ICOM-стрелок («Разбить стрелку» в Business Studio) — стрелки одной сущности в одном виде
  // сходятся в общий ствол у свободных концов, от него в каждый блок идёт свой отрезок; подпись одна (проход выше).
  // Ствол рисуется самими стрелками: каждая начинается (входы, управления) или кончается (выходы) в общей точке ствола,
  // поэтому отдельной линии не нужно, а редактор, SVG и Visio остаются без правок (тот же приём, что у «Границы»).
  // Важно: ствол строится ДО расчёта строк подписей — иначе подписи управления на одном блоке налезают друг на друга.
  const BRANCH_GAP = 34; // на сколько ствол отстоит от свободных концов
  const BRANCH_STUB = 64; // вылет ствола наружу — место подписи и наконечника
  for (const list of branches.values()) {
    if (list.length < 2) continue;
    const side = PORT_SIDE[list[0].kind];
    const atStart = FREE_END[list[0].kind] === "start";
    if (!atStart && FREE_END[list[0].kind] !== "end") continue; // механизмы: у них шина ниже
    const freeOf = (a: (typeof list)[number]) => (atStart ? a.points[0] : a.points[a.points.length - 1]);
    const xs = list.map((a) => freeOf(a)[0]);
    const ys = list.map((a) => freeOf(a)[1]);
    const y0 = ys[0]; // ствол строится от стрелки с подписью
    if (side === "L") {
      const trunkX = Math.min(...xs) - BRANCH_GAP;
      list.forEach((a, i) => {
        const f = freeOf(a);
        a.points = [...(i === 0 ? ([[trunkX - BRANCH_STUB, y0]] as Pt[]) : []), [trunkX, y0], [trunkX, f[1]], ...a.points] as Pt[];
      });
    } else if (side === "R") {
      const trunkX = Math.max(...xs) + BRANCH_GAP;
      list.forEach((a, i) => {
        const f = freeOf(a);
        a.points = [...a.points, [trunkX, f[1]], [trunkX, y0], ...(i === 0 ? ([[trunkX + BRANCH_STUB, y0]] as Pt[]) : [])] as Pt[];
      });
    } else if (side === "T") {
      const trunkY = Math.min(...ys) - BRANCH_GAP;
      const stubX = Math.min(...xs) - BRANCH_STUB;
      list.forEach((a) => {
        const f = freeOf(a);
        // Ствол должен быть непрерывным: каждая копия идёт от вылета по общей горизонтали, иначе участок
        // между головной стрелкой и копией не нарисован и ствол выглядит разорванным.
        a.points = [[stubX, trunkY], [f[0], trunkY], ...a.points] as Pt[];
      });
    }
  }
  // строки подписей управления и механизмов — по ширине подписей, отдельно для каждого блока и стороны
  // чужие подписи, которые строка не должна задевать: связи между блоками, внешние входы и выходы (их места не зависят от строк)
  const obstacles: LabelRect[] = [];
  for (const a of arrows) {
    if (a.side === "top" || a.side === "bottom") continue;
    const sp = labelSpec(a);
    if (!sp) continue;
    const w = labelWidth(sp.text);
    const x0 = sp.anchor === "middle" ? sp.x - w / 2 : sp.anchor === "end" ? sp.x - w : sp.x;
    obstacles.push({ x0, x1: x0 + w, y0: sp.y - 10, y1: sp.y + 2 + (sp.text.split("\n").length - 1) * LABEL_ROW_H });
  }
  for (const side of ["top", "bottom"] as const) {
    const groups = new Map<string, typeof arrows>();
    for (const a of arrows) if (a.side === side && a.label && !a.labelHidden) (groups.get(a.nodeId) ?? groups.set(a.nodeId, []).get(a.nodeId)!).push(a);
    for (const list of groups.values()) {
      const rows = assignLabelRows(
        list.map((a) => ({ x: a.points[0][0], label: a.label })),
        { obstacles, y: (i, row, lines) => (side === "top" ? list[i].points[0][1] - 4 - (lines - 1) * LABEL_ROW_H - row * LABEL_ROW_H : list[i].points[0][1] + 14 + row * LABEL_ROW_H) }
      );
      list.forEach((a, i) => (a.labelRow = rows[i]));
    }
  }
  // I4: подпись не должна лежать на чужом блоке или на другой подписи. Сдвигаем её вдоль стрелки (по вертикали),
  // сохраняя ручной сдвиг пользователя; линия под текстом всё равно прерывается белой подложкой при отрисовке.
  const occupied: LabelRect[] = [];
  const rectOf = (sp: { x: number; y: number; anchor: "start" | "middle" | "end"; text: string }): LabelRect => {
    const w = labelWidth(sp.text);
    const x0 = sp.anchor === "middle" ? sp.x - w / 2 : sp.anchor === "end" ? sp.x - w : sp.x;
    return { x0, x1: x0 + w, y0: sp.y - 10, y1: sp.y + 2 + (sp.text.split("\n").length - 1) * LABEL_ROW_H };
  };
  const hits = (a: LabelRect, b: LabelRect) => a.x0 < b.x1 + 1 && b.x0 < a.x1 + 1 && a.y0 < b.y1 + 1 && b.y0 < a.y1 + 1;
  for (const a of arrows) {
    if (!a.label || a.labelHidden) continue;
    const base = a.labelOffset ?? [0, 0];
    let chosen: LabelRect | null = null;
    let chosenOffset = base;
    for (const dy of [0, -14, 14, -28, 28, -42, 42, -56, 56]) {
      a.labelOffset = [base[0], base[1] + dy];
      const sp = labelSpec(a);
      if (!sp) continue;
      const rect = rectOf(sp);
      const blocked = functions.some((f) => f.node.id !== a.nodeId && hits(rect, { x0: f.box.x - 2, x1: f.box.x + f.box.w + 2, y0: f.box.y - 2, y1: f.box.y + f.box.h + 2 })) || occupied.some((o) => hits(rect, o));
      if (!blocked) {
        chosen = rect;
        chosenOffset = [base[0], base[1] + dy];
        break;
      }
    }
    a.labelOffset = chosenOffset;
    if (chosen) occupied.push(chosen);
  }
  for (const a of arrows) {
    if (!TUNNEL_KINDS.has(a.kind)) continue;
    const t = fnNodes.find((n) => n.id === a.nodeId)?.tunnels?.[arrowRouteKey(a.kind, a.entityId)];
    if (t?.up) a.tunnelUp = true;
    if (t?.down) a.tunnelDown = true;
    // «Граница»: штрих на конце вместо скобок туннеля (вид помеченного конца из паспорта процесса)
    if (t?.upKind === "boundary") {
      a.boundaryUp = true;
      a.tunnelUp = false;
    }
    if (t?.downKind === "boundary") {
      a.boundaryDown = true;
      a.tunnelDown = false;
    }
    // В11: ссылка на диаграмму — значок страницы у конца вместо скобок туннеля
    if (t?.upKind === "offpage") {
      a.offpageUp = true;
      a.tunnelUp = false;
    }
    if (t?.downKind === "offpage") {
      a.offpageDown = true;
      a.tunnelDown = false;
    }
  }
  // В9: ICOM-коды на концах стрелок (I1/C1/O1/M1). Номер — на сущность в классе, в порядке блоков и положения
  // вдоль стороны блока (как в Business Studio); у «разбитой» стрелки код один на всех её отрезках.
  const ICOM: Record<ArrowKind, string> = { input: "I", link: "I", control: "C", controlData: "C", controlLink: "C", output: "O", role: "M", system: "M" };
  const blockIndex = new Map(functions.map((f, i) => [f.node.id, i] as const));
  const endAtBlock = (a: Arrow): Pt => {
    const b = blockOf.get(a.nodeId)!.box;
    const dist = (p: Pt) => Math.min(Math.abs(p[0] - b.x), Math.abs(p[0] - (b.x + b.w))) + Math.min(Math.abs(p[1] - b.y), Math.abs(p[1] - (b.y + b.h)));
    const p0 = a.points[0];
    const p1 = a.points[a.points.length - 1];
    return dist(p0) <= dist(p1) ? p0 : p1;
  };
  const numbered = new Map<string, number>();
  const ordered = [...arrows].sort((x, y) => {
    const ex = endAtBlock(x);
    const ey = endAtBlock(y);
    return (blockIndex.get(x.nodeId) ?? 0) - (blockIndex.get(y.nodeId) ?? 0) || ex[1] - ey[1] || ex[0] - ey[0];
  });
  for (const a of ordered) {
    const cls = ICOM[a.kind];
    const key = `${cls}:${a.entityId}`;
    let n = numbered.get(key);
    if (n === undefined) numbered.set(key, (n = [...numbered.keys()].filter((k) => k.startsWith(`${cls}:`)).length + 1));
    a.code = `${cls}${n}`;
    const b = blockOf.get(a.nodeId)!.box;
    const e = endAtBlock(a);
    if (Math.abs(e[0] - b.x) < 0.5) {
      a.codeAt = [e[0] - 4, e[1] - 36];
      a.codeAnchor = "end";
    } else if (Math.abs(e[0] - (b.x + b.w)) < 0.5) {
      a.codeAt = [e[0] + 4, e[1] - 36];
      a.codeAnchor = "start";
    } else if (Math.abs(e[1] - b.y) < 0.5) {
      a.codeAt = [e[0] - 4, e[1] - 32];
      a.codeAnchor = "end";
    } else {
      a.codeAt = [e[0] - 4, e[1] + 40];
      a.codeAnchor = "end";
    }
  }
  return { functions, arrows };
}

/** Размер «мира» диаграммы. */
export function idef0Extents(layout: Idef0Layout<NodeLike>): { w: number; h: number } {
  // стрелки, уведённые вручную за пределы блоков, тоже должны поместиться (справа от конца — место для подписи);
  // у автоматических внешних выходов конец уже стоит на правом краю листа, поэтому запас им не нужен
  const pts = layout.arrows.flatMap((a) => a.points);
  const manualPts = layout.arrows.filter((a) => a.manual).flatMap((a) => a.points);
  return {
    w: Math.max(640, ...layout.functions.map((f) => f.box.x + f.box.w + 20), ...pts.map((p) => p[0]), ...manualPts.map((p) => p[0] + 200)),
    h: Math.max(420, ...layout.functions.map((f) => f.box.y + f.box.h + 20), ...pts.map((p) => p[1] + 40)),
  };
}

/** Положение подписи стрелки: у начала слева/сверху/снизу, у конца справа или над самым длинным горизонтальным отрезком; плюс ручной сдвиг. */
export function labelSpec(a: { points: Pt[]; side: LabelSide; label?: string; labelRow?: number; labelOffset?: Pt; labelHidden?: boolean; bus?: boolean }): { x: number; y: number; anchor: "start" | "middle" | "end"; text: string } | null {
  if (a.labelHidden) return null;
  const spec = baseLabelSpec(a);
  if (!spec || !a.labelOffset) return spec;
  return { ...spec, x: spec.x + a.labelOffset[0], y: spec.y + a.labelOffset[1] };
}

function baseLabelSpec(a: { points: Pt[]; side: LabelSide; label?: string; labelRow?: number; bus?: boolean }): { x: number; y: number; anchor: "start" | "middle" | "end"; text: string } | null {
  if (!a.label) return null;
  const text = a.bus ? wrapText(a.label, 60, 1).join("") : wrapLabel(a.label, a.side === "left" || a.side === "right" ? "side" : a.side === "top" || a.side === "bottom");
  const extra = (text.split("\n").length - 1) * LABEL_ROW_H; // подпись над линией растёт вверх: первая строка поднимается
  const first = a.points[0];
  const last = a.points[a.points.length - 1];
  if (a.bus) return { x: first[0] + 8, y: first[1] - 4, anchor: "start", text };
  switch (a.side) {
    // как в Business Studio, подпись внешней стрелки лежит на самой линии, по центру её отрезка (линия под текстом прерывается белой подложкой)
    case "left":
      return { x: (first[0] + last[0]) / 2, y: first[1] + 4 - extra / 2, anchor: "middle", text };
    case "right":
      return { x: (first[0] + last[0]) / 2, y: first[1] + 4 - extra / 2, anchor: "middle", text };
    case "top":
      return { x: first[0] + LABEL_START_DX, y: first[1] - 4 - extra - (a.labelRow ?? 0) * LABEL_ROW_H, anchor: "start", text }; // подпись правее вертикали, чтобы линия не шла через текст
    case "bottom":
      return { x: first[0] + LABEL_START_DX, y: first[1] + 14 + (a.labelRow ?? 0) * LABEL_ROW_H, anchor: "start", text };
    default: {
      let idx = -1;
      let best = -1;
      for (let i = 0; i < a.points.length - 1; i++) {
        const [p, q] = [a.points[i], a.points[i + 1]];
        if (p[1] === q[1] && Math.abs(q[0] - p[0]) > best) {
          best = Math.abs(q[0] - p[0]);
          idx = i;
        }
      }
      if (idx >= 0) return { x: (a.points[idx][0] + a.points[idx + 1][0]) / 2, y: a.points[idx][1] - 5 - extra, anchor: "middle", text };
      return { x: (first[0] + last[0]) / 2 + 4, y: (first[1] + last[1]) / 2, anchor: "start", text };
    }
  }
}
