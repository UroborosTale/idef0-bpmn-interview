import { describe, expect, it } from "vitest";
import { arrowRouteKey } from "@shared/idef0Layout";
import type { ProcessLogicModel, ProcessNode } from "../../types";
import { addBend, clampFreeEnd, dragCorner, dragSegment, fractionAlong, removeBend, resetArrow, setFreeEnd, setLabelOffset, slideEnd } from "./arrow-edit";
import { buildIdef0, type Arrow } from "./geometry";
import { moveFunction, reconnectArrow, removeArrow, setArrowIcom } from "./ops";

type M = ProcessLogicModel;

/** Детерминированный генератор (mulberry32): при падении сид и список операций воспроизводят ошибку. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomModel(r: () => number): M {
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const subset = <T,>(xs: T[], p: number) => xs.filter(() => r() < p);
  const data = ["d1", "d2", "d3", "d4", "d5", "d6"].map((id) => ({ id, name: `Документ ${id}`, kind: "document" as const, source: [] }));
  const ids = ["n1", "n2", "n3", "n4", "n5"];
  const nodes: ProcessNode[] = ids.map((id, i) => ({
    id,
    type: "task",
    name: `Функция ${i + 1}`,
    role_id: r() < 0.6 ? pick(["r1", "r2"]) : null,
    system_ids: subset(["s1", "s2"], 0.4),
    inputs: subset(data.map((d) => d.id), 0.35),
    outputs: subset(data.map((d) => d.id), 0.3),
    controls: subset(["c1", "c2"], 0.3),
    control_data_ids: subset(data.map((d) => d.id), 0.15),
    idef0_parent: null,
    idef0_layout: { x: 170 + Math.floor(r() * 5) * 230, y: 170 + Math.floor(r() * 4) * 150 },
    status: "confirmed",
    confidence: 1,
    source: [],
    requirement_ids: [],
    tags: [],
    confirmed_by: [],
  }));
  return {
    schema_version: "2.0.0",
    process: { id: "p", name: "Процесс", type: "AS-IS", decomposition_depth: 2, notations: ["IDEF0"], version: "0.1", status: "draft", kpi: [], risks: [] },
    roles: [{ id: "r1", name: "Роль 1", kind: "internal", source: [] }, { id: "r2", name: "Роль 2", kind: "internal", source: [] }],
    systems: [{ id: "s1", name: "Система 1", source: [] }, { id: "s2", name: "Система 2", source: [] }],
    data,
    controls: [{ id: "c1", name: "Регламент 1", kind: "regulation", source: [] }, { id: "c2", name: "Регламент 2", kind: "rule", source: [] }],
    nodes,
    flows: [],
    gaps: [],
    statements: [],
    interfaces: [],
    requirements_links: [],
    raci: [],
    assignments: [],
    pools: [],
    messages: [],
    accepted_issues: [],
    respondents: [],
    discrepancies: [],
  } as unknown as M;
}

const finite = (p: [number, number]) => Number.isFinite(p[0]) && Number.isFinite(p[1]);
const axisAligned = (poly: [number, number][]) => poly.slice(1).every((p, i) => Math.abs(p[0] - poly[i][0]) < 0.51 || Math.abs(p[1] - poly[i][1]) < 0.51);

/** Инварианты любой модели после любой правки. */
function check(m: M, log: string[]) {
  const layout = buildIdef0(m, null);
  const keys = layout.arrows.map((a) => a.key);
  const ctx = `\n${log.join("\n")}`;
  expect(new Set(keys).size, `ключи стрелок уникальны${ctx}`).toBe(keys.length);
  for (const a of layout.arrows) {
    expect(a.points.length, `в ломаной ${a.key} не меньше двух точек${ctx}`).toBeGreaterThanOrEqual(2);
    expect(a.points.every(finite), `координаты ${a.key} конечны${ctx}`).toBe(true);
    expect(axisAligned(a.points), `${a.key} ортогональна: ${JSON.stringify(a.points)}${ctx}`).toBe(true);
    expect(a.points.every(([x, y]) => Math.abs(x) < 1e6 && Math.abs(y) < 1e6), `${a.key}: координаты в разумных пределах${ctx}`).toBe(true);
  }
  // модель переживает сериализацию (то, что уходит на сервер и в черновик)
  expect(JSON.parse(JSON.stringify(m)), `JSON-круг${ctx}`).toEqual(m);
  // маршруты не должны висеть на несуществующих стрелках после правок, которые их сбрасывают — проверяется отдельно ниже
  return layout;
}

