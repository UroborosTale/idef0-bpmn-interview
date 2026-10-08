import { describe, expect, it } from "vitest";
import { node, purchaseModel } from "../../test/fixtures";
import type { ProcessLogicModel } from "../../types";
import { MIN_X, boxOf, laneIndexOfRole, laneTop } from "./geometry";
import { alignLeft, alignMiddle, boundsOf, copyFragment, deleteGroup, distributeHorizontally, dropGroup, hasClipboard, moveGroup, nodesInRect, pasteFragment, selectableIds, setClipboard, takeClipboard } from "./selection-ops";

type M = ProcessLogicModel;

/** Диаграмма: начало → «Принять» (с таймером на границе) → шлюз → «Передать»; дорожки r1 и r2. */
function diagram(): M {
  const base = purchaseModel();
  const y1 = laneTop(laneIndexOfRole(base, "r1")) + 20;
  const y2 = laneTop(laneIndexOfRole(base, "r2")) + 20;
  return {
    ...base,
    nodes: [
      node("a", "Заявка получена", { type: "event", subtype: "start", role_id: "r1", layout: { x: 200, y: y1 } }),
      node("b", "Принять заявку", { role_id: "r1", layout: { x: 300, y: y1 }, source: [{ fragment_id: "f1", quote: "q" }] }),
      node("t", "Срок истёк", { type: "event", subtype: "timer", role_id: "r1", attached_to: "b", interrupting: false }),
      node("g", "Всё верно?", { type: "gateway", subtype: "exclusive", role_id: "r1", layout: { x: 500, y: y1 } }),
      node("c", "Передать в бухгалтерию", { role_id: "r2", layout: { x: 640, y: y2 } }),
      node("z", "Другая диаграмма", { idef0_parent: "x" }), // не показывается
    ],
    flows: [
      { id: "f1", from: "a", to: "b", source: [], confirmed_by: [] },
      { id: "f2", from: "b", to: "g", source: [], confirmed_by: [] },
      { id: "f3", from: "g", to: "c", condition: "да", source: [], confirmed_by: [] },
    ],
  };
}
const at = (m: M, id: string) => boxOf(m.nodes.find((n) => n.id === id)!);

describe("выделение", () => {
  it("рамка выделяет фигуры, которых коснулась; граничные события и вложенные функции не выбираются", () => {
    const m = diagram();
    expect(selectableIds(m)).toEqual(["a", "b", "g", "c"]);
    const ba = at(m, "a");
    const bg = at(m, "g");
    expect(nodesInRect(m, { x: ba.x - 5, y: ba.y - 5, w: bg.x + bg.w - ba.x + 10, h: bg.h + 10 })).toEqual(["a", "b", "g"]);
    expect(nodesInRect(m, { x: 0, y: 0, w: 5, h: 5 })).toEqual([]);
  });

  it("общая рамка набора", () => {
    const m = diagram();
    const b = boundsOf(m, ["a", "c"])!;
    expect(b.x).toBe(at(m, "a").x);
    expect(b.x + b.w).toBe(at(m, "c").x + at(m, "c").w);
    expect(boundsOf(m, ["нет"])).toBeNull();
  });
});

describe("перенос и удаление группой", () => {
  it("вся группа сдвигается на одно расстояние по сетке, левее поля дорожек не уходит", () => {
    const m = diagram();
    const moved = moveGroup(m, ["a", "b"], 50, 0);
    expect(at(moved, "a").x - at(m, "a").x).toBe(50);
    expect(at(moved, "b").x - at(m, "b").x).toBe(50);
    expect(at(moved, "g")).toEqual(at(m, "g"));
    const left = moveGroup(m, ["a", "b"], -1000, 0);
    expect(at(left, "a").x).toBe(MIN_X);
    expect(at(left, "b").x - at(left, "a").x).toBe(100); // расстояние между фигурами сохраняется
  });

  it("после переноса вниз фигура получает должность дорожки, в которую попала", () => {
    const m = diagram();
    const dy = laneTop(laneIndexOfRole(m, "r2")) - laneTop(laneIndexOfRole(m, "r1"));
    const moved = dropGroup(moveGroup(m, ["b", "g"], 0, dy), ["b", "g"]);
    expect(moved.nodes.find((n) => n.id === "b")!.role_id).toBe("r2");
    expect(moved.nodes.find((n) => n.id === "g")!.role_id).toBe("r2");
    expect(moved.nodes.find((n) => n.id === "t")!.role_id).toBe("r2"); // граничное событие следует за задачей
  });

  it("удаление группы уносит стрелки, граничные события и ссылки", () => {
    const m = deleteGroup(diagram(), ["b", "g"]);
    expect(m.nodes.map((n) => n.id)).toEqual(["a", "c", "z"]);
    expect(m.flows).toEqual([]);
  });
});

