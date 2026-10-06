import type { ProcessLogicModel, ProcessNode } from "../types/model.js";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function wrapLines(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > maxChars && cur) {
      lines.push(cur.trim());
      cur = w;
    } else {
      cur = (cur + " " + w).trim();
    }
  }
  if (cur) lines.push(cur);
  return lines.slice(0, 3);
}

export type Pt = [number, number];
/** Где подписывать стрелку: у начала слева/сверху/снизу, у конца справа или по самому длинному горизонтальному отрезку. */
export type LabelSide = "left" | "right" | "top" | "bottom" | "mid";

/** Вид стрелки — совпадает с видами в редакторе IDEF0 (web/src/components/idef0-editor/geometry.ts). */
export type ArrowKind = "input" | "link" | "output" | "control" | "controlData" | "controlLink" | "role" | "system";

export interface Idef0Arrow {
  points: Pt[];
  label?: string;
  side: LabelSide;
  /** Какая связь модели нарисована: функция, сущность и вид (для обратного чтения правок из Visio). */
  ref?: { kind: ArrowKind; nodeId: string; entityId: string };
  /** Блоки, к которым приклеены начало и конец стрелки (в Visio — концы соединителя). */
  startNode?: string;
  endNode?: string;
}

export interface Idef0Block {
  nodeId: string;
  code: string; // A1, A2, A31, ...
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  hasChildren?: boolean;
}

/** Диаграмма в структурированном виде: из неё строятся и SVG, и VSDX. */
export interface Idef0DiagramData {
  code: string; // "A-0", "A0", "A3", "A31"…
  title: string;
  width: number;
  height: number;
  blocks: Idef0Block[];
  arrows: Idef0Arrow[];
  footer: string[];
}

export interface Idef0ChildDiagram {
  parentNodeId: string;
  code: string;
  name: string;
  svg: string;
  blocks: Idef0Block[];
  width: number;
  height: number;
}

export interface Idef0Result {
  contextSvg: string; // A-0
  decompositionSvg: string; // A0
  nodeTreeSvg: string;
  blocks: Idef0Block[]; // блоки A0
  width: number;
  height: number;
  children: Idef0ChildDiagram[]; // диаграммы декомпозиции A1, A2, A31… (только у функций с вложенными)
}

// Геометрия и маршрутизация стрелок продублированы в web/src/components/idef0-editor/geometry.ts —
// редактор рисует диаграмму на клиенте. Менять нужно в обоих местах.
const BLOCK_W = 170;
const BLOCK_H = 90;
const STEP_X = 230;
const STEP_Y = 150;
const MARGIN = 170;
const STUB_SIDE = 60; // внешние входы/выходы
const STUB_CTRL = 46; // управление сверху
const STUB_MECH = 40; // механизмы снизу

/** Равномерно раскладывает n стрелок вдоль стороны блока длиной len, не плотнее max. */
const spread = (len: number, n: number, max: number, pad: number) => (n > 1 ? Math.min(max, (len - 2 * pad) / (n - 1)) : 0);

const isFn = (n: ProcessNode) => n.type === "task" || n.type === "subprocess";

/**
 * Функции одной диаграммы: parentId = null — уровень A0 (верхний; если верхних нет — все задачи),
 * иначе — вложенные функции указанного узла (decomposition вглубь через idef0_parent).
 */
export function idef0Functions(model: ProcessLogicModel, parentId: string | null): ProcessNode[] {
  if (parentId) return model.nodes.filter((n) => isFn(n) && n.idef0_parent === parentId);
  const top = model.nodes.filter((n) => isFn(n) && !n.idef0_parent);
  return top.length > 0 ? top : model.nodes.filter((n) => n.type === "task");
}

