import { describe, expect, it } from "vitest";
import { generateBpmn } from "../src/pipeline/bpmn.js";
import { MIN_EVALUATIONS, evaluationsFor, layoutLayered } from "../src/pipeline/layout.js";
import { b002Model } from "../src/reference/b002.js";
import { c025Model } from "../src/reference/c025.js";
import { demoModel } from "../src/reference/demo.js";
import { routeQuality, type RouteNode } from "../src/shared/bpmnRouting.js";
import { bpmnHosts } from "../src/shared/codes.js";
import type { Pt } from "../src/shared/bpmnGeometry.js";
import { rankColumns } from "../src/shared/bpmnRank.js";

/** Пересечения стрелок на диаграмме операции — по готовой прокладке (то же, что видит пользователь). */
async function crossingsOf(m: ReturnType<typeof b002Model>, host: string, pack = true): Promise<number> {
  const prev = process.env.BPMN_PACK;
  process.env.BPMN_PACK = pack ? "1" : "0";
  try {
    const { diagram } = await generateBpmn(m, host);
    const routes = new Map(diagram.edges.map((e) => [e.id, e.points as Pt[]] as const));
    const nodes: RouteNode[] = diagram.shapes.map((s) => ({ id: s.id, type: s.kind, box: { x: s.x, y: s.y, w: s.w, h: s.h } }));
    return routeQuality(nodes, diagram.edges.map((e) => ({ id: e.id, from: e.from, to: e.to })), routes).crossings;
  } finally {
    if (prev === undefined) delete process.env.BPMN_PACK;
    else process.env.BPMN_PACK = prev;
  }
}

/** Ширина диаграммы с упаковкой длинной цепочки и без неё. */
async function widthsOf(m: ReturnType<typeof b002Model>, host: string): Promise<{ packed: number; plain: number }> {
  const prev = process.env.BPMN_PACK;
  const width = async (pack: boolean) => {
    process.env.BPMN_PACK = pack ? "1" : "0";
    try {
      return (await generateBpmn(m, host)).diagram.width;
    } finally {
      if (prev === undefined) delete process.env.BPMN_PACK;
      else process.env.BPMN_PACK = prev;
    }
  };
  const plain = await width(false);
  const packed = await width(true);
  return { packed, plain };
}

// Пересечения до подбора раскладки (замер до введения подбора): подбор может только уменьшать их.
const BEFORE: Record<string, number> = {
  "b002:o11": 1, "b002:o21": 2, "b002:o22": 2, "b002:o33": 7,
  "c025:o11": 1, "c025:o12": 3, "c025:o13": 8, "c025:o21": 1, "c025:o22": 6,
  "demo:o11": 4, "demo:o12": 5, "demo:o22": 4, "demo:o32": 1,
};
/** Сколько пересечений прощает упаковка длинной цепочки: стрелка возврата идёт с конца ряда в начало следующего. */
const PACK_SLACK = 4;

