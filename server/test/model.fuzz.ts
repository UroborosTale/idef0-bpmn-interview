import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApp } from "./api.js";
import { REFERENCE_PROCESSES } from "../src/reference/index.js";

delete process.env.AUTH_USERS;

/**
 * Фаззинг модели: схема пропускает модели правильной формы, но со странным содержимым (циклы декомпозиции, висячие ссылки, петли,
 * граничное событие на самом себе, пустые названия, огромные значения). Каждая такая модель сохраняется через API, после чего вызываются
 * все выгрузки и отчёты сессии: ни один не должен падать (500) или зависать.
 */
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

type AnyModel = Record<string, any>;
const MUTATIONS: [string, (m: AnyModel, r: () => number) => void][] = [
  ["цикл декомпозиции IDEF0", (m, r) => { const fns = m.nodes.filter((n: any) => n.type === "task" || n.type === "subprocess"); if (fns.length > 1) { const a = fns[Math.floor(r() * fns.length)]; const b = fns[Math.floor(r() * fns.length)]; a.idef0_parent = b.id; b.idef0_parent = a.id; } }],
  ["функция — сама себе родитель", (m, r) => { const n = m.nodes[Math.floor(r() * m.nodes.length)]; n.idef0_parent = n.id; }],
  ["bpmn_scope на несуществующую функцию", (m, r) => { m.nodes[Math.floor(r() * m.nodes.length)].bpmn_scope = "нет-такой"; }],
  ["bpmn_scope на самого себя", (m, r) => { const n = m.nodes[Math.floor(r() * m.nodes.length)]; n.bpmn_scope = n.id; }],
  ["граничное событие на самом себе", (m, r) => { const n = m.nodes.find((x: any) => x.type === "event") ?? m.nodes[0]; n.attached_to = n.id; }],
  ["граничное событие на несуществующей задаче", (m) => { const n = m.nodes.find((x: any) => x.type === "event"); if (n) n.attached_to = "нет"; }],
  ["граничное событие на событии", (m) => { const evs = m.nodes.filter((x: any) => x.type === "event"); if (evs.length > 1) evs[0].attached_to = evs[1].id; }],
  ["поток в несуществующий узел", (m) => { m.flows.push({ id: "fz1", from: m.nodes[0].id, to: "нет-узла", source: [] }); }],
  ["петля потока", (m, r) => { const n = m.nodes[Math.floor(r() * m.nodes.length)]; m.flows.push({ id: "fz2", from: n.id, to: n.id, source: [] }); }],
  ["дубли потоков", (m) => { if (m.flows[0]) m.flows.push({ ...m.flows[0], id: "fz3" }, { ...m.flows[0], id: "fz4" }); }],
  ["повтор id узла", (m) => { if (m.nodes.length > 1) m.nodes[1] = { ...m.nodes[1], id: m.nodes[0].id }; }],
  ["исполнитель — несуществующая роль", (m, r) => { m.nodes[Math.floor(r() * m.nodes.length)].role_id = "нет-роли"; }],
  ["вход/выход/управление — несуществующие записи", (m, r) => { const n = m.nodes[Math.floor(r() * m.nodes.length)]; n.inputs = ["нет1"]; n.outputs = ["нет2"]; n.controls = ["нет3"]; n.control_data_ids = ["нет4"]; n.system_ids = ["нет5"]; }],
  ["пустые названия", (m) => { for (const n of m.nodes.slice(0, 5)) n.name = ""; for (const r of m.roles) r.name = ""; }],
  ["огромные названия", (m) => { m.nodes[0].name = "Ш".repeat(20000); m.process.name = "П".repeat(5000); }],
  ["спецсимволы и разметка в названиях", (m) => { m.nodes[0].name = `<script>alert(1)</script> & "кавычки" ' \u0000 \u001f ]]> --> ${"‮"}`; m.roles[0] && (m.roles[0].name = "<b>роль</b>&amp;"); }],
  ["тип события/шлюза не по правилам", (m) => { const n = m.nodes.find((x: any) => x.type === "gateway"); if (n) n.subtype = "нечто"; const e = m.nodes.find((x: any) => x.type === "event"); if (e) (e.subtype = "boundary_weird", (e.trigger = { type: "timer", timer: { kind: "cycle", value: "" } })); }],
  ["огромные координаты", (m) => { m.nodes[0].layout = { x: 1e9, y: -1e9 }; m.nodes[0].idef0_layout = { x: 1e9, y: 1e9 }; }],
  ["ручной маршрут на чужие ключи", (m) => { m.nodes[0].arrow_routes = { "link:нет": { points: [[0, 0]] }, "мусор": { pos: 0.5 } }; }],
  ["назначения на несуществующие функции и роли", (m) => { m.assignments = [...(m.assignments ?? []), { node_id: "нет", role_id: "нет", kind: "owner", functions: [] }]; }],
  ["RACI с висячими ссылками", (m) => { m.raci = [...(m.raci ?? []), { node_id: "нет", role_id: "нет", type: "A" }]; }],
  ["сообщения в несуществующий пул", (m) => { m.messages = [...(m.messages ?? []), { id: "mz", from: m.nodes[0].id, to: "нет-пула" }]; }],
  ["тысяча узлов", (m) => { for (let i = 0; i < 1000; i++) m.nodes.push({ id: `z${i}`, type: "task", name: `Шаг ${i}`, status: "confirmed", confidence: 1, system_ids: [], inputs: [], outputs: [], controls: [] }); for (let i = 0; i < 999; i++) m.flows.push({ id: `zf${i}`, from: `z${i}`, to: `z${i + 1}`, source: [] }); }],
  ["пустая модель", (m) => { m.nodes = []; m.flows = []; }],
  ["код процесса странного вида", (m) => { m.process.code = "Я999.99.99.99"; }],
];

