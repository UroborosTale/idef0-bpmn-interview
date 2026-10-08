import { describe, expect, it } from "vitest";
import { SIZE, flowLabelPoint, waypoints, type Box, type EndKinds, type Pt } from "../src/shared/bpmnGeometry.js";

const box = (type: keyof typeof SIZE, cx: number, cy: number): Box => ({ x: cx - SIZE[type].w / 2, y: cy - SIZE[type].h / 2, w: SIZE[type].w, h: SIZE[type].h });
const ports = (b: Box): Pt[] => [[b.x + b.w, b.y + b.h / 2], [b.x, b.y + b.h / 2], [b.x + b.w / 2, b.y], [b.x + b.w / 2, b.y + b.h]];
const same = (a: Pt, b: Pt) => Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;
const onPort = (p: Pt, b: Box) => ports(b).some((q) => same(p, q));
/** Отрезок (горизонтальный или вертикальный) пересекает внутренность прямоугольника. */
const cuts = (a: Pt, b: Pt, r: Box) => {
  const x1 = Math.min(a[0], b[0]);
  const x2 = Math.max(a[0], b[0]);
  const y1 = Math.min(a[1], b[1]);
  const y2 = Math.max(a[1], b[1]);
  return x2 > r.x + 0.5 && x1 < r.x + r.w - 0.5 && y2 > r.y + 0.5 && y1 < r.y + r.h - 0.5;
};

function check(from: Box, to: Box, kinds: EndKinds, obstacles: Box[] = []) {
  const pts = waypoints(from, to, obstacles, kinds);
  expect(pts.length).toBeGreaterThanOrEqual(2);
  expect(onPort(pts[0], from)).toBe(true); // выходит из середины стороны источника
  expect(onPort(pts[pts.length - 1], to)).toBe(true); // входит в середину стороны цели
  for (let i = 0; i < pts.length - 1; i++) {
    expect(same(pts[i], pts[i + 1])).toBe(false); // нет нулевых отрезков
    expect(pts[i][0] === pts[i + 1][0] || pts[i][1] === pts[i + 1][1]).toBe(true); // ортогонально
  }
  return pts;
}

