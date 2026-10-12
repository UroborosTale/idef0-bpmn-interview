import { describe, expect, it } from "vitest";
import { labelSpec as sharedLabelSpec } from "@shared/idef0Layout";
import { purchaseModel } from "../../test/fixtures";
import type { ProcessLogicModel } from "../../types";
import { addBend, clampFreeEnd, dragCorner, dragSegment, fractionAlong, hasManualRoute, removeBend, resetArrow, routeOf, setArrowRoute, setFreeEnd, setLabelOffset, slideEnd } from "./arrow-edit";
import { buildIdef0, idef0Extents, labelSpec, type Arrow } from "./geometry";
import { reconnectArrow, removeArrow, setArrowIcom } from "./ops";

type M = ProcessLogicModel;

/** Стрелки A0 в фикстуре: a → b по d1 (связь), b → c по d3 как управление (связь управления), внешние вход d2, выход d4, механизм s1. */
const arrows = (m: M) => buildIdef0(m, null).arrows;
const arrow = (m: M, key: string): Arrow => {
  const a = arrows(m).find((x) => x.key === key);
  if (!a) throw new Error(`нет стрелки ${key}: ${arrows(m).map((x) => x.key).join(", ")}`);
  return a;
};
const orthogonal = (poly: [number, number][]) => poly.slice(1).every((p, i) => Math.abs(p[0] - poly[i][0]) < 0.5 || Math.abs(p[1] - poly[i][1]) < 0.5);
const block = (m: M, id: string) => buildIdef0(m, null).functions.find((f) => f.node.id === id)!.box;

describe("ручной маршрут стрелки IDEF0: хранение у функции", () => {
  it("лежит у функции стрелки по ключу «вид:сущность»; округляется, ограничивается; пустое не хранится", () => {
    const m = purchaseModel();
    const a = arrow(m, "link:b:d1");
    const r = setArrowRoute(m, a, { pos: 0.3333, from_pos: 4, points: [[100.26, 50.9]], label: [10.2, -3.7] });
    expect(r.nodes.find((n) => n.id === "b")!.arrow_routes).toEqual({ "link:d1": { pos: 0.333, from_pos: 1, points: [[100.5, 51]], label: [10, -3.5] } });
    expect(routeOf(r, a)).toBeTruthy();
    expect(hasManualRoute(r, a)).toBe(true);
    // чужие функции не тронуты, а снятие полей до пустого убирает ключ и сам arrow_routes
    expect(r.nodes.find((n) => n.id === "a")).toBe(m.nodes.find((n) => n.id === "a"));
    const cleared = setArrowRoute(r, a, { pos: undefined, from_pos: undefined, points: undefined, label: undefined });
    expect("arrow_routes" in cleared.nodes.find((n) => n.id === "b")!).toBe(false);
    // нечисловые значения отбрасываются
    expect("arrow_routes" in setArrowRoute(m, a, { pos: NaN, points: [[NaN, 1]] as never }).nodes.find((n) => n.id === "b")!).toBe(false);
    expect(resetArrow(r, a).nodes.find((n) => n.id === "b")!.arrow_routes).toBeUndefined();
  });

  it("пустой список точек — осмысленный маршрут, а не отсутствие маршрута", () => {
    const m = purchaseModel();
    const a = arrow(m, "link:b:d1");
    const r = setArrowRoute(m, a, { points: [] });
    expect(routeOf(r, a)).toEqual({ points: [] });
    expect(arrow(r, "link:b:d1").manual).toBe(true);
  });
});