describe("фаззинг правки стрелок IDEF0: случайные последовательности операций не ломают модель и раскладку", () => {
  it("200 последовательностей по 14 правок (при поиске ошибок число поднимают до тысяч)", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const r = rng(seed);
      const pick = <T,>(xs: T[]): T => xs[Math.floor(r() * xs.length)];
      let m = randomModel(r);
      const log: string[] = [`сид ${seed}`];
      for (let step = 0; step < 14; step++) {
        const layout = buildIdef0(m, null);
        if (layout.arrows.length === 0) break;
        const a: Arrow = pick(layout.arrows);
        const box = layout.functions.find((f) => f.node.id === a.nodeId)!.box;
        const op = pick(["seg", "corner", "bend", "unbend", "slide", "slideFrom", "free", "label", "reset", "reconnect", "reconnectFrom", "icom", "remove", "move"]);
        const n = a.points.length;
        const before = m;
        log.push(`${op} ${a.key}`);
        switch (op) {
          case "seg":
            if (n > 2) m = dragSegment(m, a, Math.floor(r() * (n - 1)), Math.round((r() - 0.5) * 300));
            break;
          case "corner":
            if (n > 2) m = dragCorner(m, a, 1 + Math.floor(r() * (n - 2)), [Math.round(r() * 1400), Math.round(r() * 900)]);
            break;
          case "bend":
            m = addBend(m, a, r() < 0.5 ? [Math.round(r() * 1200), Math.round(r() * 800)] : undefined);
            break;
          case "unbend":
            m = removeBend(m, a, Math.floor(r() * (n + 2)) - 1);
            break;
          case "slide":
            m = slideEnd(m, a, fractionAlong(box, a, [Math.round(r() * 1500), Math.round(r() * 900)]));
            break;
          case "slideFrom":
            if (a.fromId) m = slideEnd(m, a, fractionAlong(layout.functions.find((f) => f.node.id === a.fromId)!.box, a, [0, Math.round(r() * 900)], true), true);
            break;
          case "free":
            m = setFreeEnd(m, a, clampFreeEnd(box, a.kind, [Math.round((r() - 0.2) * 1600), Math.round((r() - 0.2) * 1000)]));
            break;
          case "label":
            m = setLabelOffset(m, a, Math.round((r() - 0.5) * 200), Math.round((r() - 0.5) * 100));
            break;
          case "reset":
            m = resetArrow(m, a);
            break;
          case "reconnect": {
            const res = reconnectArrow(m, a, "block", pick(layout.functions).node.id, r() < 0.5 ? "input" : "control");
            if (!res.error) m = res.model;
            break;
          }
          case "reconnectFrom": {
            const res = reconnectArrow(m, a, "producer", pick(layout.functions).node.id, "input");
            if (!res.error) m = res.model;
            break;
          }
          case "icom": {
            const res = setArrowIcom(m, a, r() < 0.5 ? "input" : "control");
            if (!res.error) m = res.model;
            break;
          }
          case "remove":
            m = removeArrow(m, a);
            break;
          case "move": {
            const f = pick(layout.functions);
            m = moveFunction(m, f.node.id, Math.max(100, Math.round(r() * 1200)), Math.max(100, Math.round(r() * 800)));
            break;
          }
        }
        // операции не мутируют предыдущую модель (история отмены держит ссылки)
        expect(before === m || JSON.stringify(before) !== JSON.stringify(m) || op === "reset", `${op} вернул новую модель без изменений\n${log.join("\n")}`).toBe(true);
        check(m, log);
      }
    }
  });

  it("маршруты не остаются у стрелок, которых больше нет (после удаления и переноса концов)", () => {
    for (let seed = 1; seed <= 100; seed++) {
      const r = rng(seed * 7919);
      let m = randomModel(r);
      const log: string[] = [`сид ${seed}`];
      for (let step = 0; step < 10; step++) {
        const layout = buildIdef0(m, null);
        if (layout.arrows.length === 0) break;
        const a = layout.arrows[Math.floor(r() * layout.arrows.length)];
        const box = layout.functions.find((f) => f.node.id === a.nodeId)!.box;
        if (r() < 0.5) m = slideEnd(m, a, fractionAlong(box, a, [0, r() * 900]));
        else m = setLabelOffset(m, a, 10 + Math.round(r() * 50), 5);
        log.push(`маршрут ${a.key}`);
        const victim = layout.arrows[Math.floor(r() * layout.arrows.length)];
        const mode = r();
        const res =
          mode < 0.4 ? { model: removeArrow(m, victim) } : mode < 0.8 ? reconnectArrow(m, victim, "block", layout.functions[Math.floor(r() * layout.functions.length)].node.id, "input") : { model: m };
        log.push(`${mode < 0.4 ? "удаление" : "перенос"} ${victim.key}`);
        if (!("error" in res) || !res.error) m = res.model;
        // у каждой функции маршруты только у стрелок, которые есть на диаграмме (иначе они ожили бы при повторном создании связи)
        const alive = new Set(buildIdef0(m, null).arrows.map((x) => `${x.nodeId}|${arrowRouteKey(x.kind, x.entityId)}`));
        for (const node of m.nodes) {
          for (const k of Object.keys(node.arrow_routes ?? {})) {
            if (!alive.has(`${node.id}|${k}`) && (victim.nodeId === node.id && arrowRouteKey(victim.kind, victim.entityId) === k)) {
              throw new Error(`у функции ${node.id} остался маршрут ${k} убранной стрелки\n${log.join("\n")}`);
            }
          }
        }
      }
    }
  });
});