describe("маршрутизация стрелок BPMN", () => {
  it("на одной линии — прямая от правого края к левому", () => {
    const a = box("task", 100, 150);
    const b = box("task", 400, 150);
    expect(check(a, b, {})).toEqual([[150, 150], [350, 150]]);
  });

  it("на одной линии с фигурой на пути — обход поверху: вверх из источника, вниз в цель", () => {
    const a = box("task", 100, 150);
    const mid = box("event", 250, 150);
    const b = box("task", 400, 150);
    const pts = check(a, b, {}, [mid]);
    expect(pts[0]).toEqual([100, 110]); // верхняя сторона источника
    expect(pts.at(-1)).toEqual([400, 110]);
    expect(Math.min(...pts.map((p) => p[1]))).toBeLessThan(mid.y);
  });

  it("ветка шлюза вниз и вверх уходит из нижней и верхней вершины и входит в цель слева", () => {
    const g = box("gateway", 200, 150);
    const low = box("task", 450, 300);
    const high = box("task", 450, 0);
    const down = check(g, low, { fromType: "gateway", toType: "task" });
    expect(down[0]).toEqual([200, 175]);
    expect(down.at(-1)).toEqual([400, 300]);
    expect(down).toHaveLength(3);
    const up = check(g, high, { fromType: "gateway", toType: "task" });
    expect(up[0]).toEqual([200, 125]);
    expect(up.at(-1)).toEqual([400, 0]);
  });

  it("прямая ветка шлюза на своём уровне — из правой вершины", () => {
    const g = box("gateway", 200, 150);
    expect(check(g, box("task", 450, 150), { fromType: "gateway", toType: "task" })[0]).toEqual([225, 150]);
  });

  it("стрелка к шлюзу с другого уровня входит в верхнюю или нижнюю вершину", () => {
    const t = box("task", 100, 50);
    const g = box("gateway", 400, 200);
    const pts = check(t, g, { fromType: "task", toType: "gateway" });
    expect(pts.at(-1)).toEqual([400, 175]); // сверху
    expect(pts).toHaveLength(3);
    const below = check(box("task", 100, 350), g, { fromType: "task", toType: "gateway" });
    expect(below.at(-1)).toEqual([400, 225]); // снизу
  });

  it("шлюз → шлюз на разных уровнях: из вершины и в левую вершину цели", () => {
    const pts = check(box("gateway", 100, 150), box("gateway", 300, 300), { fromType: "gateway", toType: "gateway" });
    expect(pts[0]).toEqual([100, 175]);
    expect(pts.at(-1)).toEqual([275, 300]);
  });

  it("задача → задача на другом уровне — излом посередине между фигурами", () => {
    const pts = check(box("task", 100, 150), box("task", 400, 300), {});
    expect(pts).toHaveLength(4);
    expect(pts[1][0]).toBe(pts[2][0]);
    expect(pts[1][0]).toBeGreaterThan(150);
    expect(pts[1][0]).toBeLessThan(350);
  });

  it("друг под другом — прямая вертикаль, при смещении — излом между фигурами", () => {
    expect(check(box("task", 100, 100), box("task", 100, 300), {})).toEqual([[100, 140], [100, 260]]);
    const pts = check(box("task", 100, 100), box("task", 140, 300), {});
    expect(pts[0]).toEqual([100, 140]);
    expect(pts.at(-1)).toEqual([140, 260]);
  });

  it("возврат назад: у задач — петля под фигурами и вход снизу; у шлюзов и событий — поверху", () => {
    const a = box("task", 600, 150);
    const b = box("task", 200, 150);
    const mid = box("task", 400, 150);
    const loop = check(a, b, {}, [mid]);
    expect(loop[0]).toEqual([600, 190]);
    expect(loop.at(-1)).toEqual([200, 190]);
    expect(Math.max(...loop.map((p) => p[1]))).toBeGreaterThan(mid.y + mid.h);
    const g = check(box("gateway", 600, 150), box("task", 200, 150), { fromType: "gateway", toType: "task" }, [mid]);
    expect(g[0]).toEqual([600, 125]);
    expect(Math.min(...g.map((p) => p[1]))).toBeLessThan(mid.y);
  });

  it("граничное событие: линия уходит вниз от нижней границы задачи и входит в цель слева", () => {
    const task = box("task", 300, 150);
    const be = box("event", 300, 190); // на нижней границе задачи
    const target = box("task", 500, 320);
    const pts = check(be, target, { fromType: "event", toType: "task", fromBoundary: true }, [task]);
    expect(pts[0]).toEqual([300, 208]);
    expect(pts.at(-1)).toEqual([450, 320]);
    expect(pts.every((p) => p[1] >= 208 || p === pts.at(-1))).toBe(true);
    // цель на уровне задачи — обход под ней и вход в нижнюю сторону цели
    const same = check(be, box("task", 520, 150), { fromType: "event", toType: "task", fromBoundary: true }, [task]);
    expect(same[0]).toEqual([300, 208]);
    expect(same.at(-1)).toEqual([520, 190]);
  });

  it("свойство: на любых расстановках маршрут ортогонален, начинается и кончается в серединах сторон и не режет свои фигуры", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
    const types = ["task", "gateway", "event", "subprocess"] as const;
    let checked = 0;
    for (let i = 0; i < 3000; i++) {
      const ta = types[Math.floor(rnd() * 4)];
      const tb = types[Math.floor(rnd() * 4)];
      const a = box(ta, 100 + Math.round(rnd() * 1200), 100 + Math.round(rnd() * 5) * 75);
      const b = box(tb, 100 + Math.round(rnd() * 1200), 100 + Math.round(rnd() * 5) * 75);
      const overlap = a.x < b.x + b.w + 10 && a.x + a.w + 10 > b.x && a.y < b.y + b.h + 10 && a.y + a.h + 10 > b.y;
      if (overlap) continue;
      const pts = check(a, b, { fromType: ta, toType: tb });
      for (let k = 0; k < pts.length - 1; k++) {
        expect(cuts(pts[k], pts[k + 1], a)).toBe(false);
        expect(cuts(pts[k], pts[k + 1], b)).toBe(false);
      }
      checked++;
    }
    expect(checked).toBeGreaterThan(1500);
  });
});

describe("подпись стрелки", () => {
  it("у начала маршрута: над горизонтальным отрезком и справа от вертикального", () => {
    const h = flowLabelPoint([[100, 50], [300, 50]]);
    expect(h).toMatchObject({ x: 134, y: 44, anchor: "middle" });
    const short = flowLabelPoint([[100, 50], [120, 50]]);
    expect(short.x).toBe(110);
    const v = flowLabelPoint([[100, 50], [100, 200]]);
    expect(v).toMatchObject({ x: 106, anchor: "start" });
    expect(v.y).toBeGreaterThan(50);
    expect(flowLabelPoint([[100, 50], [100, -100]]).y).toBeLessThan(50);
  });
});