/** Иерархические коды функций: A1, A2 на верхнем уровне, A31, A32 — вложенные в A3. */
export function idef0Codes(model: ProcessLogicModel): Map<string, string> {
  const codes = new Map<string, string>();
  const walk = (parentId: string | null, prefix: string) => {
    idef0Functions(model, parentId).forEach((n, i) => {
      if (codes.has(n.id)) return; // защита от циклов в idef0_parent
      const code = `${prefix}${i + 1}`;
      codes.set(n.id, code);
      walk(n.id, code);
    });
  };
  walk(null, "A");
  return codes;
}

interface External {
  inputs: string[];
  controls: string[];
  outputs: string[];
  mechanisms: string[];
}

/** Блоки и ICOM-стрелки диаграммы декомпозиции (parentId = null — A0). */
function buildFunctionDiagram(model: ProcessLogicModel, parentId: string | null, codes: Map<string, string>): { data: Idef0DiagramData; ext: External } {
  const dataById = new Map(model.data.map((d) => [d.id, d] as const));
  const controlById = new Map(model.controls.map((c) => [c.id, c] as const));
  const roleById = new Map(model.roles.map((r) => [r.id, r] as const));
  const systemById = new Map(model.systems.map((s) => [s.id, s] as const));

  const fnNodes = idef0Functions(model, parentId);
  const parent = parentId ? model.nodes.find((n) => n.id === parentId) : undefined;
  const code = parentId ? codes.get(parentId) ?? "A?" : "A0";

  const producedBy = new Map<string, string>(); // dataId -> nodeId (первый производитель на этой диаграмме)
  for (const n of fnNodes) for (const o of n.outputs) if (!producedBy.has(o)) producedBy.set(o, n.id);

  const blocks: Idef0Block[] = fnNodes.map((n, i) => ({
    nodeId: n.id,
    code: codes.get(n.id) ?? `A${i + 1}`,
    name: n.name,
    x: n.idef0_layout?.x ?? MARGIN + i * STEP_X,
    y: n.idef0_layout?.y ?? MARGIN + i * STEP_Y,
    w: BLOCK_W,
    h: BLOCK_H,
    hasChildren: model.nodes.some((c) => isFn(c) && c.idef0_parent === n.id),
  }));
  const blockOf = new Map(blocks.map((b) => [b.nodeId, b] as const));
  const nodeOf = new Map(fnNodes.map((n) => [n.id, n] as const));

  const arrows: Idef0Arrow[] = [];
  const ext: External = { inputs: [], controls: [], outputs: [], mechanisms: [] };

  /** Слот выхода функции-источника: y выхода и номер (для разнесения вертикалей связей). */
  const outSlot = (pb: Idef0Block, pn: ProcessNode, did: string) => {
    const outs = pn.outputs.filter((o) => dataById.has(o));
    const k = Math.max(0, outs.indexOf(did));
    return { sy: pb.y + 14 + k * spread(pb.h, outs.length, 18, 14), k };
  };

  for (const n of fnNodes) {
    const b = blockOf.get(n.id)!;

    // controls (top): регламенты — внешние; данные-управление — от функции-источника, если она есть на диаграмме
    const ctrls = [
      ...n.controls.filter((id) => controlById.has(id)).map((id) => ({ id, name: controlById.get(id)!.name, data: false })),
      ...(n.control_data_ids ?? []).filter((id) => dataById.has(id)).map((id) => ({ id, name: dataById.get(id)!.name, data: true })),
    ];
    const cStep = spread(b.w, ctrls.length, 26, 20);
    ctrls.forEach((c, ci) => {
      const cx = b.x + 20 + ci * cStep;
      const producer = c.data ? producedBy.get(c.id) : undefined;
      if (producer && producer !== n.id && blockOf.has(producer)) {
        const pb = blockOf.get(producer)!;
        const { sy, k } = outSlot(pb, nodeOf.get(producer)!, c.id);
        const sx = pb.x + pb.w;
        const trunk = sx + 16 + 8 * k;
        const topY = b.y - 24;
        arrows.push({ points: [[sx, sy], [trunk, sy], [trunk, topY], [cx, topY], [cx, b.y]], label: c.name, side: "mid", ref: { kind: "controlLink", nodeId: n.id, entityId: c.id }, startNode: producer, endNode: n.id });
      } else {
        arrows.push({ points: [[cx, b.y - STUB_CTRL], [cx, b.y]], label: c.name, side: "top", ref: { kind: c.data ? "controlData" : "control", nodeId: n.id, entityId: c.id }, endNode: n.id });
        ext.controls.push(c.name);
      }
    });

    // inputs (left)
    const ins = n.inputs.filter((id) => dataById.has(id));
    const iStep = spread(b.h, ins.length, 18, 14);
    ins.forEach((did, di) => {
      const d = dataById.get(did)!;
      const y = b.y + 14 + di * iStep;
      const producer = producedBy.get(did);
      if (producer && producer !== n.id && blockOf.has(producer)) {
        const pb = blockOf.get(producer)!;
        const { sy, k } = outSlot(pb, nodeOf.get(producer)!, did);
        const sx = pb.x + pb.w;
        const trunk = sx + 16 + 8 * k;
        const ref = { kind: "link" as const, nodeId: n.id, entityId: did };
        if (b.x >= trunk + 32) {
          arrows.push({ points: [[sx, sy], [trunk, sy], [trunk, y], [b.x, y]], label: d.name, side: "mid", ref, startNode: producer, endNode: n.id });
        } else {
          // потребитель не правее источника: обратная связь обходит оба блока сверху
          const top = Math.min(pb.y, b.y) - 30 - 8 * k;
          const entry = b.x - 16 - 6 * di;
          arrows.push({ points: [[sx, sy], [trunk, sy], [trunk, top], [entry, top], [entry, y], [b.x, y]], label: d.name, side: "mid", ref, startNode: producer, endNode: n.id });
        }
      } else {
        arrows.push({ points: [[b.x - STUB_SIDE, y], [b.x, y]], label: d.name, side: "left", ref: { kind: "input", nodeId: n.id, entityId: did }, endNode: n.id });
        ext.inputs.push(d.name);
      }
    });

    // outputs (right) — если не потреблены внутри диаграммы, уходят за границу
    const outs = n.outputs.filter((id) => dataById.has(id));
    const oStep = spread(b.h, outs.length, 18, 14);
    outs.forEach((did, oi) => {
      const consumed = fnNodes.some((o) => o.id !== n.id && (o.inputs.includes(did) || (o.control_data_ids ?? []).includes(did)));
      if (consumed) return;
      const y = b.y + 14 + oi * oStep;
      arrows.push({ points: [[b.x + b.w, y], [b.x + b.w + STUB_SIDE, y]], label: dataById.get(did)!.name, side: "right", ref: { kind: "output", nodeId: n.id, entityId: did }, startNode: n.id });
      ext.outputs.push(dataById.get(did)!.name);
    });

    // mechanisms (bottom): исполнитель + системы
    const mech: { name: string; kind: "role" | "system"; id: string }[] = [];
    if (n.role_id && roleById.has(n.role_id)) mech.push({ name: roleById.get(n.role_id)!.name, kind: "role", id: n.role_id });
    for (const sid of n.system_ids) if (systemById.has(sid)) mech.push({ name: systemById.get(sid)!.name, kind: "system", id: sid });
    const mStep = spread(b.w, mech.length, 40, 20);
    mech.forEach((m, mi) => {
      const x = b.x + 20 + mi * mStep;
      arrows.push({ points: [[x, b.y + b.h + STUB_MECH], [x, b.y + b.h]], label: m.name, side: "bottom", ref: { kind: m.kind, nodeId: n.id, entityId: m.id }, endNode: n.id });
      ext.mechanisms.push(m.name);
    });
  }

  return {
    data: {
      code,
      title: `${code} — ${parent ? parent.name : model.process.name}`,
      width: Math.max(640, ...blocks.map((b) => b.x + b.w + 260)),
      height: Math.max(420, ...blocks.map((b) => b.y + b.h + 220)),
      blocks,
      arrows,
      footer: [],
    },
    ext,
  };
}

