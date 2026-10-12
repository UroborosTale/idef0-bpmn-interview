import { describe, expect, it } from "vitest";
import { scopeView } from "@shared/scope";
import { REFERENCE_PROCESSES } from "../../../../server/src/reference/index";
import { structuredModel } from "../../test/fixtures";
import type { ProcessLogicModel } from "../../types";
import { idef0Codes } from "../idef0-editor/geometry";
import { addMessage, addPool, setArtifactOffset, setFlowRoute, setPoolOffset } from "./model-ops";
import { diagramLayout, withLayout, withScopeLayouts } from "./geometry";

/**
 * «Золотые» снимки того, что рисует редактор BPMN: координаты фигур, ломаных стрелок, значков документов, пулов и потоков
 * сообщений, как их считает `diagramLayout` (тот же код рисует диаграмму на экране). По строке на элемент — любое непреднамеренное
 * смещение видно в diff. Намеренное изменение: `npx vitest run src/components/bpmn-editor/layoutGolden.test.ts -u` и просмотр diff
 * снимков в `__golden__` перед коммитом.
 */
const r1 = (n: number) => Math.round(n * 10) / 10;
const pts = (p: [number, number][]) => p.map(([x, y]) => `${r1(x)},${r1(y)}`).join(" ");
const box = (b: { x: number; y: number; w: number; h: number }) => `${r1(b.x)},${r1(b.y)} ${r1(b.w)}×${r1(b.h)}`;

/** Модель так, как её открывает студия (раскладка шагов всех диаграмм). */
const seeded = (m: ProcessLogicModel) => withScopeLayouts(withLayout(m, false));

function snapshot(m: ProcessLogicModel): string {
  const codes = idef0Codes(m);
  const out: string[] = [];
  const scopes: (string | null)[] = [null, ...new Set(m.nodes.map((n) => n.bpmn_scope).filter((s): s is string => !!s))];
  for (const scope of scopes) {
    const view = scopeView(m, scope);
    const lay = diagramLayout(view);
    out.push(`# редактор BPMN ${scope === null ? "общая схема" : codes.get(scope) ?? scope}`);
    for (const n of lay.shown) {
      const b = lay.boxes.get(n.id)!;
      out.push(`shape ${n.id} ${n.type}${n.subtype ? "/" + n.subtype : ""} ${box(b)} «${n.name}»`);
    }
    for (const f of lay.flows) out.push(`flow ${f.id} ${f.from}→${f.to} [${pts(lay.routes.get(f.id) ?? [])}]${f.condition ? ` «${f.condition}»` : ""}`);
    for (const a of lay.extras.artifacts) out.push(`artifact ${a.key} ${box(a.box)} edge[${pts(a.edge)}] «${a.name}»`);
    for (const p of lay.extras.pools) out.push(`pool ${p.pool.id} ${box(p.box)} «${p.pool.name}»`);
    for (const { message, points } of lay.extras.messages) out.push(`message ${message.id} ${message.from}→${message.to} [${pts(lay.routes.get(`msg:${message.id}`) ?? points)}]`);
  }
  return out.join("\n") + "\n";
}

/** Модель со всем, что добавлено руками: пул, поток сообщений с маршрутом, смещённые значки, ручной маршрут стрелки. */
function handEdited(): ProcessLogicModel {
  let m = seeded(structuredModel());
  const b1 = m.nodes.find((n) => n.id === "b1")!;
  m = { ...m, nodes: m.nodes.map((n) => (n.id === "b1" ? { ...n, inputs: ["d1", "d3"], outputs: ["d2"], system_ids: ["s1"] } : n)) };
  m = setArtifactOffset(m, b1.id, "input:d1", { dx: -60, dy: -18 });
  m = setArtifactOffset(m, b1.id, "store:s1", { dx: 80, dy: 0 });
  const pool = addPool(m, "Поставщики", "S001", "o1");
  m = pool.model;
  m = setPoolOffset(m, pool.id!, 120, 30);
  const msg = addMessage(m, "b2", pool.id!, "Запрос предложений");
  m = setFlowRoute(msg.model, `msg:${msg.id}`, { points: [[640, 420]] });
  const flow = m.flows.find((f) => f.id === "bf2");
  if (flow) m = setFlowRoute(m, flow.id, { points: [[560, 300]] });
  return m;
}

describe("золотые снимки того, что рисует редактор BPMN", () => {
  for (const [name, p] of Object.entries(REFERENCE_PROCESSES)) {
    it(`${name}: эталон`, async () => {
      await expect(snapshot(seeded(p.build() as ProcessLogicModel))).toMatchFileSnapshot(`__golden__/editor-${name}.txt`);
    });
  }
  it("модель с правками вручную: значки со смещением, пул, поток сообщений и стрелка с ручным маршрутом", async () => {
    await expect(snapshot(handEdited())).toMatchFileSnapshot("__golden__/editor-hand-edited.txt");
  });
});
