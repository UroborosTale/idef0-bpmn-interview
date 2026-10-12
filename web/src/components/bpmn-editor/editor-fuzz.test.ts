import { describe, expect, it } from "vitest";
import { mergeScope, scopeView } from "@shared/scope";
import { ProcessLogicModel as ModelSchema } from "../../../../server/src/types/model";
import { structuredModel } from "../../test/fixtures";
import type { ProcessLogicModel } from "../../types";
import { removeEntry } from "../studio/dict-ops";
import { addBend, dragCorner, dragSegment, removeBend } from "./flow-edit";
import { diagramLayout, withLayout } from "./geometry";
import {
  EVENT_PALETTE,
  PALETTE,
  addBoundaryEvent,
  addFlow,
  addMessage,
  addNodeAt,
  addPool,
  addRole,
  attachTrigger,
  deleteFlow,
  deleteMessage,
  deleteNode,
  deletePool,
  deleteRole,
  deleteTriggerEvent,
  dropNodeIntoLane,
  duplicateNode,
  moveNode,
  reconnectFlow,
  setArtifactOffset,
  setDiagramWidth,
  setFlowRoute,
  setLaneHeight,
  setNodeRole,
  setNodeType,
  setPoolOffset,
  updateNode,
} from "./model-ops";
import { alignLeft, alignMiddle, copyFragment, deleteGroup, distributeHorizontally, moveGroup, pasteFragment } from "./selection-ops";

type M = ProcessLogicModel;

/** Детерминированный генератор (mulberry32): сид и журнал операций воспроизводят находку. */
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

/** Модель с операцией o1 (своя диаграмма BPMN), документами у задач, внешним пулом и потоком сообщений. */
function startModel(): M {
  const m = withLayout(structuredModel());
  const b1 = m.nodes.find((n) => n.id === "b1")!;
  b1.inputs = ["d1"];
  b1.outputs = ["d2"];
  m.pools = [{ id: "pool1", name: "Поставщики", scope: "o1" }];
  m.messages = [{ id: "msg1", from: "b2", to: "pool1", name: "Запрос" }];
  return m;
}