/** Контекстная диаграмма A-0. */
function buildContextDiagram(model: ProcessLogicModel, ext: External): Idef0DiagramData {
  const W = 640;
  const H = 420;
  const cb = { x: W / 2 - 110, y: H / 2 - 55, w: 220, h: 110 };
  const uniq = (arr: string[]) => [...new Set(arr)];
  const inputs = uniq(ext.inputs);
  const controls = uniq([...ext.controls, ...model.controls.map((c) => c.name)]);
  const outputs = uniq(ext.outputs.length ? ext.outputs : model.process.result ? [model.process.result] : []);
  const mechs = uniq([...ext.mechanisms, ...model.roles.map((r) => r.name)]);

  const arrows: Idef0Arrow[] = [];
  inputs.slice(0, 5).forEach((name, i) => {
    const y = cb.y + 20 + i * 18;
    arrows.push({ points: [[cb.x - 90, y], [cb.x, y]], label: name, side: "left" });
  });
  controls.slice(0, 5).forEach((name, i) => {
    const x = cb.x + 24 + i * 34;
    arrows.push({ points: [[x, cb.y - 60], [x, cb.y]], label: name, side: "top" });
  });
  outputs.slice(0, 5).forEach((name, i) => {
    const y = cb.y + 20 + i * 18;
    arrows.push({ points: [[cb.x + cb.w, y], [cb.x + cb.w + 90, y]], label: name, side: "right" });
  });
  mechs.slice(0, 5).forEach((name, i) => {
    const x = cb.x + 24 + i * 34;
    arrows.push({ points: [[x, cb.y + cb.h + 60], [x, cb.y + cb.h]], label: name, side: "bottom" });
  });

  return {
    code: "A-0",
    title: "A-0 — контекстная диаграмма",
    width: W,
    height: H + 50,
    blocks: [{ nodeId: "__context__", code: "A-0", name: model.process.name, ...cb }],
    arrows,
    footer: [
      model.process.goal ? `Цель: ${model.process.goal}` : "",
      `Точка зрения: ${model.process.owner ?? model.process.department ?? "владелец процесса"}`,
    ],
  };
}

