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
export function tunnelArcs(a: { kind: ArrowKind; points: Pt[]; tunnelUp?: boolean; tunnelDown?: boolean }): TunnelArc[] {
  const pts = a.points;
  if (pts.length < 2 || !TUNNEL_KINDS.has(a.kind) || (!a.tunnelUp && !a.tunnelDown)) return [];
  const last = pts.length - 1;
  const freeAtEnd = FREE_END[a.kind] === "end";
  const free = freeAtEnd ? { at: pts[last], from: pts[last - 1] } : { at: pts[0], from: pts[1] };
  const block = freeAtEnd ? { at: pts[0], from: pts[1] } : { at: pts[last], from: pts[last - 1] };
  const out: TunnelArc[] = [];
  for (const [on, end] of [[a.tunnelUp, free], [a.tunnelDown, block]] as const) {
    if (!on) continue;
    const len = Math.hypot(end.at[0] - end.from[0], end.at[1] - end.from[1]) || 1;
    const t = [(end.at[0] - end.from[0]) / len, (end.at[1] - end.from[1]) / len];
    const n = [-t[1], t[0]];
    const c = [end.at[0] - t[0] * 7, end.at[1] - t[1] * 7];
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
export const STEP_X = 230;
export const STEP_Y = 150;
export const MARGIN = 170;
const STUB_SIDE = 60; // внешние входы/выходы
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
  /** Маршрут правился вручную: положение конца, точки излома, свободный конец или подпись заданы пользователем. */
  manual?: boolean;
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

/** Подпись стрелки переносится по словам: до 34 знаков в строке и до 3 строк (как у Business Studio), строки разделены «\n». */
export const wrapLabel = (text: string, wide = false): string => (wide ? wrapText(text, 60, 2) : wrapText(text, 40, 2)).join("\n");
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
  const order = items.map((_, i) => i).sort((i, j) => items[i].x - items[j].x);
  const rows: { x: number; w: number }[][] = [];
  const out: number[] = new Array(items.length).fill(0);
  for (const i of order) {
    const wrapped = wrapLabel(items[i].label, true); // в рядах — подписи над блоком и под ним: длинная строка
    const w = labelWidth(wrapped);
    // многострочная подпись занимает столько рядов, сколько в ней строк
    const h = wrapped.split("\n").length;
    let r = 0;
    const blocked = (row: number) => {
      for (let k = row; k < row + h; k++) if ((rows[k] ?? []).some((q) => Math.abs(items[i].x - q.x) < (w + q.w) / 2 + LABEL_GAP)) return true;
      if (!opts.y || !opts.obstacles) return false;
      const y = opts.y(i, row, h);
      const mine = { x0: items[i].x - w / 2, x1: items[i].x + w / 2, y0: y - 10, y1: y + 2 + (h - 1) * LABEL_ROW_H };
      return opts.obstacles.some((o) => rectsHit(mine, o));
    };
    while (r < MAX_LABEL_ROWS - h && blocked(r)) r++;
    for (let k = r; k < r + h; k++) (rows[k] ??= []).push({ x: items[i].x, w });
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
    const iStep = spread(b.h, ins.length, 18, 14);
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
        arrows.push(finish({ key: `input:${n.id}:${id}`, kind, entityId: id, label, nodeId: n.id, points: [[b.x - STUB_SIDE, y], [b.x, y]], side: "left" }, route));
      }
    });

    // выходы (справа) — если не потреблены на этой диаграмме, уходят за границу
    const outs = n.outputs.filter((id) => dataById.has(id));
    const oStep = spread(b.h, outs.length, 18, 14);
    outs.forEach((id, i) => {
      const consumed = fnNodes.some((o) => o.id !== n.id && (o.inputs.includes(id) || (o.control_data_ids ?? []).includes(id)));
      if (consumed) return;
      const route = routeOf(n, "output", id);
      const y = route?.pos !== undefined ? b.y + route.pos * b.h : b.y + 14 + i * oStep;
      arrows.push(finish({ key: `output:${n.id}:${id}`, kind: "output", entityId: id, label: dataById.get(id)!.name, nodeId: n.id, points: [[b.x + b.w, y], [b.x + b.w + STUB_SIDE, y]], side: "right" }, route));
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
    for (const a of arrows) if (a.side === side && a.label) (groups.get(a.nodeId) ?? groups.set(a.nodeId, []).get(a.nodeId)!).push(a);
    for (const list of groups.values()) {
      const rows = assignLabelRows(
        list.map((a) => ({ x: a.points[0][0], label: a.label })),
        { obstacles, y: (i, row, lines) => (side === "top" ? list[i].points[0][1] - 4 - (lines - 1) * LABEL_ROW_H - row * LABEL_ROW_H : list[i].points[0][1] + 14 + row * LABEL_ROW_H) }
      );
      list.forEach((a, i) => (a.labelRow = rows[i]));
    }
  }
  for (const a of arrows) {
    if (!TUNNEL_KINDS.has(a.kind)) continue;
    const t = fnNodes.find((n) => n.id === a.nodeId)?.tunnels?.[arrowRouteKey(a.kind, a.entityId)];
    if (t?.up) a.tunnelUp = true;
    if (t?.down) a.tunnelDown = true;
  }
  return { functions, arrows };
}

