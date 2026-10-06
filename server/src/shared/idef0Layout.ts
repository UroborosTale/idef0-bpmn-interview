/**
 * Раскладка диаграмм IDEF0 — общая для сервера (SVG, VSDX, draw.io) и редактора в браузере
 * (web подключает этот файл через псевдоним @shared). Только чистые функции без зависимостей:
 * модель описана структурно, чтобы подходили и серверные, и клиентские типы.
 */

export type Pt = [number, number];
export type LabelSide = "left" | "right" | "top" | "bottom" | "mid";
export type ArrowKind = "input" | "link" | "output" | "control" | "controlData" | "controlLink" | "role" | "system";

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
  idef0_layout?: { x: number; y: number } | null;
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

const isFn = (n: NodeLike) => n.type === "task" || n.type === "subprocess";

/**
 * Функции одной диаграммы: parentId = null — уровень A0 (верхний; если верхних нет — все задачи),
 * иначе — вложенные функции указанного узла (декомпозиция вглубь через idef0_parent).
 */
export function functionsOf<N extends NodeLike>(m: { nodes: N[] }, parentId: string | null = null): N[] {
  if (parentId) return m.nodes.filter((n) => isFn(n) && n.idef0_parent === parentId);
  const top = m.nodes.filter((n) => isFn(n) && !n.idef0_parent);
  return top.length > 0 ? top : m.nodes.filter((n) => n.type === "task");
}

export const hasChildren = (m: { nodes: NodeLike[] }, id: string) => m.nodes.some((c) => isFn(c) && c.idef0_parent === id);

/** Иерархические коды: A1, A2 на верхнем уровне, A31, A32 — вложенные в A3. */
export function idef0Codes(m: { nodes: NodeLike[] }): Map<string, string> {
  const codes = new Map<string, string>();
  const walk = (parentId: string | null, prefix: string) => {
    functionsOf(m, parentId).forEach((n, i) => {
      if (codes.has(n.id)) return; // защита от циклов в idef0_parent
      const code = `${prefix}${i + 1}`;
      codes.set(n.id, code);
      walk(n.id, code);
    });
  };
  walk(null, "A");
  return codes;
}

export const defaultPos = (i: number) => ({ x: MARGIN + i * STEP_X, y: MARGIN + i * STEP_Y });

