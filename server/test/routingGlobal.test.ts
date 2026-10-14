import { describe, expect, it } from "vitest";
import { generateBpmn } from "../src/pipeline/bpmn.js";
import { b002Model } from "../src/reference/b002.js";
import { c025Model } from "../src/reference/c025.js";
import { demoModel } from "../src/reference/demo.js";
import { SIZE, type Box, type Pt } from "../src/shared/bpmnGeometry.js";
import { bpmnHosts } from "../src/shared/codes.js";
import { routeFlows, type RouteFlow, type RouteNode } from "../src/shared/bpmnRouting.js";

const node = (id: string, type: keyof typeof SIZE, cx: number, cy: number, extra: Partial<RouteNode> = {}): RouteNode => ({ id, type, box: { x: cx - SIZE[type].w / 2, y: cy - SIZE[type].h / 2, w: SIZE[type].w, h: SIZE[type].h }, ...extra });
const isH = (a: Pt, b: Pt) => Math.abs(a[1] - b[1]) < 1e-6;
const same = (a: Pt, b: Pt, d = 0.01) => Math.hypot(a[0] - b[0], a[1] - b[1]) < d;
const onSide = (p: Pt, b: Box) => (Math.abs(p[0] - b.x) < 1 ? "L" : Math.abs(p[0] - b.x - b.w) < 1 ? "R" : Math.abs(p[1] - b.y) < 1 ? "T" : Math.abs(p[1] - b.y - b.h) < 1 ? "B" : "?");

interface Seg {
  id: string;
  axis: "x" | "y";
  at: number;
  a: number;
  b: number;
}
const segmentsOf = (routes: Map<string, Pt[]>): Seg[] =>
  [...routes].flatMap(([id, pts]) => pts.slice(0, -1).map((p, i): Seg => (isH(p, pts[i + 1]) ? { id, axis: "y", at: p[1], a: Math.min(p[0], pts[i + 1][0]), b: Math.max(p[0], pts[i + 1][0]) } : { id, axis: "x", at: p[0], a: Math.min(p[1], pts[i + 1][1]), b: Math.max(p[1], pts[i + 1][1]) })));
/** Пары стрелок, у которых есть участки на одной прямой с перекрытием. */
const overlaps = (routes: Map<string, Pt[]>) => {
  const segs = segmentsOf(routes);
  const out: [string, string][] = [];
  for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) if (segs[i].id !== segs[j].id && segs[i].axis === segs[j].axis && Math.abs(segs[i].at - segs[j].at) < 3 && Math.min(segs[i].b, segs[j].b) - Math.max(segs[i].a, segs[j].a) > 2) out.push([segs[i].id, segs[j].id]);
  return out;
};
/** Стрелки, у которых концы на одной фигуре расположены ближе d друг к другу (общий порт). */
const sharedPorts = (routes: Map<string, Pt[]>, flows: RouteFlow[], d = 5) => {
  const ends = new Map<string, { id: string; p: Pt }[]>();
  for (const f of flows) {
    const pts = routes.get(f.id);
    if (!pts) continue;
    ends.set(f.from, [...(ends.get(f.from) ?? []), { id: f.id, p: pts[0] }]);
    ends.set(f.to, [...(ends.get(f.to) ?? []), { id: f.id, p: pts[pts.length - 1] }]);
  }
  const out: string[] = [];
  for (const [n, list] of ends) for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) if (Math.hypot(list[i].p[0] - list[j].p[0], list[i].p[1] - list[j].p[1]) < d) out.push(`${n}: ${list[i].id} / ${list[j].id}`);
  return out;
};
const cuts = (routes: Map<string, Pt[]>, flows: RouteFlow[], nodes: RouteNode[]) => {
  const out: string[] = [];
  for (const f of flows) {
    const pts = routes.get(f.id);
    if (!pts) continue;
    for (let i = 0; i + 1 < pts.length; i++) {
      for (const n of nodes) {
        if (n.id === f.from && i === 0) continue;
        if (n.id === f.to && i === pts.length - 2) continue;
        const r = n.box;
        const [x1, x2, y1, y2] = [Math.min(pts[i][0], pts[i + 1][0]), Math.max(pts[i][0], pts[i + 1][0]), Math.min(pts[i][1], pts[i + 1][1]), Math.max(pts[i][1], pts[i + 1][1])];
        if (x2 > r.x + 0.5 && x1 < r.x + r.w - 0.5 && y2 > r.y + 0.5 && y1 < r.y + r.h - 0.5) out.push(`${f.id} через ${n.id}`);
      }
    }
  }
  return out;
};