describe("выравнивание", () => {
  it("по левому краю", () => {
    const m = alignLeft(diagram(), ["b", "g", "c"]);
    expect([at(m, "b").x, at(m, "g").x, at(m, "c").x]).toEqual([300, 300, 300]);
    expect(at(m, "c").y).toBe(at(diagram(), "c").y); // по вертикали не двигаются
  });

  it("центры по одной линии — отдельно в каждой дорожке, фигуры дорожки не меняют", () => {
    const base = diagram();
    const lowered = { ...base, nodes: base.nodes.map((n) => (n.id === "g" ? { ...n, layout: { x: at(base, "g").x, y: at(base, "g").y + 30 } } : n)) };
    const m = alignMiddle(lowered, ["b", "g", "c"]);
    const cy = (id: string) => at(m, id).y + at(m, id).h / 2;
    expect(Math.abs(cy("b") - cy("g"))).toBeLessThanOrEqual(5);
    expect(at(m, "c")).toEqual(at(lowered, "c")); // единственная в своей дорожке — не двигается
    expect(m.nodes.find((n) => n.id === "c")!.role_id).toBe("r2");
    expect(alignMiddle(diagram(), ["b"])).toEqual(diagram());
  });

  it("равные промежутки: крайние на месте, нужно не меньше трёх", () => {
    const m = diagram();
    const d = distributeHorizontally(m, ["a", "b", "g", "c"]);
    expect(at(d, "a").x).toBe(at(m, "a").x);
    const gaps = ["a", "b", "g", "c"].slice(0, -1).map((id, i, ids) => at(d, ["a", "b", "g", "c"][i + 1]).x - (at(d, id).x + at(d, id).w));
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThanOrEqual(10);
    expect(distributeHorizontally(m, ["a", "b"])).toBe(m);
  });
});

describe("копирование и вставка", () => {
  it("в буфер попадают фигуры, их граничные события и стрелки между ними; ссылки на интервью не копируются", () => {
    const frag = copyFragment(diagram(), ["a", "b"])!;
    expect(frag.nodes.map((n) => n.id)).toEqual(["b", "t", "a"].sort((x, y) => ["a", "b", "t"].indexOf(x) - ["a", "b", "t"].indexOf(y)));
    expect(frag.flows.map((f) => f.id)).toEqual(["f1"]);
    expect(copyFragment(diagram(), [])).toBeNull();
  });

  it("вставка: новые id, сдвиг, стрелки и привязка граничного события переписаны, исходная диаграмма цела", () => {
    const m = diagram();
    const frag = copyFragment(m, ["a", "b", "g"])!;
    const r = pasteFragment(m, frag, 40, 0);
    expect(r.ids).toHaveLength(3); // граничное событие среди выбираемых не числится
    const added = r.model.nodes.slice(m.nodes.length);
    expect(added).toHaveLength(4);
    expect(new Set(r.model.nodes.map((n) => n.id)).size).toBe(r.model.nodes.length);
    const copyB = added.find((n) => n.name === "Принять заявку")!;
    const copyT = added.find((n) => n.name === "Срок истёк")!;
    expect(copyT.attached_to).toBe(copyB.id);
    expect(copyB.source).toEqual([]);
    expect(boxOf(copyB).x - at(m, "b").x).toBe(40);
    const newFlows = r.model.flows.slice(m.flows.length);
    expect(newFlows).toHaveLength(2); // a→b и b→g; g→c в буфер не попала
    expect(newFlows.every((f) => added.some((n) => n.id === f.from) && added.some((n) => n.id === f.to))).toBe(true);
    expect(new Set(r.model.flows.map((f) => f.id)).size).toBe(r.model.flows.length);
    expect(r.model.nodes.slice(0, m.nodes.length)).toEqual(m.nodes);
  });

  it("id, занятые в других диаграммах, не используются; чужая должность без дорожки сбрасывается", () => {
    const m = diagram();
    const frag = copyFragment(m, ["c"])!;
    const noLane = { ...m, roles: m.roles.filter((r) => r.id !== "r2") };
    const r = pasteFragment(noLane, frag, 0, 40, { nodes: ["n6", "n7", "n8"], flows: [] });
    const copy = r.model.nodes[r.model.nodes.length - 1];
    expect(["n6", "n7", "n8"]).not.toContain(copy.id);
    expect(copy.role_id).toBeNull();
  });

  it("буфер общий: вставки идут со всё большим смещением", () => {
    expect(takeClipboard()).toBeNull();
    setClipboard(copyFragment(diagram(), ["a"]));
    expect(hasClipboard()).toBe(true);
    expect(takeClipboard()!.n).toBe(1);
    expect(takeClipboard()!.n).toBe(2);
    setClipboard(null);
    expect(hasClipboard()).toBe(false);
  });
});
