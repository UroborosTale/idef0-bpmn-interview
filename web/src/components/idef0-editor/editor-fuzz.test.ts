import { describe, expect, it } from "vitest";
import { frameGeometry, frameKey, withFrameHeight } from "@shared/idef0Frame";
import { ProcessLogicModel as ModelSchema } from "../../../../server/src/types/model";
import { purchaseModel, structuredModel } from "../../test/fixtures";
import type { ProcessLogicModel } from "../../types";
import { duplicateNode, deleteNode, updateNode } from "../bpmn-editor/model-ops";
import { removeEntry } from "../studio/dict-ops";
import { addBend, clampFreeEnd, dragCorner, dragSegment, removeBend, resetArrow, setFreeEnd, setLabelOffset, slideEnd } from "./arrow-edit";
import { buildIdef0, idef0Extents, type Arrow } from "./geometry";
import { addFunction, linkFunctions, moveFunction, reconnectArrow, removeArrow, setArrowIcom, setFrame, setFunctionRole } from "./ops";
import { alignLeft, alignTop, copyFragment, deleteGroup, distributeHorizontally, distributeVertically, moveGroup, pasteFragment } from "./selection-ops";

type M = ProcessLogicModel;

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

const fns = (m: M) => m.nodes.filter((n) => (n.type === "task" || n.type === "subprocess") && !n.bpmn_scope);
/** Диаграммы IDEF0: верхняя и каждая функция с вложенными. */
const diagrams = (m: M): (string | null)[] => [null, ...fns(m).filter((f) => m.nodes.some((c) => c.idef0_parent === f.id)).map((f) => f.id)];
const finite = (...xs: number[]) => xs.every(Number.isFinite);