/** Нарушения целостности модели; пустой список — всё в порядке. */
function problems(m: M): string[] {
  const out: string[] = [];
  const parsed = ModelSchema.safeParse(m);
  if (!parsed.success) out.push(`схема: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  const dup = (label: string, ids: string[]) => {
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) out.push(`повтор id ${label}: ${id}`);
      seen.add(id);
    }
  };
  dup("узла", m.nodes.map((n) => n.id));
  dup("потока", m.flows.map((f) => f.id));
  dup("потока сообщений", (m.messages ?? []).map((x) => x.id));
  dup("пула", (m.pools ?? []).map((p) => p.id));
  dup("роли", m.roles.map((r) => r.id));
  const nodes = new Set(m.nodes.map((n) => n.id));
  const pools = new Set((m.pools ?? []).map((p) => p.id));
  for (const f of m.flows) if (!nodes.has(f.from) || !nodes.has(f.to)) out.push(`поток ${f.id} ведёт к несуществующему узлу`);
  for (const x of m.messages ?? []) {
    const ok = (nodes.has(x.from) && pools.has(x.to)) || (pools.has(x.from) && nodes.has(x.to));
    if (!ok) out.push(`поток сообщений ${x.id} без пары «шаг — пул»`);
  }
  for (const n of m.nodes) {
    if (n.role_id && !m.roles.some((r) => r.id === n.role_id)) out.push(`узел ${n.id}: исполнитель ${n.role_id} не существует`);
    if (n.bpmn_scope && !nodes.has(n.bpmn_scope)) out.push(`узел ${n.id}: операция ${n.bpmn_scope} не существует`);
    for (const k of Object.keys(n.artifact_offsets ?? {})) {
      const [kind, entity] = [k.split(":")[0], k.split(":").slice(1).join(":")];
      const exists = kind === "store" ? m.systems.some((x) => x.id === entity) : m.data.some((x) => x.id === entity);
      if (!exists) out.push(`узел ${n.id}: смещение значка ${k} удалённой записи (применится к новой записи с тем же id)`);
    }
  }
  for (const n of m.nodes) {
    for (const k of Object.keys(n.arrow_routes ?? {})) {
      const entity = k.split(":").slice(1).join(":");
      const exists = [m.data, m.systems, m.controls, m.roles].some((list) => list.some((x) => x.id === entity));
      if (!exists) out.push(`узел ${n.id}: маршрут стрелки IDEF0 ${k} удалённой записи`);
    }
  }
  for (const a of m.assignments ?? []) if (a.node_id && !nodes.has(a.node_id)) out.push(`назначение на удалённый узел ${a.node_id}`);
  // раскладка каждой диаграммы считается и даёт конечные координаты
  for (const scope of [null, ...m.nodes.filter((n) => m.nodes.some((c) => c.bpmn_scope === n.id)).map((n) => n.id)]) {
    try {
      const view = scopeView(m, scope);
      const lay = diagramLayout(view);
      for (const [id, pts] of lay.routes) if (pts.some((p) => !Number.isFinite(p[0]) || !Number.isFinite(p[1]))) out.push(`диаграмма ${scope ?? "общая"}: маршрут ${id} с NaN`);
      for (const [id, b] of lay.boxes) if (![b.x, b.y, b.w, b.h].every(Number.isFinite)) out.push(`диаграмма ${scope ?? "общая"}: фигура ${id} с NaN`);
      for (const a of lay.extras.artifacts) if (![a.box.x, a.box.y].every(Number.isFinite)) out.push(`значок ${a.key} с NaN`);
      for (const p of lay.extras.pools) if (![p.box.x, p.box.y].every(Number.isFinite)) out.push(`пул ${p.pool.id} с NaN`);
    } catch (e) {
      out.push(`диаграмма ${scope ?? "общая"}: раскладка упала — ${(e as Error).message}`);
    }
  }
  return out;
}

const SCOPES: (string | null)[] = [null, "o1"];

/** Одна случайная правка, как её делает редактор: над видом диаграммы, со слиянием обратно в полную модель. */
function step(full: M, r: () => number, log: string[]): M {
  const pick = <T,>(xs: T[]): T | undefined => (xs.length ? xs[Math.floor(r() * xs.length)] : undefined);
  // диаграмма операции открыта, только пока операция существует (иначе вкладки нет)
  const scope = pick(SCOPES.filter((sc) => sc === null || full.nodes.some((n) => n.id === sc)))!;
  const view = scopeView(full, scope);
  const ids = view.nodes.map((n) => n.id);
  const tasks = view.nodes.filter((n) => n.type === "task" || n.type === "subprocess").map((n) => n.id);
  const nodeId = pick(ids);
  const xy = () => [100 + Math.round(r() * 1400), 40 + Math.round(r() * 700)] as const;
  const viewOps: [string, () => M | undefined][] = [
    ["addNodeAt", () => { const spec = pick([...PALETTE, ...EVENT_PALETTE])!.spec; const [x, y] = xy(); return addNodeAt(view, spec, x, y).model; }],
    ["moveNode", () => (nodeId ? dropNodeIntoLane(moveNode(view, nodeId, xy()[0], xy()[1]), nodeId) : undefined)],
    ["deleteNode", () => (nodeId ? deleteNode(view, nodeId) : undefined)],
    ["duplicateNode", () => (nodeId ? duplicateNode(view, nodeId).model : undefined)],
    ["addFlow", () => { const a = pick(ids), b = pick(ids); return a && b ? addFlow(view, a, b).model : undefined; }],
    ["deleteFlow", () => { const f = pick(view.flows); return f ? deleteFlow(view, f.id) : undefined; }],
    ["reconnectFlow", () => { const f = pick(view.flows), n = pick(ids); return f && n ? reconnectFlow(view, f.id, r() < 0.5 ? "from" : "to", n, pick(["L", "R", "T", "B"] as const), undefined, r()).model : undefined; }],
    ["routeFlow", () => { const f = pick(view.flows); return f ? setFlowRoute(view, f.id, r() < 0.3 ? null : { points: [[...xy()]], from_pos: r(), to_pos: r() }) : undefined; }],
    ["bendFlow", () => {
      const ids2 = [...view.flows.map((f) => f.id), ...(view.messages ?? []).map((x) => `msg:${x.id}`)];
      const id = pick(ids2);
      if (!id) return undefined;
      const lay = diagramLayout(view);
      const poly = lay.routes.get(id);
      const inf = lay.info.get(id);
      if (!poly || !inf) return undefined;
      const g = { poly, from: inf.from, to: inf.to };
      const which = r();
      if (which < 0.35) return addBend(view, id, g, [...xy()]);
      if (which < 0.6 && poly.length > 2) return dragCorner(view, id, g, 1 + Math.floor(r() * (poly.length - 2)), [...xy()]);
      if (which < 0.85) return dragSegment(view, id, g, Math.floor(r() * (poly.length - 1)), Math.round((r() - 0.5) * 200));
      return poly.length > 2 ? removeBend(view, id, g, 1 + Math.floor(r() * (poly.length - 2))) : undefined;
    }],
    ["boundary", () => { const t = pick(tasks); return t ? addBoundaryEvent(view, t, pick(["timer", "message", "error", "signal"] as const)).model : undefined; }],
    ["trigger", () => { const t = pick(tasks); return t ? attachTrigger(view, t, pick(["timer", "message", "conditional", "signal"] as const)).model : undefined; }],
    ["deleteTrigger", () => { const ev = pick(view.nodes.filter((n) => n.type === "event")); return ev ? deleteTriggerEvent(view, ev.id) : undefined; }],
    ["setType", () => (nodeId ? setNodeType(view, nodeId, pick(["task", "subprocess", "event", "gateway"] as const)!) : undefined)],
    ["setRole", () => (nodeId ? setNodeRole(view, nodeId, pick([null, ...view.roles.map((x) => x.id)]) ?? null) : undefined)],
    ["rename", () => (nodeId ? updateNode(view, nodeId, { name: pick(["", "  ", "Новое <имя> & «кавычки»", "x".repeat(300)])! }) : undefined)],
    ["artifactOffset", () => { const n = pick(view.nodes.filter((x) => x.inputs.length || x.outputs.length || x.system_ids.length)); if (!n) return undefined; const key = pick([...n.inputs.map((d) => `input:${d}`), ...n.outputs.map((d) => `output:${d}`), ...n.system_ids.map((s) => `store:${s}`)])!; return setArtifactOffset(view, n.id, key, r() < 0.2 ? null : { dx: Math.round((r() - 0.5) * 400), dy: Math.round((r() - 0.5) * 300) }); }],
    ["laneHeight", () => setLaneHeight(view, Math.floor(r() * 3), 100 + Math.round(r() * 600))],
    ["diagramWidth", () => setDiagramWidth(view, r() < 0.3 ? null : 500 + Math.round(r() * 3000))],
    ["addRole", () => addRole(view).model],
    ["deleteRole", () => { const role = pick(view.roles); return role ? deleteRole(view, role.id).model : undefined; }],
    ["group", () => {
      const sel = ids.filter(() => r() < 0.4);
      if (sel.length < 2) return undefined;
      const which = r();
      if (which < 0.25) return moveGroup(view, sel, Math.round((r() - 0.5) * 300), Math.round((r() - 0.5) * 300));
      if (which < 0.45) return alignLeft(view, sel);
      if (which < 0.6) return alignMiddle(view, sel);
      if (which < 0.75) return distributeHorizontally(view, sel);
      if (which < 0.9) { const frag = copyFragment(view, sel); return frag ? pasteFragment(view, frag, 40, 40, { nodes: full.nodes.map((n) => n.id), flows: full.flows.map((f) => f.id) }).model : undefined; }
      return deleteGroup(view, sel);
    }],
  ];
  // пулы и потоки сообщений, справочники — общие для всех диаграмм: редактор правит их в полной модели
  const fullOps: [string, () => M | undefined][] = [
    ["addPool", () => addPool(full, "Пул", null, scope ?? "").model],
    ["deletePool", () => { const p = pick(full.pools ?? []); return p ? deletePool(full, p.id) : undefined; }],
    ["poolOffset", () => { const p = pick(full.pools ?? []); return p ? setPoolOffset(full, p.id, Math.round((r() - 0.5) * 600), Math.round((r() - 0.5) * 400)) : undefined; }],
    ["addMessage", () => { const p = pick(full.pools ?? []), n = pick(ids); return p && n ? addMessage(full, r() < 0.5 ? n : p.id, r() < 0.5 ? p.id : n).model : undefined; }],
    ["deleteMessage", () => { const x = pick(full.messages ?? []); return x ? deleteMessage(full, x.id) : undefined; }],
    ["messageRoute", () => { const x = pick(full.messages ?? []); return x ? setFlowRoute(full, `msg:${x.id}`, r() < 0.3 ? null : { points: [[...xy()]] }) : undefined; }],
    ["removeData", () => { const d = pick(full.data); return d ? removeEntry(full, "data", d.id) : undefined; }],
    ["removeSystem", () => { const s = pick(full.systems); return s ? removeEntry(full, "systems", s.id) : undefined; }],
    ["linkData", () => { const n = pick(full.nodes.filter((x) => x.type === "task")), d = pick(full.data); return n && d ? updateNode(full, n.id, { inputs: [...new Set([...n.inputs, d.id])] }) : undefined; }],
    ["unlinkData", () => { const n = pick(full.nodes.filter((x) => x.inputs.length)); return n ? updateNode(full, n.id, { inputs: n.inputs.slice(1) }) : undefined; }],
  ];
  const useFull = r() < 0.3;
  const [name, op] = pick(useFull ? fullOps : viewOps)!;
  log.push(`${name}${useFull ? "" : ` @${scope ?? "общая"}`}`);
  const next = op();
  if (!next) return full;
  return useFull ? next : mergeScope(full, next, scope, view);
}

describe("фаззинг правок редактора BPMN: модель остаётся целой и раскладывается", () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]) {
    it(`сид ${seed}: 120 случайных правок`, () => {
      const r = rng(seed);
      let m = startModel();
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
});