describe("прокладка стрелок по всей диаграмме", () => {
  it("шлюз с тремя ветками: каждая выходит из своей вершины (справа, сверху, снизу)", () => {
    const nodes = [node("g", "gateway", 200, 300), node("mid", "task", 450, 300), node("up", "task", 450, 120), node("down", "task", 450, 480)];
    const flows = [{ id: "a", from: "g", to: "mid" }, { id: "b", from: "g", to: "up" }, { id: "c", from: "g", to: "down" }];
    const r = routeFlows(nodes, flows);
    expect(["a", "b", "c"].map((id) => onSide(r.get(id)![0], nodes[0].box)).sort()).toEqual(["B", "R", "T"]);
    expect(onSide(r.get("a")![0], nodes[0].box)).toBe("R"); // прямая ветка — справа
    expect(sharedPorts(r, flows)).toEqual([]);
    expect(overlaps(r)).toEqual([]);
  });

  it("шлюз слияния с тремя входами: слева, сверху и снизу — разные вершины", () => {
    const nodes = [node("a", "task", 100, 300), node("b", "task", 100, 120), node("c", "task", 100, 480), node("m", "gateway", 400, 300)];
    const flows = [{ id: "fa", from: "a", to: "m" }, { id: "fb", from: "b", to: "m" }, { id: "fc", from: "c", to: "m" }];
    const r = routeFlows(nodes, flows);
    expect(flows.map((f) => onSide(r.get(f.id)!.at(-1)!, nodes[3].box)).sort()).toEqual(["B", "L", "T"]);
    expect(sharedPorts(r, flows)).toEqual([]);
  });

  it("четыре потока в один шлюз: вершин не хватает — стрелки входят в разные точки стороны, а не в одну", () => {
    const nodes = [node("a", "task", 100, 300), node("b", "task", 100, 120), node("c", "task", 100, 480), node("d", "task", 700, 300), node("m", "gateway", 400, 300)];
    const flows = [{ id: "fa", from: "a", to: "m" }, { id: "fb", from: "b", to: "m" }, { id: "fc", from: "c", to: "m" }, { id: "fd", from: "d", to: "m" }];
    const r = routeFlows(nodes, flows);
    expect(sharedPorts(r, flows)).toEqual([]);
    expect(overlaps(r)).toEqual([]);
  });

  it("в каждый вход — одна стрелка: три стрелки в одну задачу входят в три разные стороны, из одной вершины шлюза — одна", () => {
    const nodes = [node("a", "task", 100, 150), node("b", "task", 100, 450), node("c", "task", 100, 300), node("t", "task", 500, 300)];
    const flows = [{ id: "fa", from: "a", to: "t" }, { id: "fb", from: "b", to: "t" }, { id: "fc", from: "c", to: "t" }];
    const r = routeFlows(nodes, flows);
    const sides = flows.map((f) => onSide(r.get(f.id)!.at(-1)!, nodes[3].box));
    expect(new Set(sides).size).toBe(3); // ни одна сторона не принимает две стрелки
    expect(sides).not.toContain("?");
    expect(sharedPorts(r, flows, 30)).toEqual([]); // и тем более не слипаются
  });

  it("две стрелки в одну задачу входят в разные места (стороны) и не накладываются", () => {
    const nodes = [node("a", "task", 100, 150), node("b", "task", 100, 450), node("t", "task", 500, 300)];
    const flows = [{ id: "fa", from: "a", to: "t" }, { id: "fb", from: "b", to: "t" }];
    const r = routeFlows(nodes, flows);
    const ends = flows.map((f) => r.get(f.id)!.at(-1)!);
    expect(ends.every((p) => onSide(p, nodes[2].box) !== "?")).toBe(true);
    expect(Math.hypot(ends[0][0] - ends[1][0], ends[0][1] - ends[1][1])).toBeGreaterThanOrEqual(10);
    expect(sharedPorts(r, flows)).toEqual([]);
    expect(overlaps(r)).toEqual([]);
  });

  it("параллельные Z-стрелки между теми же столбцами разведены каналами: общий вертикальный участок не используется дважды", () => {
    const nodes = [node("a1", "task", 100, 150), node("a2", "task", 100, 300), node("b1", "task", 500, 450), node("b2", "task", 500, 600)];
    const flows = [{ id: "x", from: "a1", to: "b1" }, { id: "y", from: "a2", to: "b2" }];
    const r = routeFlows(nodes, flows);
    expect(overlaps(r)).toEqual([]);
    const verticals = segmentsOf(r).filter((s) => s.axis === "x" && s.b - s.a > 50);
    expect(verticals).toHaveLength(2);
    expect(Math.abs(verticals[0].at - verticals[1].at)).toBeGreaterThanOrEqual(8); // их диапазоны по высоте перекрываются
  });

  it("стрелки «крест-накрест» между двумя уровнями не накладываются: одной из них выбирается другая форма", () => {
    const nodes = [node("a1", "task", 100, 150), node("a2", "task", 100, 450), node("b1", "task", 500, 450), node("b2", "task", 500, 150)];
    const flows = [{ id: "x", from: "a1", to: "b1" }, { id: "y", from: "a2", to: "b2" }];
    const r = routeFlows(nodes, flows);
    expect(overlaps(r)).toEqual([]);
    expect(sharedPorts(r, flows)).toEqual([]);
    expect(cuts(r, flows, nodes)).toEqual([]);
  });
  it("петли от нескольких шагов к одному шлюзу идут разными линиями", () => {
    const nodes = [node("m", "gateway", 100, 300), node("t1", "task", 350, 300), node("t2", "task", 550, 300), node("t3", "task", 750, 300)];
    const flows = [{ id: "r1", from: "t1", to: "m" }, { id: "r2", from: "t2", to: "m" }, { id: "r3", from: "t3", to: "m" }];
    const r = routeFlows(nodes, flows);
    expect(sharedPorts(r, flows)).toEqual([]);
    expect(overlaps(r)).toEqual([]);
    expect(cuts(r, flows, nodes)).toEqual([]);
  });

  it("граничное событие: линия уходит вниз; стрелка самой задачи — своя, не из того же порта", () => {
    const host = node("t", "task", 300, 300);
    const be = { ...node("be", "event", 300, 340), boundary: true };
    const nodes = [host, be, node("n", "task", 600, 300), node("h", "task", 600, 480)];
    const flows = [{ id: "main", from: "t", to: "n" }, { id: "alt", from: "be", to: "h" }];
    const r = routeFlows(nodes, flows);
    expect(onSide(r.get("alt")![0], be.box)).toBe("B");
    expect(onSide(r.get("main")![0], host.box)).toBe("R");
    expect(sharedPorts(r, flows)).toEqual([]);
  });

  it("потоки сообщений от одного шага к пулу: разные порты на шаге и на пуле, линии не накладываются", () => {
    const nodes = [node("t", "task", 300, 200), node("u", "task", 500, 200), { id: "pool", type: "pool", box: { x: 250, y: 600, w: 300, h: 40 } } as RouteNode];
    const flows = [{ id: "m1", from: "t", to: "pool", message: true }, { id: "m2", from: "pool", to: "t", message: true }, { id: "m3", from: "u", to: "pool", message: true }];
    const r = routeFlows(nodes, flows);
    expect(sharedPorts(r, flows)).toEqual([]);
    expect(overlaps(r)).toEqual([]);
    expect(onSide(r.get("m1")![0], nodes[0].box)).toBe("B");
    expect(onSide(r.get("m2")!.at(-1)!, nodes[0].box)).toBe("B");
    expect(onSide(r.get("m1")!.at(-1)!, nodes[2].box)).toBe("T");
  });

  it("значки документов над задачей не пересекаются стрелками", () => {
    const nodes = [node("a", "task", 100, 300), node("b", "task", 300, 300), node("c", "task", 500, 300)];
    const icon: Box = { x: 280, y: 232, w: 22, h: 26 };
    const r = routeFlows(nodes, [{ id: "f", from: "a", to: "c" }], [icon]);
    const pts = r.get("f")!;
    for (let i = 0; i + 1 < pts.length; i++) {
      const [x1, x2, y1, y2] = [Math.min(pts[i][0], pts[i + 1][0]), Math.max(pts[i][0], pts[i + 1][0]), Math.min(pts[i][1], pts[i + 1][1]), Math.max(pts[i][1], pts[i + 1][1])];
      expect(x2 > icon.x && x1 < icon.x + icon.w && y2 > icon.y && y1 < icon.y + icon.h).toBe(false);
    }
  });

  it("быстро: 80 фигур и 120 стрелок — меньше секунды", () => {
    const nodes: RouteNode[] = [];
    for (let c = 0; c < 20; c++) for (let r = 0; r < 4; r++) nodes.push(node(`n${c}_${r}`, c % 3 === 0 ? "gateway" : "task", 150 + c * 220, 135 + r * 150));
    const flows: RouteFlow[] = [];
    for (let c = 0; c < 19; c++) for (let r = 0; r < 4; r++) if ((c + r) % 3 !== 0) flows.push({ id: `f${c}_${r}`, from: `n${c}_${r}`, to: `n${c + 1}_${(r + (c % 2)) % 4}` });
    const t0 = Date.now();
    const routes = routeFlows(nodes, flows.slice(0, 120));
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(routes.size).toBeGreaterThan(40);
  });

  it("свойство на случайных схемах: линии ортогональны и концы не совпадают; наложения и проходы сквозь фигуры — редкость", () => {
    let seed = 11;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
    const types = ["task", "task", "task", "gateway", "event", "subprocess"] as const;
    let flowsTotal = 0;
    let overlapCount = 0;
    let cutCount = 0;
    for (let it = 0; it < 200; it++) {
      const cols = 3 + Math.floor(rnd() * 5);
      const rows = 2 + Math.floor(rnd() * 3);
      const nodes: RouteNode[] = [];
      for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) if (rnd() < 0.55) nodes.push(node(`n${nodes.length}`, types[Math.floor(rnd() * types.length)], 160 + c * 220, 135 + r * 150));
      if (nodes.length < 3) continue;
      const flows: RouteFlow[] = [];
      const seen = new Set<string>();
      const want = Math.floor(nodes.length * (0.8 + rnd() * 0.8));
      for (let k = 0; k < want * 4 && flows.length < want; k++) {
        const a = Math.floor(rnd() * nodes.length);
        const b = Math.floor(rnd() * nodes.length);
        if (a === b || seen.has(`${a}>${b}`)) continue;
        seen.add(`${a}>${b}`);
        flows.push({ id: `f${flows.length}`, from: `n${a}`, to: `n${b}` });
      }
      const r = routeFlows(nodes, flows);
      flowsTotal += flows.length;
      expect(r.size).toBe(flows.length);
      for (const [, pts] of r) for (let i = 0; i + 1 < pts.length; i++) expect(pts[i][0] === pts[i + 1][0] || pts[i][1] === pts[i + 1][1]).toBe(true);
      expect(sharedPorts(r, flows)).toEqual([]); // общих портов не бывает вообще
      overlapCount += overlaps(r).length;
      cutCount += cuts(r, flows, nodes).length;
    }
    expect(overlapCount / flowsTotal).toBeLessThan(0.08);
    expect(cutCount / flowsTotal).toBeLessThan(0.04);
  });
});

