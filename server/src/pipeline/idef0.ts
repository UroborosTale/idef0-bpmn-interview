import type { ProcessLogicModel, ProcessNode } from "../types/model.js";
import { functionsOf, idef0Codes as sharedCodes, idef0Extents, labelSpec, layoutIdef0, type ArrowKind, type LabelSide, type Pt } from "../shared/idef0Layout.js";

export type { ArrowKind, LabelSide, Pt };

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


export interface Idef0Arrow {
  points: Pt[];
  label?: string;
  side: LabelSide;
  labelRow?: number;
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

// Геометрия диаграмм — общий модуль shared/idef0Layout.ts: его же использует редактор в браузере,
// поэтому нарисованное в редакторе и экспортированное совпадает.
/**
 * Функции одной диаграммы: parentId = null — уровень A0 (верхний; если верхних нет — все задачи),
 * иначе — вложенные функции указанного узла (decomposition вглубь через idef0_parent).
 */
export const idef0Functions = (model: ProcessLogicModel, parentId: string | null): ProcessNode[] => functionsOf(model, parentId);

/** Иерархические коды функций: A1, A2 на верхнем уровне, A31, A32 — вложенные в A3. */
export const idef0Codes = (model: ProcessLogicModel): Map<string, string> => sharedCodes(model);

interface External {
  inputs: string[];
  controls: string[];
  outputs: string[];
  mechanisms: string[];
}

/** Блоки и ICOM-стрелки диаграммы декомпозиции (parentId = null — A0). */
function buildFunctionDiagram(model: ProcessLogicModel, parentId: string | null, codes: Map<string, string>): { data: Idef0DiagramData; ext: External } {
  const parent = parentId ? model.nodes.find((n) => n.id === parentId) : undefined;
  const code = parentId ? codes.get(parentId) ?? "A?" : "A0";
  const layout = layoutIdef0(model, parentId);

  const blocks: Idef0Block[] = layout.functions.map((f) => ({ nodeId: f.node.id, code: f.code, name: f.node.name, ...f.box, hasChildren: f.hasChildren }));
  const arrows: Idef0Arrow[] = layout.arrows.map((a) => ({
    points: a.points,
    label: a.label,
    side: a.side,
    labelRow: a.labelRow,
    ref: { kind: a.kind, nodeId: a.nodeId, entityId: a.entityId },
    // концы, лежащие на блоках: связь — от источника к потребителю, выход — от функции, остальное — в функцию
    startNode: a.fromId ?? (a.kind === "output" ? a.nodeId : undefined),
    endNode: a.kind === "output" ? undefined : a.nodeId,
  }));

  // стрелки на границе диаграммы — это её внешние входы, управление, выходы и механизмы (для A-0)
  const labels = (kinds: string[]) => layout.arrows.filter((a) => kinds.includes(a.kind)).map((a) => a.label);
  const ext: External = {
    inputs: labels(["input"]),
    controls: labels(["control", "controlData"]),
    outputs: labels(["output"]),
    mechanisms: labels(["role", "system"]),
  };

  const ext2 = idef0Extents(layout);
  return {
    data: { code, title: `${code} — ${parent ? parent.name : model.process.name}`, width: ext2.w, height: ext2.h, blocks, arrows, footer: [] },
    ext,
  };
}
/** Контекстная диаграмма A-0. */
function buildContextDiagram(model: ProcessLogicModel, ext: External): Idef0DiagramData {
  const uniq = (arr: string[]) => [...new Set(arr)];
  const inputs = uniq(ext.inputs);
  const controls = uniq([...ext.controls, ...model.controls.map((c) => c.name)]);
  const outputs = uniq(ext.outputs.length ? ext.outputs : model.process.result ? [model.process.result] : []);
  const mechs = uniq([...ext.mechanisms, ...model.roles.map((r) => r.name)]);
  // ширина — с запасом под самые длинные подписи входов и выходов (подписи обрезаются до 26 знаков)
  const longest = Math.max(0, ...[...inputs, ...outputs].slice(0, 10).map((s) => Math.min(26, s.length) * 6.4));
  const W = Math.max(640, Math.ceil(2 * (110 + 90 + longest + 16)));
  const H = 420;
  const cb = { x: W / 2 - 110, y: H / 2 - 55, w: 220, h: 110 };

  const arrows: Idef0Arrow[] = [];
  inputs.slice(0, 5).forEach((name, i) => {
    const y = cb.y + 20 + i * 18;
    arrows.push({ points: [[cb.x - 90, y], [cb.x, y]], label: name, side: "left" });
  });
  controls.slice(0, 5).forEach((name, i) => {
    const x = cb.x + 24 + i * 34;
    arrows.push({ points: [[x, cb.y - 60], [x, cb.y]], label: name, side: "top", labelRow: i % 3 });
  });
  outputs.slice(0, 5).forEach((name, i) => {
    const y = cb.y + 20 + i * 18;
    arrows.push({ points: [[cb.x + cb.w, y], [cb.x + cb.w + 90, y]], label: name, side: "right" });
  });
  mechs.slice(0, 5).forEach((name, i) => {
    const x = cb.x + 24 + i * 34;
    arrows.push({ points: [[x, cb.y + cb.h + 60], [x, cb.y + cb.h]], label: name, side: "bottom", labelRow: i % 3 });
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

/** Положение подписи стрелки; общее для SVG, VSDX и редактора. */
export const arrowLabelPlacement = (a: Idef0Arrow) => labelSpec(a);

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