let app: Awaited<ReturnType<typeof startApp>>;
let getRoutes: string[] = [];
beforeAll(async () => {
  app = await startApp();
  const { app: express } = await import("../src/app.js");
  const out: string[] = [];
  const walk = (stack: any[]) => {
    for (const l of stack) {
      if (l.route && l.route.methods.get && /^\/sessions\/:id\//.test(l.route.path) && !/:(?!id\b)\w+/.test(l.route.path)) out.push(l.route.path);
      else if (l.handle?.stack) walk(l.handle.stack);
    }
  };
  walk((express as any)._router.stack);
  getRoutes = [...new Set(out)].filter((p) => !/\.pdf$/.test(p)); // PDF требует Chromium — 501 по замыслу
});
afterAll(() => app?.close());

describe("фаззинг модели: странные, но допустимые схемой модели не роняют выгрузки и отчёты", () => {
  it("каждая мутация по отдельности и случайные сочетания", async () => {
    expect(getRoutes.length).toBeGreaterThan(30);
    const findings: string[] = [];
    const cases: { label: string; muts: number[] }[] = MUTATIONS.map((_, i) => ({ label: MUTATIONS[i][0], muts: [i] }));
    const r = rng(42);
    for (let k = 0; k < 12; k++) {
      const muts = [...new Set(Array.from({ length: 3 + Math.floor(r() * 3) }, () => Math.floor(r() * (MUTATIONS.length - 2))))];
      cases.push({ label: muts.map((i) => MUTATIONS[i][0]).join(" + "), muts });
    }
    for (const c of cases) {
      const base = c.label.includes("тысяча") ? REFERENCE_PROCESSES.demo.build() : REFERENCE_PROCESSES[["b002", "c025", "demo"][Math.floor(r() * 3)]].build();
      const model = JSON.parse(JSON.stringify(base));
      for (const i of c.muts) MUTATIONS[i][1](model, r);
      const s = (await app.call("POST", "/sessions/blank", { meta: { processName: "Мутант" } })).body;
      const put = await app.call("PUT", `/sessions/${s.id}/model`, model, { "X-Base-Updated-At": s.updatedAt });
      if (put.status >= 500) findings.push(`[${c.label}] сохранение модели → ${put.status}: ${String(put.body?.error).slice(0, 160)}`);
      if (put.status !== 200) continue; // схема отклонила — это нормально
      const rebuilt = await app.call("POST", `/sessions/${s.id}/rebuild-diagrams`);
      if (rebuilt.status >= 500) findings.push(`[${c.label}] пересборка диаграмм → ${rebuilt.status}: ${String(rebuilt.body?.error).slice(0, 160)}`);
      for (const route of getRoutes) {
        const url = route.replace(":id", s.id);
        const t0 = Date.now();
        try {
          const res = await Promise.race([app.raw(url), new Promise<never>((_, rej) => setTimeout(() => rej(new Error("ЗАВИС > 20 с")), 20_000))]);
          if (res.status >= 500 && res.status !== 501) findings.push(`[${c.label}] GET ${route} → ${res.status}: ${res.body.toString("utf8").slice(0, 160)}`);
        } catch (e) {
          findings.push(`[${c.label}] GET ${route} → ${(e as Error).message}`);
        }
        if (Date.now() - t0 > 8000) findings.push(`[${c.label}] GET ${route} — медленно: ${Date.now() - t0} мс`);
      }
    }
    expect((await app.call("GET", "/health")).status).toBe(200);
    const uniq = new Map<string, string>();
    for (const f of findings) {
      const key = f.replace(/^\[[^\]]*\]\s*/, "").replace(/→.*$/, "");
      uniq.set(key, (uniq.get(key) ? uniq.get(key) + "\n    " : "") + f);
    }
    console.log(`случаев: ${cases.length}, маршрутов выгрузки: ${getRoutes.length}, находок: ${findings.length}`);
    console.log([...uniq.entries()].map(([k, v]) => `${k}\n    ${v.split("\n").slice(0, 3).join("\n")}`).join("\n"));
    expect(findings.filter((f) => !/медленно/.test(f))).toEqual([]);
  }, 1_800_000);
});