describe("стрелки на реальных диаграммах: эталоны B002, C025 и демонстрационный процесс", () => {
  it("ни общих портов, ни наложений линий, ни проходов сквозь фигуры — на каждой диаграмме операции", async () => {
    let edges = 0;
    for (const [name, m] of [["b002", b002Model()], ["c025", c025Model()], ["demo", demoModel()]] as const) {
      for (const h of bpmnHosts(m)) {
        const { diagram } = await generateBpmn(m, h.id);
        const routes = new Map(diagram.edges.map((e) => [e.id, e.points as Pt[]] as const));
        const flows = diagram.edges.map((e) => ({ id: e.id, from: e.from, to: e.to }));
        const nodes = diagram.shapes.map((s) => ({ id: s.id, type: s.kind, box: { x: s.x, y: s.y, w: s.w, h: s.h } }));
        edges += flows.length;
        expect(sharedPorts(routes, flows), `${name} ${h.id}`).toEqual([]);
        expect(overlaps(routes), `${name} ${h.id}`).toEqual([]);
        expect(cuts(routes, flows, nodes), `${name} ${h.id}`).toEqual([]);
      }
    }
    expect(edges).toBeGreaterThan(300);
  }, 120_000);

  it("потоки сообщений демо: у каждого свой порт, линии разведены", async () => {
    const m = demoModel();
    for (const op of ["o21", "o22", "o31", "o32"]) {
      const { diagram } = await generateBpmn(m, op);
      const routes = new Map(diagram.messages.map((e) => [e.id, e.points as Pt[]] as const));
      expect(overlaps(routes), op).toEqual([]);
      const all = new Map([...routes, ...diagram.edges.map((e) => [e.id, e.points as Pt[]] as const)]);
      expect(overlaps(all), op).toEqual([]);
    }
  }, 60_000);
});