/** Равномерно раскладывает n стрелок вдоль стороны длиной len, не плотнее max. */
const spread = (len: number, n: number, max: number, pad: number) => (n > 1 ? Math.min(max, (len - 2 * pad) / (n - 1)) : 0);

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

  const arrows: Arrow[] = [];
  for (const { node: n, box: b } of functions) {
    // управление (сверху): регламенты — снаружи; данные-управление — от функции-источника, если она на диаграмме
    const ctrls = [
      ...n.controls.filter((id) => controlById.has(id)).map((id) => ({ id, name: controlById.get(id)!.name, data: false })),
      ...(n.control_data_ids ?? []).filter((id) => dataById.has(id)).map((id) => ({ id, name: dataById.get(id)!.name, data: true })),
    ];
    const cStep = spread(b.w, ctrls.length, 26, 20);
    ctrls.forEach((c, ci) => {
      const cx = b.x + 20 + ci * cStep;
      const producer = c.data ? producedBy.get(c.id) : undefined;
      if (producer && producer !== n.id && blockOf.has(producer)) {
        const pf = blockOf.get(producer)!;
        const { sy, k } = outSlot(pf, c.id);
        const sx = pf.box.x + pf.box.w;
        const trunk = sx + 16 + 8 * k;
        const topY = b.y - 24;
        arrows.push({ key: `controlLink:${n.id}:${c.id}`, kind: "controlLink", entityId: c.id, label: c.name, nodeId: n.id, fromId: producer, points: [[sx, sy], [trunk, sy], [trunk, topY], [cx, topY], [cx, b.y]], side: "mid" });
      } else {
        const kind = c.data ? "controlData" : "control";
        arrows.push({ key: `${kind}:${n.id}:${c.id}`, kind, entityId: c.id, label: c.name, nodeId: n.id, points: [[cx, b.y - STUB_CTRL], [cx, b.y]], side: "top" });
      }
    });

    // входы (слева): от функции-источника или снаружи
    const ins = n.inputs.filter((id) => dataById.has(id));
    const iStep = spread(b.h, ins.length, 18, 14);
    ins.forEach((id, di) => {
      const y = b.y + 14 + di * iStep;
      const label = dataById.get(id)!.name;
      const producer = producedBy.get(id);
      if (producer && producer !== n.id && blockOf.has(producer)) {
        const pf = blockOf.get(producer)!;
        const pb = pf.box;
        const { sy, k } = outSlot(pf, id);
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
        arrows.push({ key: `link:${n.id}:${id}`, kind: "link", entityId: id, label, nodeId: n.id, fromId: producer, points, side: "mid" });
      } else {
        arrows.push({ key: `input:${n.id}:${id}`, kind: "input", entityId: id, label, nodeId: n.id, points: [[b.x - STUB_SIDE, y], [b.x, y]], side: "left" });
      }
    });

    // выходы (справа) — если не потреблены на этой диаграмме, уходят за границу
    const outs = n.outputs.filter((id) => dataById.has(id));
    const oStep = spread(b.h, outs.length, 18, 14);
    outs.forEach((id, i) => {
      const consumed = fnNodes.some((o) => o.id !== n.id && (o.inputs.includes(id) || (o.control_data_ids ?? []).includes(id)));
      if (consumed) return;
      const y = b.y + 14 + i * oStep;
      arrows.push({ key: `output:${n.id}:${id}`, kind: "output", entityId: id, label: dataById.get(id)!.name, nodeId: n.id, points: [[b.x + b.w, y], [b.x + b.w + STUB_SIDE, y]], side: "right" });
    });

    // механизмы (снизу): исполнитель и системы
    const mech: { kind: "role" | "system"; id: string; name: string }[] = [];
    if (n.role_id && roleById.has(n.role_id)) mech.push({ kind: "role", id: n.role_id, name: roleById.get(n.role_id)!.name });
    for (const sid of n.system_ids) if (systemById.has(sid)) mech.push({ kind: "system", id: sid, name: systemById.get(sid)!.name });
    const mStep = spread(b.w, mech.length, 40, 20);
    mech.forEach((mm, i) => {
      const x = b.x + 20 + i * mStep;
      arrows.push({ key: `${mm.kind}:${n.id}:${mm.id}`, kind: mm.kind, entityId: mm.id, label: mm.name, nodeId: n.id, points: [[x, b.y + b.h + STUB_MECH], [x, b.y + b.h]], side: "bottom" });
    });
  }
  return { functions, arrows };
}

/** Размер «мира» диаграммы. */
export function idef0Extents(layout: Idef0Layout<NodeLike>): { w: number; h: number } {
  return {
    w: Math.max(640, ...layout.functions.map((f) => f.box.x + f.box.w + 260)),
    h: Math.max(420, ...layout.functions.map((f) => f.box.y + f.box.h + 220)),
  };
}

/** Положение подписи стрелки: у начала слева/сверху/снизу, у конца справа или над самым длинным горизонтальным отрезком. */
export function labelSpec(a: { points: Pt[]; side: LabelSide; label?: string }): { x: number; y: number; anchor: "start" | "middle" | "end"; text: string } | null {
  if (!a.label) return null;
  const text = a.label.length > 26 ? a.label.slice(0, 25) + "…" : a.label;
  const first = a.points[0];
  const last = a.points[a.points.length - 1];
  switch (a.side) {
    case "left":
      return { x: first[0] - 4, y: first[1] + 4, anchor: "end", text };
    case "right":
      return { x: last[0] + 4, y: last[1] + 4, anchor: "start", text };
    case "top":
      return { x: first[0], y: first[1] - 4, anchor: "middle", text };
    case "bottom":
      return { x: first[0], y: first[1] + 14, anchor: "middle", text };
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
      if (idx >= 0) return { x: (a.points[idx][0] + a.points[idx + 1][0]) / 2, y: a.points[idx][1] - 5, anchor: "middle", text };
      return { x: (first[0] + last[0]) / 2 + 4, y: (first[1] + last[1]) / 2, anchor: "start", text };
    }
  }
}