describe("раскладка применяет маршрут", () => {
  it("положение концов у блоков: вход по y, управление и механизм по x, выход по y, источник связи — на своей правой стороне", () => {
    const m = purchaseModel();
    const bB = block(m, "b");
    const link = arrow(slideEnd(m, arrow(m, "link:b:d1"), 0.8), "link:b:d1");
    expect(link.points[link.points.length - 1][1]).toBeCloseTo(bB.y + 0.8 * bB.h, 5); // конец у блока-получателя
    expect(link.manual).toBe(true);
    const bA = block(m, "a");
    const src = arrow(slideEnd(m, arrow(m, "link:b:d1"), 0.2, true), "link:b:d1");
    expect(src.points[0][1]).toBeCloseTo(bA.y + 0.2 * bA.h, 5); // начало у блока-источника
    const bC = block(m, "c");
    const mech = arrow(slideEnd(m, arrow(m, "system:c:s1"), 0.75), "system:c:s1");
    expect(mech.points[1][0]).toBeCloseTo(bC.x + 0.75 * bC.w, 5);
    expect(mech.points[0][0]).toBeCloseTo(bC.x + 0.75 * bC.w, 5); // свободный конец остаётся над концом у блока
    const out = arrow(slideEnd(m, arrow(m, "output:c:d4"), 0.5), "output:c:d4");
    expect(out.points[0][1]).toBeCloseTo(bC.y + 0.5 * bC.h, 5);
    // у блока без маршрута положение прежнее
    expect(arrow(slideEnd(m, arrow(m, "link:b:d1"), 0.8), "controlLink:c:d3").manual).toBeFalsy();
  });

  it("свободный конец внешней стрелки: линия ортогональна, наконечник входит в блок слева; ближе MIN_FREE конец не подводится", () => {
    const m = purchaseModel();
    const a = arrow(m, "input:c:d2");
    const bC = block(m, "c");
    const end = clampFreeEnd(bC, a.kind, [bC.x - 10, bC.y - 90]); // слева от блока ближе допустимого — отодвигается
    expect(end[0]).toBeLessThanOrEqual(bC.x - 48);
    const moved = arrow(setFreeEnd(m, a, end), "input:c:d2");
    expect(moved.manual).toBe(true);
    expect(moved.points[0]).toEqual(end);
    expect(orthogonal(moved.points)).toBe(true);
    const last = moved.points[moved.points.length - 1];
    expect(last[0]).toBeCloseTo(bC.x, 5);
    expect(moved.points[moved.points.length - 2][1]).toBeCloseTo(last[1], 5); // последний отрезок горизонтален: стрелка входит слева
    // выход: конец правее блока
    const out = arrow(m, "output:c:d4");
    const oe = clampFreeEnd(bC, out.kind, [bC.x + bC.w + 5, bC.y + 200]);
    expect(oe[0]).toBeGreaterThanOrEqual(bC.x + bC.w + 48);
    const movedOut = arrow(setFreeEnd(m, out, oe), "output:c:d4");
    expect(movedOut.points[movedOut.points.length - 1]).toEqual(oe);
    expect(orthogonal(movedOut.points)).toBe(true);
  });

  it("подпись сдвигается; размер диаграммы растёт, если стрелку увели далеко", () => {
    const m = purchaseModel();
    const a = arrow(m, "input:c:d2");
    const base = labelSpec(a)!;
    const shifted = arrow(setLabelOffset(m, a, 12, -20), "input:c:d2");
    expect(shifted.labelOffset).toEqual([12, -20]);
    expect(labelSpec(shifted)).toMatchObject({ x: base.x + 12, y: base.y - 20, text: base.text });
    expect(sharedLabelSpec({ points: a.points, side: a.side, label: a.label })).toMatchObject({ x: base.x, y: base.y });
    const bC = block(m, "c");
    const w0 = idef0Extents(buildIdef0(m, null)).w;
    const far = setFreeEnd(m, arrow(m, "output:c:d4"), [bC.x + bC.w + 1200, bC.y + 20]);
    expect(idef0Extents(buildIdef0(far, null)).w).toBeGreaterThanOrEqual(bC.x + bC.w + 1200 + 200);
    expect(idef0Extents(buildIdef0(far, null)).w).toBeGreaterThan(w0);
  });
});