function problems(m: M): string[] {
  const out: string[] = [];
  const parsed = ModelSchema.safeParse(m);
  if (!parsed.success) out.push(`схема: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  const ids = new Set(m.nodes.map((n) => n.id));
  if (ids.size !== m.nodes.length) out.push("повтор id узла");
  const names = new Map<string, number>();
  for (const n of m.nodes) {
    if (n.idef0_parent && !ids.has(n.idef0_parent)) out.push(`функция ${n.id}: родитель ${n.idef0_parent} не существует`);
    for (const list of [n.inputs, n.outputs, n.control_data_ids ?? []]) for (const d of list) if (!m.data.some((x) => x.id === d)) out.push(`функция ${n.id}: ссылка на удалённый документ ${d}`);
    for (const c of n.controls) if (!m.controls.some((x) => x.id === c)) out.push(`функция ${n.id}: ссылка на удалённый регламент ${c}`);
    for (const s of n.system_ids) if (!m.systems.some((x) => x.id === s)) out.push(`функция ${n.id}: ссылка на удалённую систему ${s}`);
    if (fns(m).includes(n)) names.set(`${n.idef0_parent ?? ""}|${n.name}`, (names.get(`${n.idef0_parent ?? ""}|${n.name}`) ?? 0) + 1);
  }
  // родительские связи без циклов
  for (const n of m.nodes) {
    const seen = new Set<string>();
    for (let p: string | null | undefined = n.idef0_parent; p; p = m.nodes.find((x) => x.id === p)?.idef0_parent) {
      if (seen.has(p)) {
        out.push(`цикл родителей у ${n.id}`);
        break;
      }
      seen.add(p);
    }
  }
  for (const d of diagrams(m)) {
    try {
      const lay = buildIdef0(m, d);
      for (const f of lay.functions) if (!finite(f.box.x, f.box.y, f.box.w, f.box.h)) out.push(`диаграмма ${d ?? "A0"}: блок ${f.node.id} с NaN`);
      for (const a of lay.arrows) {
        if (a.points.some((p) => !finite(p[0], p[1]))) out.push(`диаграмма ${d ?? "A0"}: стрелка ${a.key} с NaN`);
        const orth = a.points.slice(1).every((p, i) => Math.abs(p[0] - a.points[i][0]) < 0.5 || Math.abs(p[1] - a.points[i][1]) < 0.5);
        if (!orth) out.push(`диаграмма ${d ?? "A0"}: стрелка ${a.key} не ортогональна`);
      }
      const ext = idef0Extents(lay);
      const frame = m.idef0_frames?.[frameKey(d)];
      const geo = frameGeometry(ext, frame, { node: "A0", title: "T", no: "1" });
      if (!finite(geo.sheet.x, geo.sheet.y, geo.sheet.w, geo.sheet.h)) out.push(`лист ${d ?? "A0"} с NaN`);
      if (geo.gridXs.length > 400 || geo.gridYs.length > 400) out.push(`лист ${d ?? "A0"}: линий сетки больше 400`);
      if (geo.cells.some((c) => !(c.w > 0))) out.push(`лист ${d ?? "A0"}: ячейка штампа нулевой или отрицательной ширины`);
      const world = withFrameHeight(ext, frame);
      if (!finite(world.w, world.h)) out.push(`«мир» ${d ?? "A0"} с NaN`);
    } catch (e) {
      out.push(`диаграмма ${d ?? "A0"}: раскладка упала — ${(e as Error).message}`);
    }
  }
  return out;
}

function step(m: M, r: () => number, log: string[]): M {
  const pick = <T,>(xs: T[]): T | undefined => (xs.length ? xs[Math.floor(r() * xs.length)] : undefined);
  const d = pick(diagrams(m)) ?? null;
  const lay = buildIdef0(m, d);
  const onDiagram = lay.functions.map((f) => f.node.id);
  const fn = pick(onDiagram);
  const arrow: Arrow | undefined = pick(lay.arrows);
  const xy = (): [number, number] => [Math.round((r() - 0.1) * 1600), Math.round((r() - 0.1) * 1000)];
  const ops: [string, () => M | undefined][] = [
    ["addFunction", () => addFunction(m, d, ...xy()).model],
    ["moveFunction", () => (fn ? moveFunction(m, fn, ...xy()) : undefined)],
    ["deleteNode", () => (fn ? deleteNode(m, fn) : undefined)],
    ["duplicate", () => (fn ? duplicateNode(m, fn).model : undefined)],
    ["rename", () => (fn ? updateNode(m, fn, { name: pick(["Дубль", "x".repeat(400), "<b>&", "Функция 1"])! }) : undefined)],
    ["setRole", () => (fn ? setFunctionRole(m, fn, pick([null, ...m.roles.map((x) => x.id)]) ?? null) : undefined)],
    ["link", () => { const a = pick(onDiagram), b = pick(onDiagram); return a && b ? linkFunctions(m, a, b, r() < 0.5 ? "input" : "control").model : undefined; }],
    ["reconnect", () => (arrow && fn ? reconnectArrow(m, arrow, arrow.fromId && r() < 0.3 ? "producer" : "block", fn, r() < 0.5 ? "input" : "control").model : undefined)],
    ["removeArrow", () => (arrow ? removeArrow(m, arrow) : undefined)],
    ["icom", () => (arrow ? setArrowIcom(m, arrow, r() < 0.5 ? "input" : "control").model : undefined)],
    ["freeEnd", () => {
      if (!arrow) return undefined;
      const box = lay.functions.find((f) => f.node.id === arrow.nodeId)?.box;
      return box ? setFreeEnd(m, arrow, clampFreeEnd(box, arrow.kind, xy(), { x: r() < 0.5, y: r() < 0.5 })) : undefined;
    }],
    ["slideEnd", () => (arrow ? slideEnd(m, arrow, r(), r() < 0.3) : undefined)],
    ["bend", () => (arrow ? addBend(m, arrow, r() < 0.5 ? xy() : undefined) : undefined)],
    ["corner", () => (arrow && arrow.points.length > 2 ? dragCorner(m, arrow, 1 + Math.floor(r() * (arrow.points.length - 2)), xy()) : undefined)],
    ["segment", () => (arrow ? dragSegment(m, arrow, Math.floor(r() * (arrow.points.length - 1)), Math.round((r() - 0.5) * 300)) : undefined)],
    ["unbend", () => (arrow && arrow.points.length > 2 ? removeBend(m, arrow, 1 + Math.floor(r() * (arrow.points.length - 2))) : undefined)],
    ["label", () => (arrow ? setLabelOffset(m, arrow, Math.round((r() - 0.5) * 200), Math.round((r() - 0.5) * 200)) : undefined)],
    ["resetArrow", () => (arrow ? resetArrow(m, arrow) : undefined)],
    ["group", () => {
      const sel = onDiagram.filter(() => r() < 0.5);
      if (sel.length < 2) return undefined;
      const w = r();
      if (w < 0.2) return moveGroup(m, d, sel, Math.round((r() - 0.5) * 400), Math.round((r() - 0.5) * 400));
      if (w < 0.3) return alignLeft(m, d, sel);
      if (w < 0.4) return alignTop(m, d, sel);
      if (w < 0.5) return distributeHorizontally(m, d, sel);
      if (w < 0.6) return distributeVertically(m, d, sel);
      if (w < 0.85) { const frag = copyFragment(m, d, sel); const target = pick(diagrams(m)) ?? null; return frag ? pasteFragment(m, target, frag, 40, 40).model : undefined; }
      return deleteGroup(m, sel);
    }],
    ["frame", () => {
      const w = r();
      const key = frameKey(d);
      if (w < 0.25) return setFrame(m, key, { show: r() < 0.5 });
      if (w < 0.4) return setFrame(m, key, { grid: r() < 0.5 });
      if (w < 0.7) return setFrame(m, key, { rect: r() < 0.2 ? null : { x: Math.round((r() - 0.5) * 2000), y: Math.round((r() - 0.5) * 2000), w: 200 + Math.round(r() * 4000), h: 200 + Math.round(r() * 3000) } });
      return setFrame(m, key, { text: { field: pick(["nodeLabel", "node", "titleLabel", "title", "noLabel", "no"] as const)!, value: pick(["", "  ", "Лист <1>", "x".repeat(400)])! } });
    }],
    ["removeData", () => { const x = pick(m.data); return x ? removeEntry(m, "data", x.id) : undefined; }],
    ["removeControl", () => { const x = pick(m.controls); return x ? removeEntry(m, "controls", x.id) : undefined; }],
    ["removeSystem", () => { const x = pick(m.systems); return x ? removeEntry(m, "systems", x.id) : undefined; }],
    ["removeRole", () => { const x = pick(m.roles); return x ? removeEntry(m, "roles", x.id) : undefined; }],
  ];
  const [name, op] = pick(ops)!;
  log.push(`${name} @${d ?? "A0"}`);
  return op() ?? m;
}

describe("фаззинг правок редактора IDEF0: модель целая, все диаграммы и листы раскладываются", () => {
  const starts: [string, () => M][] = [["закупка", purchaseModel], ["структура", structuredModel]];
  for (const [label, make] of starts) {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
      it(`${label}, сид ${seed}: 120 случайных правок`, () => {
        const r = rng(seed * 7919 + label.length);
        let m = make();
        expect(problems(m)).toEqual([]);
        const log: string[] = [];
        for (let i = 0; i < 120; i++) {
          try {
            m = step(m, r, log);
          } catch (e) {
            throw new Error(`операция упала: ${(e as Error).message}\nжурнал: ${log.slice(-8).join(" → ")}`);
          }
          const p = problems(m);
          if (p.length) throw new Error(`после ${log.length} правок: ${p.slice(0, 4).join(" | ")}\nжурнал: ${log.slice(-8).join(" → ")}`);
        }
      });
    }
  }
});