/**
 * Все диаграммы IDEF0 в структурированном виде: A-0, A0 и диаграммы декомпозиции
 * вложенных функций (в порядке обхода в глубину).
 */
export function buildIdef0Diagrams(model: ProcessLogicModel): { context: Idef0DiagramData; root: Idef0DiagramData; children: (Idef0DiagramData & { parentNodeId: string; name: string })[] } {
  const codes = idef0Codes(model);
  const rootBuilt = buildFunctionDiagram(model, null, codes);
  const children: (Idef0DiagramData & { parentNodeId: string; name: string })[] = [];
  const seen = new Set<string>();
  const walk = (data: Idef0DiagramData) => {
    for (const b of data.blocks) {
      if (!b.hasChildren || seen.has(b.nodeId)) continue;
      seen.add(b.nodeId);
      const child = buildFunctionDiagram(model, b.nodeId, codes).data;
      children.push({ ...child, parentNodeId: b.nodeId, name: b.name });
      walk(child);
    }
  };
  walk(rootBuilt.data);
  return { context: buildContextDiagram(model, rootBuilt.ext), root: rootBuilt.data, children };
}

// --- SVG ---

const DEFS = `<defs>
  <marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
    <path d="M0,0 L0,6 L9,3 z" fill="#1f2937" />
  </marker>
</defs>`;

function textBlock(x: number, y: number, text: string, maxChars: number, fontSize = 12): string {
  const lines = wrapLines(text, maxChars);
  const startY = y - ((lines.length - 1) * (fontSize + 2)) / 2;
  return lines
    .map((l, i) => `<text x="${x}" y="${startY + i * (fontSize + 2)}" font-size="${fontSize}" text-anchor="middle" font-family="Arial, sans-serif">${esc(l)}</text>`)
    .join("");
}