describe("свободная правка ломаной", () => {
  it("сдвиг отрезка запоминает точки, линия остаётся ортогональной, чужие стрелки не тронуты", () => {
    const m = purchaseModel();
    const a = arrow(m, "link:b:d1");
    const i = a.points.slice(0, -1).findIndex((p, k) => Math.abs(p[0] - a.points[k + 1][0]) + Math.abs(p[1] - a.points[k + 1][1]) > 20);
    const moved = dragSegment(m, a, i, 30);
    const after = arrow(moved, "link:b:d1");
    expect(after.manual).toBe(true);
    expect(routeOf(moved, a)!.points!.length).toBeGreaterThan(0);
    expect(orthogonal(after.points)).toBe(true);
    expect(arrow(moved, "controlLink:c:d3").points).toEqual(arrow(m, "controlLink:c:d3").points);
  });

  it("пересчёт от исходной ломаной не накапливает сдвиг: результат зависит только от последней дельты", () => {
    const m = purchaseModel();
    const a = arrow(m, "link:b:d1");
    const i = a.points.slice(0, -1).findIndex((p, k) => Math.abs(p[0] - a.points[k + 1][0]) + Math.abs(p[1] - a.points[k + 1][1]) > 20);
    const once = dragSegment(m, a, i, 40);
    const stepwise = dragSegment(dragSegment(dragSegment(m, a, i, 10), a, i, 25), a, i, 40);
    expect(routeOf(stepwise, a)).toEqual(routeOf(once, a));
  });

  it("ступенька добавляется, излом переносится и убирается; на слишком коротком отрезке ничего не происходит", () => {
    const m = purchaseModel();
    const a = arrow(m, "link:b:d1");
    const jogged = addBend(m, a);
    expect(jogged).not.toBe(m);
    const a1 = arrow(jogged, "link:b:d1");
    expect(a1.points.length).toBeGreaterThan(a.points.length);
    expect(orthogonal(a1.points)).toBe(true);
    const moved = dragCorner(jogged, a1, 1, [a1.points[1][0] + 25, a1.points[1][1] + 25]);
    expect(orthogonal(arrow(moved, "link:b:d1").points)).toBe(true);
    const back = removeBend(jogged, a1, 1);
    expect(arrow(back, "link:b:d1").points.length).toBeLessThanOrEqual(a1.points.length);
    // внешний механизм короткий — ступеньку не поставить
    const mech = arrow(m, "system:c:s1");
    expect(addBend(m, mech)).toBe(m);
  });

  it("положение конца вдоль стороны считается по ближайшей точке стороны, не выходит за 10…90%", () => {
    const m = purchaseModel();
    const a = arrow(m, "link:b:d1");
    const bB = block(m, "b");
    expect(fractionAlong(bB, a, [bB.x, bB.y + bB.h / 2])).toBe(0.5);
    expect(fractionAlong(bB, a, [bB.x, bB.y - 500])).toBe(0.1);
    expect(fractionAlong(bB, a, [bB.x, bB.y + 9999])).toBe(0.9);
    const bA = block(m, "a");
    expect(fractionAlong(bA, a, [bA.x + bA.w, bA.y + 0.25 * bA.h], true)).toBe(0.25);
  });
});

