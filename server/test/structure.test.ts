import JSZip from "jszip";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApp } from "./api.js";
import { generateBpmn } from "../src/pipeline/bpmn.js";
import { generateIdef0 } from "../src/pipeline/idef0.js";
import { carryOverManualEdits } from "../src/pipeline/carryOver.js";
import { bpmnHosts, functionCodes, functionDepth, isStructured, parseProcessCode, processCodeOf, stepCodes } from "../src/shared/codes.js";
import { idef0Codes, layoutIdef0, mechanismRoleIds } from "../src/shared/idef0Layout.js";
import { laneRoleIds, mergeScope, scopeView } from "../src/shared/scope.js";
import { validateModel } from "../src/shared/validate.js";
import { buildVsdx } from "../src/export/vsdx.js";
import { purchaseModel, structuredModel } from "./fixtures.js";

delete process.env.AUTH_USERS;

describe("коды по Соглашению о моделировании", () => {
  it("шаблон кода процесса: латиница и кириллица, с хвостом .00.00 и без него", () => {
    expect(parseProcessCode("B002.00.00")).toEqual({ group: "B", number: "002" });
    expect(parseProcessCode("В002")).toEqual({ group: "В", number: "002" }); // кириллическая «В» из документов
    expect(parseProcessCode("A02")).toBeNull();
    expect(parseProcessCode("B002.01.00")).toBeNull();
    expect(parseProcessCode(null)).toBeNull();
  });

  it("функции получают коды уровней: подпроцесс .NN.00, операция .NN.MM", () => {
    const m = structuredModel();
    expect(Object.fromEntries(functionCodes(m))).toEqual({ s1: "B002.01.00", s2: "B002.02.00", o1: "B002.01.01", o2: "B002.01.02", o3: "B002.02.01" });
    expect(processCodeOf(m)).toBe("B002.00.00");
    expect(isStructured(m)).toBe(true);
    expect(idef0Codes(m).get("o2")).toBe("B002.01.02"); // тот же расчёт использует раскладка IDEF0
  });

  it("шаги BPMN операции — подоперации B002.01.01/001; события кода не получают", () => {
    expect(Object.fromEntries(stepCodes(structuredModel()))).toEqual({ b1: "B002.01.01/001", b2: "B002.01.01/002" });
  });

  it("шаги диаграммы BPMN не считаются функциями IDEF0", () => {
    const codes = functionCodes(structuredModel());
    expect(codes.has("b1")).toBe(false);
    expect(codes.size).toBe(5);
  });

  it("нумерация сквозная без пропусков: после удаления функции следующие сдвигаются", () => {
    const m = structuredModel();
    m.nodes = m.nodes.filter((n) => n.id !== "o1");
    expect(functionCodes(m).get("o2")).toBe("B002.01.01");
  });

  it("без кода процесса — прежние A1, A21", () => {
    expect(Object.fromEntries(functionCodes(purchaseModel()))).toEqual({ a: "A1", b: "A2", c: "A3", b1: "A21", b2: "A22" });
    expect(processCodeOf(purchaseModel())).toBe("A0");
    expect(isStructured(purchaseModel())).toBe(false);
  });

  it("глубина и операции, у которых бывает диаграмма BPMN", () => {
    const m = structuredModel();
    expect(functionDepth(m, "s1")).toBe(1);
    expect(functionDepth(m, "o1")).toBe(2);
    expect(functionDepth(m, "b1")).toBe(0);
    expect(bpmnHosts(m).map((n) => n.id)).toEqual(["o1", "o2", "o3"]);
    expect(bpmnHosts(purchaseModel()).map((n) => n.id)).toEqual(["b1", "b2"]); // в прежней модели — только листья глубже верхнего уровня
  });
});

