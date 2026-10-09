import { describe, expect, it } from "vitest";
import { generateBpmn } from "../src/pipeline/bpmn.js";
import { demoModel } from "../src/reference/demo.js";
import { b002Model } from "../src/reference/b002.js";
import { c025Model } from "../src/reference/c025.js";
import { bpmnHosts } from "../src/shared/codes.js";
import { crossingCount, type Pt } from "../src/shared/bpmnRouting.js";

/**
 * Парный пересмотр сторон у общего конца. Жадная прокладка отдаёт нижнюю вершину шлюза первой ветке (она короче), и вторая
 * вынуждена выходить вправо и пересекать первую. Одиночный пересмотр из этого не выходит, нужен обмен сторонами сразу у обеих.
 * На изолированных примерах дефект не воспроизводится — нужен контекст всей диаграммы, поэтому проверка идёт на эталонных.
 */
describe("стрелки с общим концом не пересекаются между собой, если этого можно избежать", () => {
  it("демо, согласование заявки: две ветки параллельного шлюза идут в разные дорожки без пересечения", async () => {
    const { diagram: d } = await generateBpmn(demoModel(), "o12");
    const split = d.shapes.find((s) => s.name === "Параллельное согласование")!;
    const out = d.edges.filter((e) => e.from === split.id);
    expect(out).toHaveLength(2);
    expect(crossingCount(out[0].points as Pt[], out[1].points as Pt[])).toBe(0);
  });

  it("на всех диаграммах эталонов стрелки с общим началом или концом не пересекаются", async () => {
    let pairs = 0;
    for (const m of [b002Model(), c025Model(), demoModel()]) {
      for (const h of bpmnHosts(m)) {
        const { diagram: d } = await generateBpmn(m, h.id);
        for (let i = 0; i < d.edges.length; i++) {
          for (let j = i + 1; j < d.edges.length; j++) {
            const [a, b] = [d.edges[i], d.edges[j]];
            if (a.from === b.from || a.to === b.to) pairs += crossingCount(a.points as Pt[], b.points as Pt[]);
          }
        }
      }
    }
    expect(pairs).toBe(0); // до пересмотра было 1 — как раз ветки «Параллельного согласования»
  }, 120_000);
});

