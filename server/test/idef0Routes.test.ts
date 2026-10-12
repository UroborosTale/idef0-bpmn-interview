import JSZip from "jszip";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildVsdx } from "../src/export/vsdx.js";
import { generateIdef0 } from "../src/pipeline/idef0.js";
import { idef0Extents, labelSpec, layoutIdef0 } from "../src/shared/idef0Layout.js";
import { ProcessLogicModel } from "../src/types/model.js";
import { startApp } from "./api.js";
import { purchaseModel } from "./fixtures.js";

delete process.env.AUTH_USERS;

type Routes = Record<string, Record<string, unknown>>;
/** Модель с ручными маршрутами у функции nodeId. */
const withRoutes = (nodeId: string, routes: Routes) => {
  const m = purchaseModel();
  return ProcessLogicModel.parse({ ...m, nodes: m.nodes.map((n) => (n.id === nodeId ? { ...n, arrow_routes: routes } : n)) });
};
const arrow = (m: ProcessLogicModel, key: string) => layoutIdef0(m, null).arrows.find((a) => a.key === key)!;
const box = (m: ProcessLogicModel, id: string) => layoutIdef0(m, null).functions.find((f) => f.node.id === id)!.box;
const orthogonal = (poly: [number, number][]) => poly.slice(1).every((p, i) => Math.abs(p[0] - poly[i][0]) < 0.5 || Math.abs(p[1] - poly[i][1]) < 0.5);

describe("ручные маршруты стрелок IDEF0: модель и раскладка", () => {
  it("схема принимает маршрут, отбрасывает неверные значения и не требует его", () => {
    expect(purchaseModel().nodes.every((n) => n.arrow_routes === undefined)).toBe(true);
    const m = withRoutes("b", { "link:d1": { pos: 0.7, from_pos: 0.2, points: [[100, 200]], end: [10, 20], label: [5, -5] } });
    expect(m.nodes.find((n) => n.id === "b")!.arrow_routes).toEqual({ "link:d1": { pos: 0.7, from_pos: 0.2, points: [[100, 200]], end: [10, 20], label: [5, -5] } });
    expect(() => withRoutes("b", { "link:d1": { pos: 1.5 } })).toThrow();
    expect(() => withRoutes("b", { "link:d1": { points: [[1]] } })).toThrow();
  });

  it("положение концов у блоков: вход по y, источник связи на своей стороне, механизм по x", () => {
    const m = withRoutes("b", { "link:d1": { pos: 0.8, from_pos: 0.25 } });
    const link = arrow(m, "link:b:d1");
    expect(link.points[link.points.length - 1][1]).toBeCloseTo(box(m, "b").y + 0.8 * box(m, "b").h, 5);
    expect(link.points[0][1]).toBeCloseTo(box(m, "a").y + 0.25 * box(m, "a").h, 5);
    expect(link.manual).toBe(true);
    const mech = arrow(withRoutes("c", { "system:s1": { pos: 0.75 } }), "system:c:s1");
    expect(mech.points[1][0]).toBeCloseTo(box(purchaseModel() as never, "c").x + 0.75 * box(purchaseModel() as never, "c").w, 5);
    // без маршрута — как раньше
    expect(arrow(purchaseModel() as never, "link:b:d1").manual).toBeUndefined();
  });

  it("точки излома и свободный конец прокладываются ортогонально; наконечник входит в блок под прямым углом", () => {
    const base = purchaseModel();
    const bC = box(base as never, "c");
    const m = withRoutes("c", { "input:d2": { end: [bC.x - 120, bC.y - 90] }, "output:d4": { end: [bC.x + bC.w + 150, bC.y + 120], points: [[bC.x + bC.w + 90, bC.y + 40]] } });
    const input = arrow(m, "input:c:d2");
    expect(input.points[0]).toEqual([bC.x - 120, bC.y - 90]);
    expect(orthogonal(input.points)).toBe(true);
    const last = input.points[input.points.length - 1];
    expect(last[0]).toBeCloseTo(bC.x, 5);
    expect(input.points[input.points.length - 2][1]).toBeCloseTo(last[1], 5);
    const out = arrow(m, "output:c:d4");
    expect(out.points[out.points.length - 1]).toEqual([bC.x + bC.w + 150, bC.y + 120]);
    expect(orthogonal(out.points)).toBe(true);
    expect(out.manual).toBe(true);
    // маршрут одной стрелки не трогает другие
    expect(arrow(m, "system:c:s1").points).toEqual(arrow(purchaseModel() as never, "system:c:s1").points);
  });

  it("сдвиг подписи; размер диаграммы учитывает уведённые вручную стрелки", () => {
    const base = purchaseModel();
    const plain = arrow(base as never, "input:c:d2");
    const m = withRoutes("c", { "input:d2": { label: [12, -20] } });
    const shifted = arrow(m, "input:c:d2");
    expect(shifted.labelOffset).toEqual([12, -20]);
    const a = labelSpec(plain)!;
    expect(labelSpec(shifted)).toMatchObject({ x: a.x + 12, y: a.y - 20 });
    const bC = box(base as never, "c");
    const far = withRoutes("c", { "output:d4": { end: [bC.x + bC.w + 1500, bC.y + 20] } });
    expect(idef0Extents(layoutIdef0(far, null)).w).toBeGreaterThanOrEqual(bC.x + bC.w + 1500 + 200);
    expect(idef0Extents(layoutIdef0(base as never, null)).w).toBeLessThan(bC.x + bC.w + 1500);
  });

  it("маршрут бессмысленной стрелки (связь уже разорвана) игнорируется", () => {
    const m = withRoutes("b", { "link:nope": { pos: 0.5 }, "input:d1": { pos: 0.9 } }); // d1 у b — связь, а не внешний вход
    expect(arrow(m, "link:b:d1").manual).toBeUndefined();
    expect(layoutIdef0(m, null).arrows.some((a) => a.key === "input:b:d1")).toBe(false);
  });
});

