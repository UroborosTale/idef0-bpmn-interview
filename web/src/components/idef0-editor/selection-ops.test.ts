import { describe, expect, it } from "vitest";
import type { ProcessLogicModel } from "../../types";
import { structuredModel } from "../../test/fixtures";
import { alignLeft, alignTop, blockBoxes, blocksInRect, boundsOf, copyFragment, deleteGroup, distributeHorizontally, distributeVertically, moveGroup, pasteFragment, selectableIds } from "./selection-ops";
import { MIN_POS, withIdef0Layout } from "./geometry";

type M = ProcessLogicModel;

/** Модель с тремя функциями на одной диаграмме в известных местах (x, y — левый верхний угол блока). */
function model(): M {
  const base = withIdef0Layout(structuredModel());
  const at = (id: string, x: number, y: number) => ({ id, idef0_layout: { x, y } });
  const places = [at("s1", 200, 150), at("s2", 520, 330), at("o1", 400, 200), at("o2", 400, 400), at("o3", 700, 200)];
  return { ...base, nodes: base.nodes.map((n) => ({ ...n, ...(places.find((p) => p.id === n.id) ?? {}) })) };
}
const pos = (m: M, id: string) => m.nodes.find((n) => n.id === id)!.idef0_layout!;

describe("блоки IDEF0: выбор и перенос группой", () => {
  it("selectableIds — функции открытой диаграммы; рамка выбирает блоки, которых она касается", () => {
    const m = model();
    expect(selectableIds(m, null).sort()).toEqual(["s1", "s2"]);
    expect(selectableIds(m, "s1").sort()).toEqual(["o1", "o2"]);
    const boxes = blockBoxes(m, "s1");
    const o1 = boxes.get("o1")!;
    expect(blocksInRect(m, "s1", { x: o1.x - 5, y: o1.y - 5, w: 20, h: 20 })).toEqual(["o1"]);
    expect(blocksInRect(m, "s1", { x: 0, y: 0, w: 2000, h: 2000 }).sort()).toEqual(["o1", "o2"]);
    expect(blocksInRect(m, "s1", { x: 0, y: 0, w: 10, h: 10 })).toEqual([]);
  });

  it("boundsOf — общая рамка; moveGroup сдвигает все блоки одинаково и не пускает за поле стрелок", () => {
    const m = model();
    const b = boundsOf(m, "s1", ["o1", "o2"])!;
    expect(b.x).toBe(400);
    expect(b.y).toBe(200);
    const moved = moveGroup(m, "s1", ["o1", "o2"], 60, 30);
    expect(pos(moved, "o1")).toEqual({ x: 460, y: 230 });
    expect(pos(moved, "o2")).toEqual({ x: 460, y: 430 });
    expect(pos(moved, "o3")).toEqual(pos(m, "o3")); // чужие блоки не двигаются
    const clamped = moveGroup(m, "s1", ["o1", "o2"], -9999, -9999);
    expect(Math.min(pos(clamped, "o1").x, pos(clamped, "o2").x)).toBe(MIN_POS);
    expect(Math.min(pos(clamped, "o1").y, pos(clamped, "o2").y)).toBe(MIN_POS);
    expect(pos(clamped, "o2").y - pos(clamped, "o1").y).toBe(200); // взаимное положение сохранилось
  });

  it("выравнивание и равные промежутки", () => {
    const m = model();
    const left = alignLeft(m, "s1", ["o1", "o2"]);
    expect(pos(left, "o1").x).toBe(pos(left, "o2").x);
    expect(pos(left, "o1").y).toBe(200);
    const top = alignTop(m, "s1", ["o1", "o2"]);
    expect(pos(top, "o1").y).toBe(pos(top, "o2").y);
    // три блока на A0 не набирается (их два): равные промежутки требуют трёх
    expect(distributeHorizontally(m, "s1", ["o1", "o2"])).toBe(m);
    expect(distributeVertically(m, "s1", ["o1", "o2"])).toBe(m);
    const three: M = { ...m, nodes: m.nodes.map((n) => (n.id === "o3" ? { ...n, idef0_parent: "s1" } : n)) };
    const spread = distributeHorizontally(three, "s1", ["o1", "o2", "o3"]);
    const xs = ["o1", "o2", "o3"].map((id) => pos(spread, id).x).sort((a, b) => a - b);
    expect(xs[0]).toBe(400);
    expect(xs[2]).toBe(700);
    expect(xs[1] - xs[0] - 160).toBe(xs[2] - xs[1] - 160); // зазоры равны (ширина блока не важна: она у всех одна)
    const vert = distributeVertically(three, "s1", ["o1", "o2", "o3"]);
    const ys = ["o1", "o2", "o3"].map((id) => pos(vert, id).y).sort((a, b) => a - b);
    expect(ys[1] - ys[0]).toBe(ys[2] - ys[1]);
  });

  it("deleteGroup удаляет блоки вместе с вложенными и связанными записями", () => {
    const m = model();
    const gone = deleteGroup(m, ["s1"]);
    expect(gone.nodes.some((n) => n.id === "s1" || n.idef0_parent === "s1")).toBe(false);
    expect(gone.nodes.some((n) => n.id === "s2")).toBe(true);
  });
});

describe("блоки IDEF0: копирование и вставка", () => {
  it("копия — новые id и уникальные названия «(копия)», на выбранной диаграмме, без источников и подтверждений", () => {
    const m = model();
    const frag = copyFragment(m, "s1", ["o1", "o2"])!;
    expect(frag.nodes.map((n) => n.id)).toEqual(["o1", "o2"]);
    const r = pasteFragment(m, "s2", frag, 40, 40);
    expect(r.ids).toHaveLength(2);
    expect(r.model.nodes).toHaveLength(m.nodes.length + 2);
    const pasted = r.model.nodes.filter((n) => r.ids.includes(n.id));
    expect(pasted.every((n) => n.idef0_parent === "s2" && n.bpmn_scope == null && n.source.length === 0 && n.status === "confirmed")).toBe(true);
    expect(pasted.map((n) => n.name)).toEqual(["o1", "o2"].map((id) => `${m.nodes.find((n) => n.id === id)!.name} (копия)`));
    expect(new Set(r.model.nodes.map((n) => n.id)).size).toBe(r.model.nodes.length);
    // взаимное положение сохранено, сдвиг применён
    expect(pos(r.model, r.ids[1]).y - pos(r.model, r.ids[0]).y).toBe(200);
    expect(pos(r.model, r.ids[0])).toEqual({ x: 440, y: 240 });
    // повторная вставка не повторяет названия
    const again = pasteFragment(r.model, "s2", frag, 80, 80);
    const names = again.model.nodes.map((n) => n.name);
    expect(new Set(names).size).toBe(names.length);
    expect(again.model.nodes.filter((n) => again.ids.includes(n.id)).every((n) => /\(копия 2\)$/.test(n.name))).toBe(true);
  });

  it("копировать нечего — null; блоки другой диаграммы не копируются", () => {
    const m = model();
    expect(copyFragment(m, "s1", [])).toBeNull();
    expect(copyFragment(m, "s1", ["s2"])).toBeNull(); // s2 — на A0, а не на диаграмме s1
  });

  it("блоки не уходят левее и выше поля стрелок; зарезервированные id учитываются", () => {
    const m = model();
    const frag = copyFragment(m, "s1", ["o1"])!;
    const r = pasteFragment(m, null, frag, -9999, -9999, ["n99"]);
    expect(pos(r.model, r.ids[0])).toEqual({ x: MIN_POS, y: MIN_POS });
    expect(r.ids[0]).not.toBe("n99");
  });
});