/** Положение подписи стрелки; общее для SVG и VSDX. */
export function arrowLabelPlacement(a: Idef0Arrow): { x: number; y: number; anchor: "start" | "middle" | "end"; text: string } | null {
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

function renderSvg(d: Idef0DiagramData): string {
  const parts: string[] = [DEFS];
  for (const b of d.blocks) {
    const big = b.w >= 200; // блок контекстной диаграммы
    parts.push(`<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="#eef2ff" stroke="#1f2937" stroke-width="${big ? 1.8 : 1.6}" />`);
    parts.push(textBlock(b.x + b.w / 2, b.y + b.h / 2 - (big ? 8 : 6), b.name, big ? 26 : 22, big ? 13 : 12));
    parts.push(`<text x="${b.x + (big ? 8 : 6)}" y="${b.y + b.h - (big ? 8 : 6)}" font-size="10" font-family="Arial, sans-serif" fill="#4b5563">${esc(b.code)}</text>`);
    if (b.hasChildren) {
      // отметка «есть декомпозиция»: квадрат с плюсом в правом нижнем углу
      const [mx, my] = [b.x + b.w - 18, b.y + b.h - 18];
      parts.push(`<rect x="${mx}" y="${my}" width="12" height="12" fill="#fff" stroke="#1f2937" /><path d="M${mx + 3},${my + 6} H${mx + 9} M${mx + 6},${my + 3} V${my + 9}" stroke="#1f2937" />`);
    }
  }
  for (const a of d.arrows) {
    const path = a.points.map((p, i) => `${i === 0 ? "M" : "L"}${p[0]},${p[1]}`).join(" ");
    parts.push(`<path d="${path}" fill="none" stroke="#1f2937" stroke-width="1.4" marker-end="url(#arrow)" />`);
    const lab = arrowLabelPlacement(a);
    if (lab) {
      parts.push(`<text x="${lab.x}" y="${lab.y}" font-size="10.5" text-anchor="${lab.anchor}" font-family="Arial, sans-serif" fill="#374151">${esc(lab.text)}</text>`);
    }
  }
  d.footer.forEach((line, i) => {
    parts.push(`<text x="16" y="${d.height - 30 + i * 18}" font-size="11" font-family="Arial, sans-serif" fill="#374151">${esc(line)}</text>`);
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${d.width} ${d.height}" width="${d.width}" height="${d.height}">
    <rect x="0" y="0" width="${d.width}" height="${d.height}" fill="#ffffff" />
    <text x="16" y="24" font-size="14" font-weight="bold" font-family="Arial, sans-serif">${esc(d.title)}</text>
    ${parts.join("\n    ")}
  </svg>`;
}

/** Узловое дерево (ФТ-7.4): A0 и вложенные функции с отступами по уровням. */
function renderNodeTree(model: ProcessLogicModel, codes: Map<string, string>): string {
  const rows: { code: string; name: string; level: number; parent: number }[] = [];
  const walk = (parentId: string | null, level: number, parentRow: number) => {
    for (const n of idef0Functions(model, parentId)) {
      if (rows.some((r) => r.code === codes.get(n.id))) continue;
      rows.push({ code: codes.get(n.id) ?? "", name: n.name, level, parent: parentRow });
      walk(n.id, level + 1, rows.length - 1);
    }
  };
  walk(null, 1, -1);
  const ROW_H = 46;
  const X0 = 40;
  const INDENT = 50;
  const BOX_W = 280;
  const maxLevel = Math.max(1, ...rows.map((r) => r.level));
  const width = Math.max(700, X0 + maxLevel * INDENT + BOX_W + 40);
  const height = 60 + (rows.length + 1) * ROW_H;
  const parts: string[] = [];
  parts.push(`<rect x="${X0}" y="20" width="200" height="34" fill="#eef2ff" stroke="#1f2937" />`);
  parts.push(`<text x="${X0 + 100}" y="42" text-anchor="middle" font-size="11" font-family="Arial, sans-serif">A0 — ${esc(model.process.name.length > 26 ? model.process.name.slice(0, 24) + "…" : model.process.name)}</text>`);
  const rowY = (i: number) => 90 + i * ROW_H;
  rows.forEach((r, i) => {
    const x = X0 + r.level * INDENT;
    const y = rowY(i);
    const [px, pBottom] = r.parent < 0 ? [X0 + 20, 54] : [X0 + rows[r.parent].level * INDENT + 20, rowY(r.parent) + 34];
    parts.push(`<path d="M${px},${pBottom} V${y + 17} H${x}" fill="none" stroke="#9ca3af" />`);
    parts.push(`<rect x="${x}" y="${y}" width="${BOX_W}" height="34" fill="#ffffff" stroke="#1f2937" />`);
    const label = `${r.code} — ${r.name}`;
    parts.push(`<text x="${x + BOX_W / 2}" y="${y + 21}" text-anchor="middle" font-size="11" font-family="Arial, sans-serif">${esc(label.length > 40 ? label.slice(0, 38) + "…" : label)}</text>`);
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
    <rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff" />
    ${parts.join("\n    ")}
  </svg>`;
}

/**
 * Детерминированная генерация IDEF0-диаграмм (ФТ-7): контекстная A-0, декомпозиция A0 и
 * диаграммы вложенных функций с ICOM-стрелками, узловое дерево. Позиции блоков берутся из
 * node.idef0_layout (редактор), иначе блоки идут по диагонали.
 */
export function generateIdef0(model: ProcessLogicModel): Idef0Result {
  const codes = idef0Codes(model);
  const { context, root, children } = buildIdef0Diagrams(model);
  return {
    contextSvg: renderSvg(context),
    decompositionSvg: renderSvg(root),
    nodeTreeSvg: renderNodeTree(model, codes),
    blocks: root.blocks,
    width: root.width,
    height: root.height,
    children: children.map((c) => ({ parentNodeId: c.parentNodeId, code: c.code, name: c.name, svg: renderSvg(c), blocks: c.blocks, width: c.width, height: c.height })),
  };
}

/** Экспорт диаграмм декомпозиции в упрощённый draw.io (mxGraph) XML: страница на A0 и на каждую вложенную диаграмму. */
export function idef0ToDrawio(model: ProcessLogicModel, result: Idef0Result): string {
  const page = (name: string, id: string, blocks: Idef0Block[], width: number, height: number) => {
    const cells = blocks.map(
      // ФТ-М9.4.2: id ячейки несёт id узла PLM ("IDEF0_<nodeId>") — это делает возможным
      // round-trip импорт правок из draw.io обратно в модель (routes/diagramImport.ts).
      (b) =>
        `<mxCell id="IDEF0_${b.nodeId}" value="${b.code}: ${escXml(b.name)}" style="rounded=0;whiteSpace=wrap;html=1;fillColor=#eef2ff;strokeColor=#1f2937;" vertex="1" parent="1"><mxGeometry x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" as="geometry" /></mxCell>`
    );
    return `  <diagram name="${escXml(name)}" id="${id}">
    <mxGraphModel dx="800" dy="600" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="${width}" pageHeight="${height}" math="0" shadow="0">
      <root>
        <mxCell id="0" />
        <mxCell id="1" parent="0" />
        ${cells.join("\n        ")}
      </root>
    </mxGraphModel>
  </diagram>`;
  };
  const pages = [
    page("IDEF0 A0", "idef0-a0", result.blocks, result.width, result.height),
    ...(result.children ?? []).map((c) => page(`IDEF0 ${c.code}`, `idef0-${c.code}`, c.blocks, c.width, c.height)),
  ];
  return `<mxfile host="app">
${pages.join("\n")}
</mxfile>`;
}

function escXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
