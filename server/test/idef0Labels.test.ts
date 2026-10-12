import { describe, expect, it } from "vitest";
import { REFERENCE_PROCESSES } from "../src/reference/index.js";
import { assignLabelRows, functionsOf, labelSpec, labelWidth, layoutIdef0 } from "../src/shared/idef0Layout.js";

/** Прямоугольник подписи на диаграмме. */
function labelRects(m: any, parent: string | null) {
  const lay = layoutIdef0(m, parent);
  return lay.arrows
    .map((a) => ({ a, s: labelSpec(a) }))
    .filter((x) => x.s)
    .map(({ a, s }) => {
      const w = labelWidth(s!.text);
      const x0 = s!.anchor === "middle" ? s!.x - w / 2 : s!.anchor === "end" ? s!.x - w : s!.x;
      return { key: a.key, side: a.side, x0, x1: x0 + w, y0: s!.y - 10, y1: s!.y + 2 };
    });
}
const hit = (a: { x0: number; x1: number; y0: number; y1: number }, b: typeof a) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
const diagramsOf = (m: any): (string | null)[] => [null, ...new Set(m.nodes.filter((n: any) => m.nodes.some((c: any) => c.idef0_parent === n.id)).map((n: any) => n.id as string))];

describe("подписи стрелок IDEF0: строки по ширине подписей", () => {
  it("assignLabelRows: далёкие подписи делят строку, близкие и широкие разводятся по разным", () => {
    const rows = assignLabelRows([{ x: 0, label: "Начальник отдела закупок" }, { x: 40, label: "Финансовый директор" }, { x: 80, label: "ERP" }, { x: 400, label: "Юрист" }]);
    expect(rows[0]).not.toBe(rows[1]);
    expect(rows[1]).not.toBe(rows[2]);
    expect(rows[3]).toBe(0); // далеко от остальных — первая строка
    // результат не зависит от порядка подачи
    const shuffled = assignLabelRows([{ x: 400, label: "Юрист" }, { x: 80, label: "ERP" }, { x: 0, label: "Начальник отдела закупок" }, { x: 40, label: "Финансовый директор" }]);
    expect(shuffled).toEqual([rows[3], rows[2], rows[0], rows[1]]);
    expect(assignLabelRows([])).toEqual([]);
    expect(assignLabelRows(Array.from({ length: 30 }, (_, i) => ({ x: i, label: "Очень длинная подпись стрелки" })))).toSatisfy((r: number[]) => Math.max(...r) <= 7); // строк не больше предела
  });

  it("все подписи эталонов: наложений между подписями (всех видов) почти нет, и они не стали хуже прежнего", () => {
    let total = 0;
    const found: string[] = [];
    for (const [name, p] of Object.entries(REFERENCE_PROCESSES)) {
      const m: any = p.build();
      for (const d of diagramsOf(m)) {
        const rects = labelRects(m, d);
        for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) if (hit(rects[i], rects[j])) { total++; found.push(`${name}/${d ?? "A0"}: ${rects[i].key} × ${rects[j].key}`); }
      }
    }
    // до правки на эталонах было 12 наложений между подписями разных видов (механизм × связь, вход × связь…); остались три «вход слева × связь по середине»
    expect(total, found.join(" ; ")).toBeLessThanOrEqual(3);
  });

  it("подписи управления и механизмов одного блока не налезают друг на друга ни на одной диаграмме эталонов", () => {
    const found: string[] = [];
    for (const [name, p] of Object.entries(REFERENCE_PROCESSES)) {
      const m: any = p.build();
      for (const d of diagramsOf(m)) {
        const lay = layoutIdef0(m, d);
        const byNode = new Map<string, ReturnType<typeof labelRects>>();
        const rects = labelRects(m, d);
        for (const r of rects) {
          if (r.side !== "top" && r.side !== "bottom") continue;
          const node = lay.arrows.find((a) => a.key === r.key)!.nodeId;
          const k = `${node}:${r.side}`;
          byNode.set(k, [...(byNode.get(k) ?? []), r]);
        }
        for (const [k, list] of byNode) for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) if (hit(list[i], list[j])) found.push(`${name}/${d ?? "A0"}/${k}: ${list[i].key} × ${list[j].key}`);
      }
    }
    expect(found).toEqual([]);
  });
});
