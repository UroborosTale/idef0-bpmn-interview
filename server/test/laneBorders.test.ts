import { describe, expect, it } from "vitest";
import { generateBpmn } from "../src/pipeline/bpmn.js";
import { b002Model } from "../src/reference/b002.js";
import { c025Model } from "../src/reference/c025.js";
import { demoModel } from "../src/reference/demo.js";
import { bpmnHosts } from "../src/shared/codes.js";
import { labelBox, labelSide } from "../src/shared/bpmnLabels.js";
import { nudgeOffLaneBorders } from "../src/shared/bpmnRouting.js";
import { albumLabelY } from "../src/export/album.js";

/**
 * Замечание с осмотра (C025.02.01): поток «Уведомление об отчислении» шёл по низу полосы дорожек, а подпись
 * события упиралась в линию дорожки. Правила: отрезок отводится от линии дорожки, подпись — в свою дорожку.
 */
describe("линии дорожек: отрезки и подписи", () => {
  it("горизонтальный отрезок на линии дорожки отводится на 15 px, вертикальный не трогается", () => {
    const pts: [number, number][] = [
      [0, 100],
      [50, 100],
      [50, 200],
    ];
    expect(nudgeOffLaneBorders(pts, [100])).toEqual([
      [0, 115],
      [50, 115],
      [50, 200],
    ]);
    // вниз отводить некуда — занято фигурой: уводим наверх
    const blocked = nudgeOffLaneBorders(
      [
        [0, 100],
        [50, 100],
      ],
      [100],
      [{ x: 0, y: 102, w: 60, h: 12 }]
    );
    expect(blocked).toEqual([
      [0, 115],
      [50, 115],
    ]);
  });

  it("альбом: подпись у нижней границы дорожки ставится над фигурой", () => {
    const band = { top: 210, bottom: 360 };
    // событие почти у нижней границы: под ним подпись не помещается — она над фигурой
    expect(albumLabelY({ y: 324, w: 36, h: 36 }, "Уведомление об отчислении", band)).toBe(318);
    // выше по дорожке подпись остаётся под фигурой
    expect(albumLabelY({ y: 150, w: 36, h: 36 }, "Начало", band)).toBe(197);
  });

  it("на эталонах ни один горизонтальный отрезок стрелки не лежит на линии дорожки", async () => {
    for (const build of [b002Model, c025Model, demoModel]) {
      const m = build();
      for (const h of bpmnHosts(m)) {
        const r = await generateBpmn(m, h.id);
        const borders = [...new Set(r.diagram.lanes.flatMap((l) => [l.y, l.y + l.h]))];
        for (const e of r.diagram.edges) {
          for (let i = 0; i < e.points.length - 1; i++) {
            const [x0, y0] = e.points[i];
            const [x1, y1] = e.points[i + 1];
            if (y0 !== y1) continue;
            const on = borders.find((b) => Math.abs(b - y0) <= 3);
            expect(on, `${h.name}: ${e.id} [${x0},${y0}]-[${x1},${y1}]`).toBeUndefined();
          }
        }
      }
    }
  });

  it("подпись граничного события не налезает на задачу-хозяина (B8)", async () => {
    const r = await generateBpmn(demoModel(), "o11");
    const event = r.diagram.shapes.find((s) => s.nodeId === "o11_late")!;
    const host = r.diagram.shapes.find((s) => s.nodeId === "o11_fill")!;
    const band = r.diagram.lanes.find((l) => event.y >= l.y && event.y + event.h <= l.y + l.h)!;
    const box = { x: event.x, y: event.y, w: event.w, h: event.h };
    const label = labelBox(box, event.name, labelSide(box, event.name, { top: band.y, bottom: band.y + band.h }))!;
    expect(label.y).toBeGreaterThanOrEqual(host.y + host.h);
    expect(label.y + label.h).toBeLessThanOrEqual(band.y + band.h);
  });

  it("подпись события или шлюза остаётся в своей дорожке", async () => {
    for (const build of [b002Model, c025Model, demoModel]) {
      const m = build();
      for (const h of bpmnHosts(m)) {
        const r = await generateBpmn(m, h.id);
        for (const s of r.diagram.shapes) {
          if (s.kind !== "event" && s.kind !== "gateway") continue;
          const band = r.diagram.lanes.find((l) => s.y >= l.y - 0.5 && s.y + s.h <= l.y + l.h + 0.5);
          if (!band) continue;
          const box = { x: s.x, y: s.y, w: s.w, h: s.h };
          const side = labelSide(box, s.name, band);
          const rect = labelBox(box, s.name, side)!;
          const inside = rect.y >= band.y + 1.5 && rect.y + rect.h <= band.y + band.h - 1.5;
          // либо подпись целиком в дорожке, либо места нет ни снизу, ни сверху — тогда остаётся снизу
          if (!inside) expect(side, `${h.name}: ${s.name}`).toBe("below");
        }
      }
    }
  });
});