/** Размер «мира» диаграммы. */
export function idef0Extents(layout: Idef0Layout<NodeLike>): { w: number; h: number } {
  // стрелки, уведённые вручную за пределы блоков, тоже должны поместиться (справа от конца — место для подписи)
  const pts = layout.arrows.flatMap((a) => a.points);
  return {
    w: Math.max(640, ...layout.functions.map((f) => f.box.x + f.box.w + 260), ...pts.map((p) => p[0] + 200)),
    h: Math.max(420, ...layout.functions.map((f) => f.box.y + f.box.h + 220), ...pts.map((p) => p[1] + 60)),
  };
}

/** Положение подписи стрелки: у начала слева/сверху/снизу, у конца справа или над самым длинным горизонтальным отрезком; плюс ручной сдвиг. */
export function labelSpec(a: { points: Pt[]; side: LabelSide; label?: string; labelRow?: number; labelOffset?: Pt }): { x: number; y: number; anchor: "start" | "middle" | "end"; text: string } | null {
  const spec = baseLabelSpec(a);
  if (!spec || !a.labelOffset) return spec;
  return { ...spec, x: spec.x + a.labelOffset[0], y: spec.y + a.labelOffset[1] };
}

function baseLabelSpec(a: { points: Pt[]; side: LabelSide; label?: string; labelRow?: number }): { x: number; y: number; anchor: "start" | "middle" | "end"; text: string } | null {
  if (!a.label) return null;
  const text = wrapLabel(a.label, a.side === "top" || a.side === "bottom");
  const extra = (text.split("\n").length - 1) * LABEL_ROW_H; // подпись над линией растёт вверх: первая строка поднимается
  const first = a.points[0];
  const last = a.points[a.points.length - 1];
  switch (a.side) {
    // как в Business Studio, подпись внешней стрелки лежит над самой линией, у блока: вход слева прижат к блоку справа, выход
    // (выходы стоят вплотную друг к другу, их подписи — за концом стрелки); длинная подпись входа выходит за свободный конец, но не в блок
    case "left":
      return { x: last[0] - 6, y: last[1] - 4 - extra, anchor: "end", text };
    case "right":
      return { x: last[0] + 4, y: last[1] + 4 - extra / 2, anchor: "start", text }; // у выходов стрелки идут вплотную: подпись за концом, по центру строк
    case "top":
      return { x: first[0], y: first[1] - 4 - extra - (a.labelRow ?? 0) * LABEL_ROW_H, anchor: "middle", text };
    case "bottom":
      return { x: first[0], y: first[1] + 14 + (a.labelRow ?? 0) * LABEL_ROW_H, anchor: "middle", text };
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
