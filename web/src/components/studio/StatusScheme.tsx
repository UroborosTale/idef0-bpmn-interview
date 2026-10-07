import { productStages, type StageItem } from "@shared/products";
import type { ProcessLogicModel } from "../../types";
import { wrapText } from "../bpmn-editor/geometry";

const W = 190;
const H = 62;
const GAP = 26; // между продуктами
const GROUP_GAP = 46; // между группами одной стадии
const ROW = 132;
const PAD = 30;
const GROUP_PAD = 12;

/**
 * Схема перехода статусов продуктов процесса (раздел «Входы процесса и их жизненный цикл» регламента):
 * строится по связям функций верхнего уровня — от входов процесса к конечным продуктам. Продукты,
 * которые выпускает одна функция, обведены общей рамкой. Выгружается в SVG и PNG из ленты («Эта диаграмма»).
 */
export default function StatusScheme({ model }: { model: ProcessLogicModel }) {
  const scheme = productStages(model);
  if (scheme.items.length === 0) {
    return (
      <p className="muted" style={{ padding: 16 }}>
        Схему построить не из чего: у функций верхнего уровня нет входов и выходов. Привяжите к функциям документы и данные — схема появится сама.
      </p>
    );
  }

  // строки по стадиям; внутри строки — группы в порядке появления
  const rows: { group: string; items: StageItem[] }[][] = Array.from({ length: scheme.layers }, () => []);
  for (const it of scheme.items) {
    const groups = rows[it.layer];
    const g = groups.find((x) => x.group === it.group);
    if (g) g.items.push(it);
    else groups.push({ group: it.group, items: [it] });
  }
  const rowWidth = (groups: (typeof rows)[number]) => groups.reduce((w, g, i) => w + g.items.length * W + (g.items.length - 1) * GAP + (i > 0 ? GROUP_GAP : 0), 0);
  const width = Math.max(...rows.map(rowWidth)) + PAD * 2;
  const height = rows.length * ROW + PAD * 2 - (ROW - H);

  const pos = new Map<string, { x: number; y: number }>();
  const frames: { x: number; y: number; w: number; h: number; group: string; size: number }[] = [];
  rows.forEach((groups, l) => {
    let x = (width - rowWidth(groups)) / 2;
    const y = PAD + l * ROW;
    groups.forEach((g, gi) => {
      if (gi > 0) x += GROUP_GAP;
      const x0 = x;
      g.items.forEach((it, i) => {
        pos.set(it.id, { x, y });
        x += W + (i < g.items.length - 1 ? GAP : 0);
      });
      frames.push({ x: x0 - GROUP_PAD, y: y - GROUP_PAD, w: x - x0 + 2 * GROUP_PAD, h: H + 2 * GROUP_PAD, group: g.group, size: g.items.length });
    });
  });

  const groupOf = new Map(scheme.items.map((i) => [i.id, i.group] as const));
  const frameOf = new Map(frames.map((f) => [f.group, f] as const));
  const layerOf = new Map(scheme.items.map((i) => [i.id, i.layer] as const));

  // связи: между рамками из нескольких продуктов — одна стрелка, иначе от продукта к продукту
  const drawn = new Set<string>();
  const lines: { key: string; d: string }[] = [];
  const elbow = (x1: number, y1: number, x2: number, y2: number) => {
    const mid = y1 + (y2 - y1) / 2;
    return `M${x1} ${y1} V${mid} H${x2} V${y2}`;
  };
  for (const e of scheme.edges) {
    if ((layerOf.get(e.to) ?? 0) <= (layerOf.get(e.from) ?? 0)) continue; // обратная связь стадий не создаёт
    const gf = frameOf.get(groupOf.get(e.from)!)!;
    const gt = frameOf.get(groupOf.get(e.to)!)!;
    if (gf.size > 1 && gt.size > 1) {
      const key = `${gf.group}>${gt.group}`;
      if (drawn.has(key)) continue;
      drawn.add(key);
      lines.push({ key, d: elbow(gf.x + gf.w / 2, gf.y + gf.h, gt.x + gt.w / 2, gt.y) });
    } else {
      const a = pos.get(e.from)!;
      const b = pos.get(e.to)!;
      const fromY = gf.size > 1 ? gf.y + gf.h : a.y + H;
      const toY = gt.size > 1 ? gt.y : b.y;
      lines.push({ key: `${e.from}>${e.to}`, d: elbow(a.x + W / 2, fromY, b.x + W / 2, toY) });
    }
  }

  return (
    <div className="scheme">
      <div className="passport-bar no-print">
        <h4>Схема перехода статусов</h4>
        <span className="muted">Строится по входам и выходам функций верхнего уровня. Выгрузка — «SVG» и «PNG» в ленте.</span>
      </div>
      <div className="scheme-scroll">
        <svg className="scheme-svg" width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
          <defs>
            <marker id="scheme-arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
              <path d="M0,0 L0,6 L9,3 z" fill="#1f2937" />
            </marker>
          </defs>
          <g transform="translate(0 0)">
            {frames
              .filter((f) => f.size > 1)
              .map((f) => (
                <rect key={f.group} x={f.x} y={f.y} width={f.w} height={f.h} rx={14} fill="#f8fafc" stroke="#1f2937" strokeWidth={1.2} />
              ))}
            {lines.map((l) => (
              <path key={l.key} d={l.d} fill="none" stroke="#1f2937" strokeWidth={1.3} markerEnd="url(#scheme-arrow)" />
            ))}
            {scheme.items.map((it) => {
              const p = pos.get(it.id)!;
              const text = wrapText(it.name, 24, 3);
              return (
                <g key={it.id} data-product-id={it.id}>
                  <rect x={p.x} y={p.y} width={W} height={H} rx={10} fill="#ffffff" stroke="#1f2937" strokeWidth={1.2} />
                  <text x={p.x + W / 2} y={p.y + H / 2 - ((text.length - 1) * 13) / 2 + 4} textAnchor="middle" fontSize={12} fontFamily="Arial, sans-serif" fill="#1e293b">
                    {text.map((line, i) => (
                      <tspan key={i} x={p.x + W / 2} dy={i === 0 ? 0 : 13}>
                        {line}
                      </tspan>
                    ))}
                  </text>
                </g>
              );
            })}
          </g>
        </svg>
      </div>
    </div>
  );
}