describe("подбор раскладки: меньше пересечений стрелок при тех же дорожках", () => {
  it("на эталонах и демо ни одна диаграмма не хуже прежней, а всего пересечений заметно меньше", async () => {
    let before = 0;
    let after = 0;
    let packedTotal = 0;
    for (const [name, m] of [["b002", b002Model()], ["c025", c025Model()], ["demo", demoModel()]] as const) {
      for (const h of bpmnHosts(m)) {
        // без упаковки длинной цепочки — прежняя гарантия: ни одного лишнего пересечения
        const plain = await crossingsOf(m, h.id, false);
        const was = BEFORE[`${name}:${h.id}`] ?? 0;
        expect(plain, `${name} ${h.id} без упаковки`).toBeLessThanOrEqual(was);
        // с упаковкой добавляется стрелка возврата с конца ряда в начало следующего: ей разрешено несколько пересечений,
        // но диаграмма при этом становится заметно уже (проверяется ниже)
        const packed = await crossingsOf(m, h.id, true);
        expect(packed, `${name} ${h.id} с упаковкой`).toBeLessThanOrEqual(was + PACK_SLACK);
        const { packed: wp, plain: w0 } = await widthsOf(m, h.id);
        expect(wp, `${name} ${h.id}: упаковка не расширяет`).toBeLessThanOrEqual(w0 + 1);
        before += was;
        after += plain;
        packedTotal += packed;
      }
    }
    expect(before).toBe(45);
    expect(after).toBeLessThanOrEqual(12); // замер: 11 (колонки 190 вместо 220; задачи 150×90, как в Business Studio; до перехода было 6)
    expect(packedTotal).toBeLessThanOrEqual(45); // с упаковкой: плюс до PACK_SLACK пересечений на длинных схемах
  }, 180_000);

  it("на всех диаграммах эталонов фигуры не налезают друг на друга и не выходят за левый край дорожек", async () => {
    for (const [name, m] of [["b002", b002Model()], ["c025", c025Model()], ["demo", demoModel()]] as const) {
      for (const h of bpmnHosts(m)) {
        const { diagram } = await generateBpmn(m, h.id);
        const s = diagram.shapes.filter((x) => x.kind !== "pool");
        for (let i = 0; i < s.length; i++) {
          expect(s[i].x, `${name} ${h.id} ${s[i].id}`).toBeGreaterThanOrEqual(110);
          for (let j = i + 1; j < s.length; j++) {
            const [p, q] = [s[i], s[j]];
            const overlap = p.x < q.x + q.w && p.x + p.w > q.x && p.y < q.y + q.h && p.y + p.h > q.y;
            // граничное событие стоит на границе своей задачи — касается её по построению
            if (overlap && p.kind !== "event" && q.kind !== "event") expect(overlap, `${name} ${h.id}: ${p.id} и ${q.id} налезают`).toBe(false);
          }
        }
      }
    }
  }, 120_000);

  it("столбцы (rankColumns): длиннейший путь, одна фигура в ячейке дорожки, петли не мешают", () => {
    // a → b → c в дорожке 0; ветки b → d и b → e в той же дорожке получают разные столбцы; петля c → a отбрасывается
    const r = rankColumns({
      ids: ["a", "b", "c", "d", "e"],
      lane: new Map([["a", 0], ["b", 0], ["c", 0], ["d", 0], ["e", 1]]),
      edges: [["a", "b"], ["b", "c"], ["b", "d"], ["b", "e"], ["c", "a"]].map(([from, to]) => ({ from, to })),
    });
    expect(r.rank.get("a")).toBe(0);
    expect(r.rank.get("b")).toBe(1);
    expect(r.rank.get("c")).toBe(2);
    expect(r.rank.get("d")).toBe(3); // ячейка «столбец 2 × дорожка 0» занята задачей c
    expect(r.rank.get("e")).toBe(2); // другая дорожка — ячейка свободна
    expect(r.fwd.get("c") ?? []).toEqual([]); // петля c → a обратная
    expect(r.preds.get("b")).toEqual(["a"]);
    // неизвестные концы и стрелка на себя игнорируются
    expect(rankColumns({ ids: ["x"], lane: new Map([["x", 0]]), edges: [{ from: "x", to: "x" }, { from: "x", to: "нет" }] }).rank.get("x")).toBe(0);
  });

  it("LAYOUT_SEARCH=0 возвращает раскладку без подбора: ровно 56 пересечений на тех же диаграммах (прокладка с парным пересмотром сторон, обходом подписей и значками данных: документы над задачами, хранилища под ними, подпись справа от значка; отрезки отводятся от линий дорожек)", async () => {
    process.env.LAYOUT_SEARCH = "0";
    try {
      let total = 0;
      for (const [name, m] of [["b002", b002Model()], ["c025", c025Model()], ["demo", demoModel()]] as const) for (const h of bpmnHosts(m)) total += await crossingsOf(m, h.id);
      // было 58; после отвода отрезков от линий дорожек и подписей в свою дорожку две стрелки перестали задевать соседние
      expect(total).toBe(56);
    } finally {
      delete process.env.LAYOUT_SEARCH;
    }
  }, 120_000);

  it("перестановки по дорожке: «Поиск программы» встаёт сразу за шлюзом, а не дугой над соседями (c025, операция 1.3)", async () => {
    // Раньше поиск стоял после «Подтвердить программу», и «Нет»-ветки обоих шлюзов шли дугами над соседними шагами: 3 пересечения.
    const m = c025Model();
    const { diagram } = await generateBpmn(m, "o13");
    const x = (name: string) => diagram.shapes.find((s) => s.name.startsWith(name))!.x;
    expect(x("Поиск программы")).toBeLessThan(x("Договор с учебной организацией"));
    expect(await crossingsOf(m, "o13")).toBeLessThanOrEqual(3);
  }, 60_000);

  it("число проверяемых вариантов зависит только от размера диаграммы: на малых — полный перебор, на больших меньше, на огромных подбора нет", () => {
    expect(evaluationsFor(10)).toBe(200);
    expect(evaluationsFor(26)).toBe(200);
    const sizes = [26, 40, 60, 80, 100, 120, 150, 300].map(evaluationsFor);
    expect([...sizes].sort((a, b) => b - a)).toEqual(sizes); // с ростом диаграммы не растёт
    expect(evaluationsFor(100)).toBeGreaterThanOrEqual(MIN_EVALUATIONS); // типичная крупная диаграмма ещё подбирается
    expect(evaluationsFor(150)).toBeLessThan(MIN_EVALUATIONS); // от ~120 стрелок — как есть
    expect(evaluationsFor(150)).toBe(evaluationsFor(150)); // не зависит от запуска
  });

  it("результат не зависит от запуска: одинаковые координаты и маршруты", async () => {
    const m = c025Model();
    const a = await generateBpmn(m, "o22");
    const b = await generateBpmn(m, "o22");
    expect(b.diagram.shapes.map((s) => [s.id, s.x, s.y])).toEqual(a.diagram.shapes.map((s) => [s.id, s.x, s.y]));
    expect(b.diagram.edges.map((e) => e.points)).toEqual(a.diagram.edges.map((e) => e.points));
  });

  it("позиции, заданные в редакторе, подбор не двигает", async () => {
    const m = c025Model();
    const free = await generateBpmn(m, "o22");
    const pinnedId = free.diagram.shapes.find((s) => s.kind === "task")!.id.replace(/^Node_/, "");
    const pinned = { ...m, nodes: m.nodes.map((n) => (n.id === pinnedId ? { ...n, layout: { x: 777, y: 123 } } : n)) };
    const r = await generateBpmn(pinned, "o22");
    const s = r.diagram.shapes.find((x) => x.id === `Node_${pinnedId}`)!;
    expect([s.x, s.y]).toEqual([777, 123]);
  });

  it("закреплённая в редакторе фигура остаётся на месте, остальные в дорожке её обходят и не налезают", async () => {
    const nodes = ["a", "b", "c", "d", "e"].map((id) => ({ id, width: 100, height: 80, laneIndex: 0, type: "task", fixed: id === "c" ? { x: 330, y: 70 } : null }));
    const edges = [["a", "b"], ["b", "c"], ["c", "d"], ["d", "e"]].map(([from, to], i) => ({ id: `e${i}`, from, to }));
    const r = await layoutLayered(nodes, edges, 1);
    expect(r.boxes.get("c")).toMatchObject({ x: 330, y: 70 });
    const boxes = [...r.boxes.entries()];
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const [[ia, p], [ib, q]] = [boxes[i], boxes[j]];
      expect(p.x < q.x + q.width && p.x + p.width > q.x && p.y < q.y + q.height && p.y + p.height > q.y, `${ia} и ${ib} налезают`).toBe(false);
    }
  });

  it("layoutLayered: ветки шлюза в одной дорожке — порядок выбирается так, чтобы стрелки не пересекались; ничего не теряется", async () => {
    // g → a → m, g → b → m, g → c → m; одна дорожка; возврат m → g не нужен. Любой порядок допустим, но пересечений быть не должно.
    const nodes = ["g", "a", "b", "c", "m", "end"].map((id) => ({ id, width: id === "g" || id === "m" ? 50 : 100, height: id === "g" || id === "m" ? 50 : 80, laneIndex: 0, type: id === "g" || id === "m" ? "gateway" : id === "end" ? "event" : "task" }));
    const edges = [["g", "a"], ["g", "b"], ["g", "c"], ["a", "m"], ["b", "m"], ["c", "m"], ["m", "end"]].map(([from, to], i) => ({ id: `e${i}`, from, to }));
    const r = await layoutLayered(nodes, edges, 1);
    expect([...r.boxes.keys()].sort()).toEqual(["a", "b", "c", "end", "g", "m"]);
    const boxes = [...r.boxes.values()];
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const [p, q] = [boxes[i], boxes[j]];
      expect(p.x < q.x + q.width && p.x + p.width > q.x && p.y < q.y + q.height && p.y + p.height > q.y, `фигуры ${i} и ${j} налезают`).toBe(false);
    }
    const routeNodes: RouteNode[] = nodes.map((n) => ({ id: n.id, type: n.type, box: { x: r.boxes.get(n.id)!.x, y: r.boxes.get(n.id)!.y, w: n.width, h: n.height } }));
    const { routeFlows } = await import("../src/shared/bpmnRouting.js");
    const flows = edges.map((e) => ({ id: e.id, from: e.from, to: e.to }));
    expect(routeQuality(routeNodes, flows, routeFlows(routeNodes, flows)).cuts).toBe(0);
  });
});