describe("диаграмма BPMN операции как область модели", () => {
  it("вид области: свои шаги, потоки между ними и дорожки исполнителей", () => {
    const m = structuredModel();
    const v = scopeView(m, "o1");
    expect(v.nodes.map((n) => n.id)).toEqual(["b0", "b1", "b2", "b9"]);
    expect(v.nodes.every((n) => !n.bpmn_scope && !n.idef0_parent)).toBe(true);
    expect(v.flows).toHaveLength(3);
    expect(v.roles.map((r) => r.id)).toEqual(["r2"]); // контролёр r3 — не дорожка
    expect([...laneRoleIds(m, "o1")]).toEqual(["r2"]);
    expect(scopeView(m, null).nodes.map((n) => n.id)).toEqual(["s1", "s2", "o1", "o2", "o3"]);
  });

  it("модель без диаграмм операций: вид общей схемы — сама модель", () => {
    const m = purchaseModel();
    expect(scopeView(m, null)).toBe(m);
  });

  it("правки вида вливаются в модель: новая фигура, удаление, новая дорожка", () => {
    const m = structuredModel();
    const v = scopeView(m, "o1");
    const next = {
      ...v,
      nodes: [...v.nodes.filter((n) => n.id !== "b2"), { ...v.nodes[1], id: "b3", name: "Сохранить реестр" }],
      flows: v.flows.filter((f) => f.id === "bf1"),
      roles: [...v.roles, { id: "r9", name: "Новая роль", kind: "internal" as const, source: [] }],
    };
    const merged = mergeScope(m, next, "o1", v);
    expect(merged.nodes.filter((n) => n.bpmn_scope === "o1").map((n) => n.id)).toEqual(["b0", "b1", "b9", "b3"]);
    expect(merged.nodes.find((n) => n.id === "b3")).toMatchObject({ bpmn_scope: "o1", idef0_parent: null });
    expect(merged.nodes.slice(0, 5).map((n) => n.id)).toEqual(["s1", "s2", "o1", "o2", "o3"]); // функции на месте
    expect(merged.flows.map((f) => f.id)).toEqual(["bf1"]);
    expect(merged.roles.map((r) => r.id)).toContain("r9");
    expect(merged.assignments).toContainEqual({ node_id: "o1", role_id: "r9", kind: "executor", functions: [] });
    expect(laneRoleIds(merged, "o1").has("r9")).toBe(true); // новая дорожка видна при следующем открытии
  });

  it("вид не менялся — возвращается та же модель (нет шага истории)", () => {
    const m = structuredModel();
    const v = scopeView(m, "o1");
    expect(mergeScope(m, v, "o1", v)).toBe(m);
  });

  it("правки области не затрагивают остальные области", () => {
    const m = structuredModel();
    const v = scopeView(m, "o1");
    const merged = mergeScope(m, { ...v, nodes: [], flows: [] }, "o1", v);
    expect(merged.nodes.map((n) => n.id)).toEqual(["s1", "s2", "o1", "o2", "o3"]);
    expect(merged.flows).toEqual([]);
  });

  it("BPMN XML операции: пул с кодом и названием, только свои шаги", async () => {
    const m = structuredModel();
    const r = await generateBpmn(m, "o1");
    expect(r.xml).toContain('name="B002.01.01 Актуализация реестра процессов"');
    expect(r.xml).toContain("Открыть реестр");
    expect(r.xml).not.toContain("Анализ соответствия");
    expect(Object.keys(r.elementIndex).sort()).toEqual(["b0", "b1", "b2", "b9"]);
    expect(r.diagram.lanes.map((l) => l.name)).toEqual(["Специалист отдела корпоративных технологий"]);
    expect(r.diagram.poolName).toBe("B002.01.01 Актуализация реестра процессов");
    // продукты диаграммы операции — только те, на которые ссылаются её шаги
    expect(r.xml).not.toContain("DataObj_d4");
  });

  it("общая схема процесса не включает шаги операций", async () => {
    const r = await generateBpmn(structuredModel());
    expect(r.xml).not.toContain("Открыть реестр");
    expect(r.xml).toContain("Моделирование процесса");
  });
});

describe("ролевая модель в IDEF0", () => {
  it("механизмы функции — исполнитель и назначенные должности, без повторов; наблюдатель не механизм", () => {
    const m = structuredModel();
    m.assignments.push({ node_id: "o1", role_id: "r1", kind: "observer", functions: [] }, { node_id: "o1", role_id: "r2", kind: "coexecutor", functions: [] });
    expect(mechanismRoleIds(m, m.nodes.find((n) => n.id === "o1")!)).toEqual(["r2", "r3"]);
    const arrows = layoutIdef0(m, "s1").arrows.filter((a) => a.kind === "role" && a.nodeId === "o1");
    expect(arrows.map((a) => a.entityId)).toEqual(["r2", "r3"]);
  });

  it("контекстная диаграмма процесса: должности процесса и код процесса", () => {
    const g = generateIdef0(structuredModel());
    expect(g.contextSvg).toContain("B002.00.00");
    expect(g.contextSvg).toContain("Начальник отдела корпорат"); // подпись стрелки обрезается до 26 знаков
    expect(g.contextSvg).not.toContain("Директор по персоналу"); // это должность операции, а не процесса
    expect(g.decompositionSvg).toContain("B002.01.00");
    expect(g.children.map((c) => c.code)).toEqual(["B002.01.00", "B002.02.00"]);
  });
});

