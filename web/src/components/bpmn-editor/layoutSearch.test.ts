import { describe, expect, it } from "vitest";
import { routeQuality } from "@shared/bpmnRouting";
import { scopeView } from "@shared/scope";
import { bpmnHosts } from "@shared/codes";
import { b002Model } from "../../../../server/src/reference/b002";
import { c025Model } from "../../../../server/src/reference/c025";
import { demoModel } from "../../../../server/src/reference/demo";
import type { ProcessLogicModel } from "../../types";
import { autoLayout, diagramLayout, optimizedLayout, withLayout } from "./geometry";

type M = ProcessLogicModel;

/** Пересечения, проходы сквозь фигуры при данной расстановке диаграммы операции (как её рисует редактор). */
function quality(view: M, pos: Map<string, { x: number; y: number }>) {
  const laid: M = { ...view, nodes: view.nodes.map((n) => (pos.has(n.id) ? { ...n, layout: pos.get(n.id)! } : n)) };
  const d = diagramLayout(laid);
  return routeQuality(
    d.shown.map((n) => ({ id: n.id, type: n.type, box: d.boxes.get(n.id)! })),
    d.flows.map((f) => ({ id: f.id, from: f.from, to: f.to })),
    d.routes
  );
}

describe("кнопка «Расставить»: подбор по числу пересечений стрелок", () => {
  it("на диаграммах эталонов B002, C025 и демо подбор не хуже обычной раскладки по столбцам", () => {
    let base = 0;
    let opt = 0;
    let cuts = 0;
    for (const [name, m] of [["b002", b002Model()], ["c025", c025Model()], ["demo", demoModel()]] as const) {
      for (const h of bpmnHosts(m)) {
        const view = scopeView(m as M, h.id);
        const a = quality(view, autoLayout(view));
        const b = quality(view, optimizedLayout(view));
        expect(b.crossings, `${name} ${h.id}`).toBeLessThanOrEqual(a.crossings);
        expect(b.cuts, `${name} ${h.id}`).toBeLessThanOrEqual(a.cuts);
        base += a.crossings;
        opt += b.crossings;
        cuts += b.cuts;
      }
    }
    expect(opt).toBeLessThanOrEqual(base);
    expect(cuts).toBeGreaterThanOrEqual(0);
  }, 120_000);

  it("результат воспроизводим; фигуры не налезают друг на друга (одна ячейка — одна фигура)", () => {
    const view = scopeView(c025Model() as M, "o13");
    const a = optimizedLayout(view);
    const b = optimizedLayout(view);
    expect([...b]).toEqual([...a]);
    const boxes = [...a.values()];
    expect(new Set(boxes.map((p) => `${p.x}:${p.y}`)).size).toBe(boxes.length);
  });

  it("маленькая диаграмма (меньше четырёх фигур) расставляется как обычно; withLayout с optimize работает только вместе с force", () => {
    const view = scopeView(c025Model() as M, "o13");
    const tiny: M = { ...view, nodes: view.nodes.slice(0, 3), flows: [] };
    expect([...optimizedLayout(tiny)]).toEqual([...autoLayout(tiny)]);
    const unlaid: M = { ...view, nodes: view.nodes.map((n) => ({ ...n, layout: undefined })) };
    // без force достраиваются только недостающие позиции — обычной раскладкой
    expect(withLayout(unlaid, false, undefined, true).nodes.map((n) => n.layout)).toEqual(withLayout(unlaid, false).nodes.map((n) => n.layout));
    expect(withLayout(unlaid, true, undefined, true).nodes.every((n) => n.layout || n.attached_to)).toBe(true);
  });
});