describe("экспорт строится по тем же маршрутам", () => {
  it("SVG диаграмм IDEF0: ломаная стрелки совпадает с раскладкой, подпись сдвинута", () => {
    const bC = box(purchaseModel() as never, "c");
    const end: [number, number] = [bC.x + bC.w + 150, bC.y + 120];
    const m = withRoutes("c", { "output:d4": { end, label: [0, 30] } });
    const plain = generateIdef0(purchaseModel() as never).decompositionSvg;
    const svg = generateIdef0(m).decompositionSvg;
    const pts = arrow(m, "output:c:d4").points.map((p) => `${p[0]},${p[1]}`);
    expect(svg).not.toBe(plain);
    for (const p of pts) expect(svg).toContain(p);
    expect(plain).not.toContain(`${end[0]},${end[1]}`);
  });

  it("VSDX: связь с ручным маршрутом рисуется иначе, чем автоматическая, и остаётся соединителем, приклеенным к блокам", async () => {
    const pagesXml = async (model: ProcessLogicModel) => {
      const zip = await JSZip.loadAsync(await buildVsdx(model));
      const pages = Object.keys(zip.files).filter((n) => /visio\/pages\/page\d+\.xml$/.test(n));
      return (await Promise.all(pages.map((p) => zip.file(p)!.async("string")))).join("\n");
    };
    const routed = await pagesXml(withRoutes("b", { "link:d1": { pos: 0.8, points: [[430, 300], [430, 402]] } }));
    const plain = await pagesXml(purchaseModel() as never);
    // соединитель связи (метка pm_a «вид|функция|сущность») есть в обоих файлах, но нарисован по-разному
    expect(routed).toContain('V="link|b|d1"');
    expect(plain).toContain('V="link|b|d1"');
    expect(routed).not.toBe(plain);
    expect(routed).toContain("<Connect FromSheet=");
  });
});
describe("маршруты через API", () => {
  let app: Awaited<ReturnType<typeof startApp>>;
  beforeAll(async () => {
    app = await startApp();
  });
  afterAll(() => app.close());

  it("сохраняются с моделью и читаются обратно; неверный маршрут отклоняется; пересборка диаграмм использует их", async () => {
    const s = (await app.call("POST", "/sessions/blank", { meta: { processName: "Маршруты" } })).body;
    const model = JSON.parse(JSON.stringify(purchaseModel()));
    model.nodes = model.nodes.map((n: { id: string }) => (n.id === "c" ? { ...n, arrow_routes: { "output:d4": { end: [1200, 330], points: [[1100, 330]], label: [0, 18] } } } : n));
    const put = await app.call("PUT_BASE", `/sessions/${s.id}/model|${s.updatedAt}`, model);
    expect(put.status).toBe(200);
    const got = (await app.call("GET", `/sessions/${s.id}`)).body.model;
    expect(got.nodes.find((n: { id: string }) => n.id === "c").arrow_routes).toEqual({ "output:d4": { end: [1200, 330], points: [[1100, 330]], label: [0, 18] } });
    const rebuilt = await app.call("POST", `/sessions/${s.id}/rebuild-diagrams`);
    expect(rebuilt.status).toBe(200);
    const svg = (await app.call("GET", `/sessions/${s.id}/export/idef0/decomposition.svg`)).body as string;
    expect(svg).toContain("1200,330");
    const bad = JSON.parse(JSON.stringify(model));
    bad.nodes.find((n: { id: string }) => n.id === "c").arrow_routes = { "output:d4": { pos: 3 } };
    expect((await app.call("PUT", `/sessions/${s.id}/model`, bad, { "X-Base-Updated-At": put.body.updatedAt })).status).toBeGreaterThanOrEqual(400);
  });
});