describe("проверки структуры и ролей", () => {
  const rules = (m: ReturnType<typeof structuredModel>) => validateModel(m).map((i) => i.rule);

  it("модель без кода процесса — правил Соглашения нет (как раньше)", () => {
    const r = rules(purchaseModel());
    for (const x of ["process_code_format", "structure_depth", "operation_no_bpmn", "role_no_owner", "role_no_executor"]) expect(r).not.toContain(x);
  });

  it("неверный формат кода", () => {
    const m = structuredModel();
    m.process.code = "Z1";
    expect(rules(m)).toContain("process_code_format");
  });

  it("операции без BPMN и без исполнителя, подпроцесс без владельца", () => {
    const issues = validateModel(structuredModel());
    const by = (rule: string) => issues.filter((i) => i.rule === rule).map((i) => i.element_id);
    expect(by("operation_no_bpmn")).toEqual(["o2", "o3"]); // у o1 диаграмма есть
    expect(by("role_no_executor")).toEqual(["o2"]); // у o1 и o3 исполнитель назначен
    expect(by("role_no_owner")).toEqual([]); // владельцы процесса и обоих подпроцессов назначены
    const m = structuredModel();
    m.assignments = m.assignments.filter((a) => !(a.kind === "owner" && a.node_id === "s2"));
    expect(validateModel(m).filter((i) => i.rule === "role_no_owner").map((i) => i.element_id)).toEqual(["s2"]);
    m.assignments = m.assignments.filter((a) => a.node_id !== null);
    expect(validateModel(m).some((i) => i.rule === "role_no_owner" && i.element_id === null)).toBe(true);
  });

  it("несколько владельцев одной функции", () => {
    const m = structuredModel();
    m.assignments.push({ node_id: "s1", role_id: "r3", kind: "owner", functions: [] });
    expect(validateModel(m).filter((i) => i.rule === "role_multiple_owner").map((i) => i.element_id)).toEqual(["s1"]);
  });

  it("глубже операции IDEF0 не декомпозируется", () => {
    const m = structuredModel();
    m.nodes.push({ ...m.nodes[2], id: "x1", name: "Подоперация", idef0_parent: "o1", status: "confirmed" } as never);
    expect(validateModel(m).filter((i) => i.rule === "structure_depth").map((i) => i.element_id)).toEqual(["x1"]);
  });

  it("проверки потока BPMN идут по диаграммам: замечание подписано кодом операции, пустая схема процесса — не ошибка", () => {
    const m = structuredModel();
    m.flows = m.flows.filter((f) => f.id !== "bf3"); // у шага «Внести код процесса» нет продолжения
    const issues = validateModel(m).filter((i) => i.notation === "BPMN");
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((i) => i.message.startsWith("[B002.01.01]"))).toBe(true);
    expect(issues.some((i) => i.rule === "bpmn_no_start" && i.message.includes("нет ни одного элемента"))).toBe(false);
  });
});

describe("повторная обработка сохраняет ролевую модель", () => {
  it("назначения, шаги операции и карточки переносятся в новую модель", () => {
    const prev = structuredModel();
    prev.roles[1].qualification = "Опыт моделирования от 1 года";
    prev.nodes.forEach((n) => (n.source = n.id.startsWith("b") ? [] : [{ fragment_id: "f1", quote: "q" }]));
    const next = structuredModel();
    next.assignments = [];
    next.nodes = next.nodes.filter((n) => !n.bpmn_scope);
    next.flows = [];
    const { model } = carryOverManualEdits(prev, next);
    expect(model.assignments.map((a) => `${a.node_id}:${a.kind}`).sort()).toEqual(["null:owner", "o1:controller", "o1:executor", "s1:owner", "s2:owner"].sort());
    expect(model.nodes.filter((n) => n.bpmn_scope).map((n) => n.id)).toEqual(["b0", "b1", "b2", "b9"]);
    expect(model.roles.find((r) => r.id === "r2")?.qualification).toBe("Опыт моделирования от 1 года");
  });
});

describe("выгрузки по операциям", () => {
  let app: Awaited<ReturnType<typeof startApp>>;
  beforeAll(async () => {
    app = await startApp();
  });
  afterAll(() => app.close());

  async function session() {
    const s = (await app.call("POST", "/sessions/blank", { meta: { processName: "Управление процессами" } })).body;
    const model = structuredModel();
    const put = await app.call("PUT", `/sessions/${s.id}/model`, model, { "X-Base-Updated-At": s.updatedAt });
    expect(put.status).toBe(200);
    return s.id as string;
  }

  it("BPMN операции по ?scope= и архив атласа", async () => {
    const id = await session();
    const one = await app.call("GET", `/sessions/${id}/export/bpmn?scope=o1`);
    expect(one.status).toBe(200);
    expect(String(one.body)).toContain("B002.01.01 Актуализация реестра процессов");
    expect((await app.call("GET", `/sessions/${id}/export/bpmn?scope=нет`)).status).toBe(404);
    const zip = await app.raw(`/sessions/${id}/export/bpmn.zip`);
    expect(zip.status).toBe(200);
    const files = Object.keys((await JSZip.loadAsync(zip.body)).files);
    expect(files).toEqual(["B002.01.01 Актуализация реестра процессов.bpmn"]); // у остальных операций диаграмм нет
  });

  it("VSDX: страницы BPMN операций и IDEF0 по коду процесса", async () => {
    const buf = await buildVsdx(structuredModel());
    const pages = await (await JSZip.loadAsync(buf)).file("visio/pages/pages.xml")!.async("string");
    const names = [...pages.matchAll(/<Page ID="\d+" NameU="([^"]+)"/g)].map((m) => m[1]);
    expect(names).toEqual(["BPMN", "BPMN B002.01.01", "IDEF0 B002.00.00 контекст", "IDEF0 B002.00.00", "IDEF0 B002.01.00", "IDEF0 B002.02.00"]);
  });
});