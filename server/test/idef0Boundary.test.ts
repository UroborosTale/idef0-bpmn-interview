import { describe, expect, it } from "vitest";
import { tunnelArcs } from "../src/shared/idef0Layout.js";

/**
 * «Граница» на конце стрелки IDEF0 (как в Business Studio): вместо скобок туннеля рисуется один прямой штрих поперёк
 * стрелки у самого конца. Штрих выходит из той же функции tunnelArcs, что и скобки, поэтому редактор, SVG и Visio
 * рисуют его одной веткой кода и отдельных правок в выгрузках не нужно.
 */
describe("граница на конце стрелки IDEF0", () => {
  const line: [number, number][] = [
    [200, 100],
    [80, 100],
  ];

  it("туннель — две дуги скобок, граница — один прямой штрих", () => {
    const tunnel = tunnelArcs({ kind: "input", points: line, tunnelUp: true });
    expect(tunnel).toHaveLength(2);
    expect(tunnel[0].from[0]).not.toBe(tunnel[1].from[0]); // две скобки, смещённые вдоль стрелки
    expect(tunnel.map((a) => a.from[0]).filter((x) => x === tunnel[0].to[0]).length).toBeGreaterThanOrEqual(0);

    const boundary = tunnelArcs({ kind: "input", points: line, boundaryUp: true });
    expect(boundary).toHaveLength(1);
    // штрих прямой: контрольная точка ровно в середине между началом и концом
    expect(boundary[0].ctl[0]).toBeCloseTo((boundary[0].from[0] + boundary[0].to[0]) / 2);
    expect(boundary[0].ctl[1]).toBeCloseTo((boundary[0].from[1] + boundary[0].to[1]) / 2);
    // штрих поперёк стрелки: он вертикальный (стрелка горизонтальна), высота 16 px
    expect(boundary[0].from[0]).toBeCloseTo(boundary[0].to[0]);
    expect(Math.abs(boundary[0].from[1] - boundary[0].to[1])).toBeCloseTo(16);
  });

  it("без пометок и у стрелок без ICOM-концов ничего не рисуется", () => {
    expect(tunnelArcs({ kind: "input", points: line })).toEqual([]);
    expect(tunnelArcs({ kind: "role", points: line, boundaryUp: true })).toEqual([]);
    expect(tunnelArcs({ kind: "output", points: [[0, 0]] as [number, number][], boundaryDown: true })).toEqual([]);
  });
});