describe("перенос конца на другую функцию меняет связь в модели", () => {
  const sees = (m: M, id: string, slot: "inputs" | "outputs" | "controls" | "control_data_ids" | "system_ids") => m.nodes.find((n) => n.id === id)![slot] ?? [];

  it("получатель связи: документ переходит со входа функции b на вход c; маршрут старой стрелки уходит", () => {
    const m = setLabelOffset(purchaseModel(), arrow(purchaseModel(), "link:b:d1"), 5, 5);
    const r = reconnectArrow(m, arrow(m, "link:b:d1"), "block", "c", "input");
    expect(r.error).toBeUndefined();
    expect(sees(r.model, "b", "inputs")).not.toContain("d1");
    expect(sees(r.model, "c", "inputs")).toContain("d1");
    expect(r.nodeId).toBe("c");
    expect(arrow(r.model, "link:c:d1").fromId).toBe("a"); // источник тот же — связь a → c
    expect(r.model.nodes.find((n) => n.id === "b")!.arrow_routes).toBeUndefined();
  });

  it("зона «управление»: документ становится управлением получателя; вход ⇄ управление у той же функции", () => {
    const m = purchaseModel();
    const r = reconnectArrow(m, arrow(m, "link:b:d1"), "block", "c", "control");
    expect(sees(r.model, "c", "control_data_ids")).toContain("d1");
    expect(sees(r.model, "c", "inputs")).not.toContain("d1");
    // тот же документ, но у той же функции переключается тип стрелки
    const sw = setArrowIcom(m, arrow(m, "link:b:d1"), "control");
    expect(sees(sw.model, "b", "control_data_ids")).toContain("d1");
    expect(sees(sw.model, "b", "inputs")).not.toContain("d1");
    expect(arrow(sw.model, "controlLink:b:d1").fromId).toBe("a");
    expect(setArrowIcom(m, arrow(m, "link:b:d1"), "input").error).toMatch(/уже здесь/);
  });

  it("источник связи: выход переходит к другой функции; сам себе функция источником быть не может", () => {
    const m = purchaseModel();
    const r = reconnectArrow(m, arrow(m, "link:b:d1"), "producer", "c", "input");
    expect(sees(r.model, "a", "outputs")).not.toContain("d1");
    expect(sees(r.model, "c", "outputs")).toContain("d1");
    expect(arrow(r.model, "link:b:d1").fromId).toBe("c");
    expect(reconnectArrow(m, arrow(m, "link:b:d1"), "producer", "b", "input").error).toMatch(/собственный выход|сама собой/);
    expect(reconnectArrow(m, arrow(m, "link:b:d1"), "producer", "a", "input").error).toMatch(/уже у этой функции/);
  });

  it("внешние стрелки: вход, выход, регламент, система; роль не переносится", () => {
    const m = purchaseModel();
    const input = reconnectArrow(m, arrow(m, "input:c:d2"), "block", "a", "input");
    expect(sees(input.model, "a", "inputs")).toContain("d2");
    expect(sees(input.model, "c", "inputs")).not.toContain("d2");
    const out = reconnectArrow(m, arrow(m, "output:c:d4"), "block", "a", "input");
    expect(sees(out.model, "a", "outputs")).toContain("d4");
    expect(sees(out.model, "c", "outputs")).not.toContain("d4");
    const ctl = reconnectArrow(m, arrow(m, "control:a:c1"), "block", "c", "input"); // регламент всегда управление, зона не важна
    expect(sees(ctl.model, "c", "controls")).toContain("c1");
    expect(sees(ctl.model, "a", "controls")).not.toContain("c1");
    const sys = reconnectArrow(m, arrow(m, "system:c:s1"), "block", "a", "control");
    expect(sees(sys.model, "a", "system_ids")).toContain("s1");
    expect(sees(sys.model, "c", "system_ids")).not.toContain("s1");
    expect(reconnectArrow(m, arrow(m, "role:c:r2"), "block", "a", "input").error).toMatch(/панели свойств/);
  });

  it("ошибки: функция уже получает этот документ, собственный выход, нет такой функции", () => {
    const m = purchaseModel();
    expect(reconnectArrow(m, arrow(m, "input:c:d2"), "block", "c", "input").error).toMatch(/уже здесь/);
    expect(reconnectArrow(m, arrow(m, "link:b:d1"), "block", "a", "input").error).toMatch(/собственный выход/);
    expect(reconnectArrow(m, arrow(m, "link:b:d1"), "block", "нет-такой", "input").error).toMatch(/Выберите функцию/);
    const dup = reconnectArrow({ ...m, nodes: m.nodes.map((n) => (n.id === "c" ? { ...n, inputs: [...n.inputs, "d1"] } : n)) }, arrow(m, "link:b:d1"), "block", "c", "input");
    expect(dup.error).toMatch(/уже получает/);
  });

  it("удаление стрелки убирает и её маршрут", () => {
    const m = purchaseModel();
    const a = arrow(m, "input:c:d2");
    const routed = setFreeEnd(m, a, [20, 20]);
    const removed = removeArrow(routed, a);
    expect(removed.nodes.find((n) => n.id === "c")!.inputs).not.toContain("d2");
    expect(removed.nodes.find((n) => n.id === "c")!.arrow_routes).toBeUndefined();
  });
});
