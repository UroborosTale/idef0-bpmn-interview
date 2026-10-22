import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { node, purchaseModel } from "../../test/fixtures";
import type { ProcessLogicModel } from "../../types";
import { autoLayout, boxOf, snapTop, withLayout } from "./geometry";
import { addNodeAt, dropNodeIntoLane, moveNode, setNodeType } from "./model-ops";
import { FlowShape } from "./shapes";

type M = ProcessLogicModel;

/** Путь стрелки как список точек из атрибута d. */
const route = (el: Element) =>
  el
    .querySelector("path[marker-end]")!
    .getAttribute("d")!
    .split(/[ML]/)
    .filter(Boolean)
    .map((p) => p.trim().split(" ").map(Number));

describe("стрелки в редакторе", () => {
  it("ветка шлюза вниз уходит из нижней вершины и входит в задачу слева; условие подписано за поворотом", () => {
    const gateway = { x: 200, y: 125, w: 50, h: 50 };
    const task = { x: 400, y: 260, w: 100, h: 80 };
    const { container } = render(
      <svg>
        <FlowShape flow={{ id: "f", from: "g", to: "t", condition: "Нет", source: [], confirmed_by: [] }} from={gateway} to={task} obstacles={[]} selected={false} kinds={{ fromType: "gateway", toType: "task" }} />
      </svg>,
    );
    expect(route(container)).toEqual([[225, 175], [225, 300], [400, 300]]);
    const label = container.querySelector("text")!;
    expect(label.textContent).toBe("Нет");
    expect(Number(label.getAttribute("x"))).toBeCloseTo(259, 0); // над горизонтальным отрезком за поворотом
    expect(Number(label.getAttribute("y"))).toBe(294);
    expect(label.getAttribute("text-anchor")).toBe("middle");
  });

  it("стрелка к шлюзу сверху входит в верхнюю вершину", () => {
    const { container } = render(
      <svg>
        <FlowShape flow={{ id: "f", from: "t", to: "g", source: [], confirmed_by: [] }} from={{ x: 0, y: 10, w: 100, h: 80 }} to={{ x: 300, y: 140, w: 50, h: 50 }} obstacles={[]} selected={false} kinds={{ fromType: "task", toType: "gateway" }} />
      </svg>,
    );
    expect(route(container).at(-1)).toEqual([325, 140]);
  });
});

describe("центры фигур в одном ряду лежат на одной линии", () => {
  const cy = (m: M, id: string) => {
    const b = boxOf(m.nodes.find((n) => n.id === id)!);
    return b.y + b.h / 2;
  };

  it("авто-раскладка: событие, задача и шлюз одной дорожки — на общей линии центров", () => {
    const base = purchaseModel();
    const m: M = {
      ...base,
      nodes: [
        node("e", "Начало", { type: "event", subtype: "start", role_id: "r1" }),
        node("t", "Задача", { role_id: "r1" }),
        node("g", "Развилка", { type: "gateway", subtype: "exclusive", role_id: "r1" }),
      ],
      flows: [
        { id: "f1", from: "e", to: "t", source: [], confirmed_by: [] },
        { id: "f2", from: "t", to: "g", source: [], confirmed_by: [] },
      ],
    };
    const laid = withLayout(m, true);
    expect(cy(laid, "e")).toBe(cy(laid, "t"));
    expect(cy(laid, "g")).toBe(cy(laid, "t"));
    expect([...autoLayout(m).values()].length).toBe(3);
  });

  it("перетаскивание и смена типа сохраняют общую линию центров", () => {
    const base = purchaseModel();
    let m: M = withLayout({ ...base, nodes: [node("t", "Задача", { role_id: "r1" }), node("g", "Развилка", { type: "gateway", subtype: "exclusive", role_id: "r1" })], flows: [] }, true);
    const target = cy(m, "t");
    // шлюз тянут рядом с задачей, промахнувшись на 2 px: привязка по центру возвращает его на общую линию
    const gb = boxOf(m.nodes.find((n) => n.id === "g")!);
    m = dropNodeIntoLane(moveNode(m, "g", gb.x + 200, snapTop(target - 30 + 2, 60)), "g");
    expect(cy(m, "g")).toBe(target);
    // задача становится событием — центр остаётся на месте
    m = setNodeType(m, "t", "event");
    expect(cy(m, "t")).toBe(target);
  });

  it("новая фигура из палитры ложится центром на сетку 5 px", () => {
    const m = withLayout({ ...purchaseModel(), nodes: [], flows: [] }, true);
    const r = addNodeAt(m, { type: "event", subtype: "start", name: "Начало" }, 300, 138);
    expect(cy(r.model, r.id!) % 5).toBe(0);
  });
});
