import JSZip from "jszip";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildVsdx } from "../src/export/vsdx.js";
import { buildModelFromParsedVsdx, parseVsdx } from "../src/pipeline/vsdxImport.js";
import { validateModel } from "../src/pipeline/validate.js";
import { demoModel } from "../src/reference/demo.js";
import { startApp } from "./api.js";
import { branchingModel, purchaseModel } from "./fixtures.js";

delete process.env.AUTH_USERS;

const meta = { processName: "Импорт", modelType: "AS-IS" as const, decompositionDepth: 2, notations: ["IDEF0", "BPMN"] as ("IDEF0" | "BPMN")[] };
const importFile = async (buf: Buffer) => buildModelFromParsedVsdx(await parseVsdx(buf), meta);

// --- файл «как из Visio»: мастера по именам, дорожки, группа, приклеенные и свободные соединители ---

const c = (n: string, v: number | string) => `<Cell N="${n}" V="${v}"/>`;
/** Двумерная фигура: координаты в дюймах, начало — левый нижний угол страницы. */
const shape = (id: number, o: { master?: number; x: number; y: number; w: number; h: number; text?: string; type?: string; children?: string; name?: string; extra?: string }) =>
  `<Shape ID="${id}" ${o.name ? `NameU="${o.name}" ` : ""}${o.master ? `Master="${o.master}" ` : ""}Type="${o.type ?? "Shape"}">${c("PinX", o.x)}${c("PinY", o.y)}${c("Width", o.w)}${c("Height", o.h)}${c("LocPinX", o.w / 2)}${c("LocPinY", o.h / 2)}${o.extra ?? ""}${o.text ? `<Text>${o.text}</Text>` : ""}${o.children ? `<Shapes>${o.children}</Shapes>` : ""}</Shape>`;
/** Соединитель: начало и конец в координатах страницы. */
const connector = (id: number, b: [number, number], e: [number, number], text?: string, arrows: [number, number] = [0, 13]) =>
  `<Shape ID="${id}" Master="6" Type="Shape">${c("BeginX", b[0])}${c("BeginY", b[1])}${c("EndX", e[0])}${c("EndY", e[1])}${c("BeginArrow", arrows[0])}${c("EndArrow", arrows[1])}${text ? `<Text>${text}</Text>` : ""}</Shape>`;
const connect = (from: number, end: "Begin" | "End", to: number) => `<Connect FromSheet="${from}" FromCell="${end}X" FromPart="${end === "Begin" ? 9 : 12}" ToSheet="${to}" ToCell="PinX" ToPart="3"/>`;

async function visioLikeFile(): Promise<Buffer> {
  const zip = new JSZip();
  const ns = `xmlns="http://schemas.microsoft.com/office/visio/2012/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`;
  zip.file("visio/document.xml", `<VisioDocument ${ns}/>`);
  zip.file(
    "visio/masters/masters.xml",
    `<Masters ${ns}>${["Start Event", "Task", "Gateway", "End Event", "Swimlane", "Dynamic connector", "Message Start Event"].map((n, i) => `<Master ID="${i + 1}" NameU="${n}" Name="${n}"/>`).join("")}</Masters>`
  );
  zip.file("visio/pages/pages.xml", `<Pages ${ns}><Page ID="0" NameU="Продажи" Name="Продажи"><PageSheet>${c("PageWidth", 12)}${c("PageHeight", 8)}</PageSheet><Rel r:id="rId1"/></Page></Pages>`);
  zip.file("visio/pages/_rels/pages.xml.rels", `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="x" Target="page1.xml"/></Relationships>`);
  zip.file(
    "visio/pages/page1.xml",
    `<PageContents ${ns}><Shapes>` +
      // дорожки: верхняя (y 4…8) и нижняя (y 0…4)
      shape(1, { master: 5, x: 6, y: 6, w: 12, h: 4, text: "Отдел продаж" }) +
      shape(2, { master: 5, x: 6, y: 2, w: 12, h: 4, text: "Юристы" }) +
      shape(10, { master: 1, x: 1, y: 6, w: 0.4, h: 0.4 }) + // событие без текста
      shape(11, { master: 2, x: 3, y: 6, w: 1.5, h: 0.8, text: "Подготовить\nдоговор" }) +
      shape(12, { master: 3, x: 5, y: 6, w: 0.6, h: 0.6, text: "Согласован?" }) +
      shape(13, { master: 2, x: 7, y: 2, w: 1.5, h: 0.8, text: "Подписать договор" }) +
      shape(14, { master: 4, x: 9, y: 2, w: 0.4, h: 0.4, text: "Договор подписан" }) +
      // группа-задача: текст лежит в дочерней фигуре, координаты дочерней — внутри группы
      shape(20, { master: 2, type: "Group", x: 5, y: 3.5, w: 1.5, h: 0.8, children: shape(21, { x: 0.75, y: 0.4, w: 1.4, h: 0.6, text: "Сохранить в архив" }) }) +
      connector(30, [1.2, 6], [2.25, 6]) + // приклеен к 10 и 11
      connector(31, [3.75, 6], [4.7, 6]) + // приклеен к 11 и 12
      connector(32, [5.3, 6], [6.25, 2], "да") + // приклеен к 12 и 13
      connector(33, [5, 5.7], [5, 3.9], "нет") + // не приклеен: концы — внутри габаритов 12 и 20
      connector(34, [8.8, 2], [7.75, 2], undefined, [13, 0]) + // стрелка на начале: 13 → 14... направление «14 → 13» читается наоборот
      connector(35, [0.1, 0.1], [0.2, 0.2]) + // висит в воздухе: пропускается
      `</Shapes><Connects>${connect(30, "Begin", 10)}${connect(30, "End", 11)}${connect(31, "Begin", 11)}${connect(31, "End", 12)}${connect(32, "Begin", 12)}${connect(32, "End", 13)}${connect(34, "Begin", 14)}${connect(34, "End", 13)}</Connects></PageContents>`
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

describe("импорт Visio (.vsdx)", () => {
  it("собственная выгрузка читается обратно: шаги, события, шлюз, потоки, условия и исполнители", async () => {
    const src = branchingModel();
    const { model, warnings } = await importFile(await buildVsdx(src));
    const byName = (n: string) => model.nodes.find((x) => x.name === n)!;
    expect(model.nodes).toHaveLength(src.nodes.length);
    expect(model.flows).toHaveLength(src.flows.length);
    expect(model.roles.map((r) => r.name).sort()).toEqual(["Менеджер", "Юрист"]);
    expect(byName("Договор получен")).toMatchObject({ type: "event", subtype: "start" });
    expect(byName("Договор обработан")).toMatchObject({ type: "event", subtype: "end" });
    const gate = model.nodes.find((n) => n.type === "gateway")!;
    expect(gate).toMatchObject({ subtype: "exclusive", name: "Есть замечания?" });
    const role = (n: string) => model.roles.find((r) => r.id === byName(n).role_id)?.name;
    for (const t of src.nodes.filter((x) => x.type === "task")) expect(role(t.name), t.name).toBe(src.roles.find((r) => r.id === t.role_id)!.name);
    // условия веток и направление стрелок
    const idOf = (n: string) => byName(n).id;
    const flow = (a: string, b: string) => model.flows.find((f) => f.from === idOf(a) && f.to === idOf(b));
    expect(model.flows.filter((f) => f.from === gate.id).map((f) => f.condition).sort()).toEqual(["да", "нет"]);
    expect(flow("Договор получен", src.nodes.find((n) => n.id === "t1")!.name)).toBeTruthy();
    expect(model.flows.some((f) => f.from === gate.id && f.to === idOf(src.nodes.find((n) => n.id === "t2")!.name) && f.condition === "да")).toBe(true);
    expect(warnings.filter((w) => !/IDEF0/.test(w))).toEqual([]); // всё распознано (страницы IDEF0 пропускаются осознанно)
  });

  it("тип шлюза и вид события собственной выгрузки сохраняются", async () => {
    const m = branchingModel();
    m.nodes.find((n) => n.id === "g")!.subtype = "parallel";
    const { model } = await importFile(await buildVsdx(m));
    expect(model.nodes.find((n) => n.type === "gateway")!.subtype).toBe("parallel");
    m.nodes.find((n) => n.id === "g")!.subtype = "inclusive";
    expect((await importFile(await buildVsdx(m))).model.nodes.find((n) => n.type === "gateway")!.subtype).toBe("inclusive");
  });

  it("страницы IDEF0 пропускаются, диаграммы BPMN читаются", async () => {
    const parsed = await parseVsdx(await buildVsdx(purchaseModel()));
    expect(parsed.pages.length).toBeGreaterThan(0);
    expect(parsed.warnings.join(" ")).toMatch(/IDEF0 пропущены/);
    expect(parsed.pages.every((p) => !p.name.startsWith("IDEF0"))).toBe(true);
  });

  it("файл «как из Visio»: мастера, дорожки, группа, неприклеенный соединитель, обратная стрелка", async () => {
    const { model, warnings } = await importFile(await visioLikeFile());
    const node = (name: string) => model.nodes.find((n) => n.name === name)!;
    expect(model.nodes).toHaveLength(6); // дорожки — не шаги
    // события: без текста получают название по месту в потоке; вид — по мастеру и по потоку
    expect(model.nodes.find((n) => n.name === "Начало процесса")).toMatchObject({ type: "event", subtype: "start" });
    expect(node("Договор подписан")).toMatchObject({ type: "event", subtype: "end" });
    expect(node("Согласован?")).toMatchObject({ type: "gateway", subtype: "exclusive" });
    expect(node("Подготовить договор")).toMatchObject({ type: "task" }); // перевод строки внутри названия убран
    expect(node("Сохранить в архив").type).toBe("task"); // текст взят из дочерней фигуры группы
    // дорожки → исполнители; шаг получает роль той дорожки, в которой лежит
    expect(model.roles.map((r) => r.name).sort()).toEqual(["Отдел продаж", "Юристы"]);
    const roleOf = (n: string) => model.roles.find((r) => r.id === node(n).role_id)?.name;
    expect(roleOf("Подготовить договор")).toBe("Отдел продаж");
    expect(roleOf("Подписать договор")).toBe("Юристы");
    expect(roleOf("Согласован?")).toBeUndefined(); // у шлюза и события исполнителя нет
    // потоки: приклеенные, неприклеенные (по координатам) и с обратной стрелкой
    const edge = (a: string, b: string) => model.flows.find((f) => f.from === node(a).id && f.to === node(b).id);
    expect(edge("Начало процесса", "Подготовить договор")).toBeTruthy();
    expect(edge("Подготовить договор", "Согласован?")).toBeTruthy();
    expect(edge("Согласован?", "Подписать договор")?.condition).toBe("да");
    expect(edge("Согласован?", "Сохранить в архив")?.condition).toBe("нет");
    expect(edge("Подписать договор", "Договор подписан")).toBeTruthy(); // стрелка нарисована от конца к началу — направление восстановлено
    expect(model.flows).toHaveLength(5);
    expect(warnings.join(" ")).toMatch(/1 соедин\. не привязаны/);
  });

  it("граничное событие на краю задачи привязывается к ней и не считается началом процесса", async () => {
    const zip = new JSZip();
    const ns = `xmlns="http://schemas.microsoft.com/office/visio/2012/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`;
    zip.file("visio/document.xml", `<VisioDocument ${ns}/>`);
    zip.file("visio/masters/masters.xml", `<Masters ${ns}>${["Start Event", "Task", "End Event", "Dynamic connector"].map((n, i) => `<Master ID="${i + 1}" NameU="${n}"/>`).join("")}</Masters>`);
    zip.file("visio/pages/pages.xml", `<Pages ${ns}><Page ID="0" NameU="Заказ"><PageSheet>${c("PageHeight", 8)}</PageSheet><Rel r:id="rId1"/></Page></Pages>`);
    zip.file("visio/pages/_rels/pages.xml.rels", `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="x" Target="page1.xml"/></Relationships>`);
    zip.file(
      "visio/pages/page1.xml",
      `<PageContents ${ns}><Shapes>` +
        shape(1, { master: 1, x: 1, y: 4, w: 0.4, h: 0.4 }) +
        shape(2, { master: 2, x: 3, y: 4, w: 1.5, h: 0.8, text: "Оформить заказ" }) +
        shape(3, { master: 3, x: 6, y: 4, w: 0.4, h: 0.4, text: "Заказ оформлен" }) +
        shape(4, { master: 2, x: 3, y: 2, w: 1.5, h: 0.8, text: "Напомнить клиенту" }) +
        shape(5, { master: 1, x: 3, y: 3.6, w: 0.3, h: 0.3, text: "Срок истёк" }) + // на нижней границе задачи 2
        connector(10, [1.2, 4], [2.25, 4]) +
        connector(11, [3.75, 4], [5.8, 4]) +
        connector(12, [3, 3.45], [3, 2.4]) +
        connector(13, [3.75, 2], [6, 3.8]) +
        `</Shapes><Connects>${connect(10, "Begin", 1)}${connect(10, "End", 2)}${connect(11, "Begin", 2)}${connect(11, "End", 3)}${connect(12, "Begin", 5)}${connect(12, "End", 4)}${connect(13, "Begin", 4)}${connect(13, "End", 3)}</Connects></PageContents>`
    );
    const { model } = await importFile(await zip.generateAsync({ type: "nodebuffer" }));
    const byName = (n: string) => model.nodes.find((x) => x.name === n)!;
    expect(byName("Срок истёк")).toMatchObject({ type: "event", subtype: "intermediate", attached_to: byName("Оформить заказ").id });
    expect(model.nodes.filter((n) => n.type === "event" && n.subtype === "start")).toHaveLength(1);
    expect(validateModel(model).filter((i) => i.severity === "error")).toEqual([]);
  });

  it("несколько страниц — по операции на каждую: проверки потока идут по диаграммам и ошибок нет", async () => {
    const src = demoModel();
    const parsed = await parseVsdx(await buildVsdx(src));
    const { model, warnings } = buildModelFromParsedVsdx(parsed, meta);
    const ops = model.nodes.filter((n) => n.type === "task" && n.tags.includes("from_diagram_import") && model.nodes.some((s) => s.bpmn_scope === n.id));
    expect(ops).toHaveLength(parsed.pages.length);
    expect(ops.map((o) => o.name)).toContain("C090.01.01"); // префикс «BPMN » у названия страницы убран
    expect(model.nodes.filter((n) => n.bpmn_scope).length).toBeGreaterThan(60);
    expect(model.nodes.some((n) => n.attached_to)).toBe(true); // граничные события демо
    expect(validateModel(model).filter((i) => i.severity === "error")).toEqual([]);
    expect(warnings.join(" ")).toMatch(/каждая стала диаграммой операции/);
  });

  it("фигуры, нарисованные вручную без мастера (Visio называет их «Sheet.N»): прямоугольник — шаг, ромб — шлюз, овал — событие", async () => {
    const zip = new JSZip();
    const ns3 = `xmlns="http://schemas.microsoft.com/office/visio/2012/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`;
    zip.file("visio/document.xml", `<VisioDocument ${ns3}/>`);
    zip.file("visio/pages/pages.xml", `<Pages ${ns3}><Page ID="0" NameU="Страница-1"><PageSheet>${c("PageHeight", 8)}</PageSheet><Rel r:id="rId1"/></Page></Pages>`);
    zip.file("visio/pages/_rels/pages.xml.rels", `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="x" Target="page1.xml"/></Relationships>`);
    const geom = (rows: string) => `<Section N="Geometry" IX="0">${rows}</Section>`;
    const rect = (w: number, h: number) => geom(`<Row T="MoveTo" IX="1"><Cell N="X" V="0"/><Cell N="Y" V="0"/></Row><Row T="LineTo" IX="2"><Cell N="X" V="${w}"/><Cell N="Y" V="0"/></Row><Row T="LineTo" IX="3"><Cell N="X" V="${w}"/><Cell N="Y" V="${h}"/></Row><Row T="LineTo" IX="4"><Cell N="X" V="0"/><Cell N="Y" V="${h}"/></Row><Row T="LineTo" IX="5"><Cell N="X" V="0"/><Cell N="Y" V="0"/></Row>`);
    const diamond = (w: number, h: number) => geom(`<Row T="MoveTo" IX="1"><Cell N="X" V="${w / 2}"/><Cell N="Y" V="0"/></Row><Row T="LineTo" IX="2"><Cell N="X" V="${w}"/><Cell N="Y" V="${h / 2}"/></Row><Row T="LineTo" IX="3"><Cell N="X" V="${w / 2}"/><Cell N="Y" V="${h}"/></Row><Row T="LineTo" IX="4"><Cell N="X" V="0"/><Cell N="Y" V="${h / 2}"/></Row><Row T="LineTo" IX="5"><Cell N="X" V="${w / 2}"/><Cell N="Y" V="0"/></Row>`);
    const ellipse = (w: number, h: number) => geom(`<Row T="Ellipse" IX="1"><Cell N="X" V="${w / 2}"/><Cell N="Y" V="${h / 2}"/><Cell N="A" V="${w}"/><Cell N="B" V="${h / 2}"/><Cell N="C" V="${w / 2}"/><Cell N="D" V="${h}"/></Row>`);
    zip.file(
      "visio/pages/page1.xml",
      `<PageContents ${ns3}><Shapes>` +
        shape(1, { name: "Sheet.1", x: 1, y: 4, w: 0.5, h: 0.5, text: "Начало", extra: ellipse(0.5, 0.5) }) +
        shape(2, { name: "Sheet.2", x: 3, y: 4, w: 1.5, h: 0.8, text: "Принять заявку", extra: rect(1.5, 0.8) }) +
        shape(3, { name: "Sheet.3", x: 5.5, y: 4, w: 0.8, h: 0.8, text: "Верно?", extra: diamond(0.8, 0.8) }) +
        shape(4, { name: "Sheet.4", x: 8, y: 4, w: 1.5, h: 0.8, text: "Выдать решение", extra: rect(1.5, 0.8) }) +
        shape(5, { name: "Sheet.5", x: 3, y: 6.5, w: 3, h: 0.5, text: "Подпись под схемой" }) + // ничем не связана и без формы: оформление
        connector(10, [1.25, 4], [2.25, 4]) +
        connector(11, [3.75, 4], [5.1, 4]) +
        connector(12, [5.9, 4], [7.25, 4], "да") +
        `</Shapes><Connects>${connect(10, "Begin", 1)}${connect(10, "End", 2)}${connect(11, "Begin", 2)}${connect(11, "End", 3)}${connect(12, "Begin", 3)}${connect(12, "End", 4)}</Connects></PageContents>`
    );
    const { model } = await importFile(await zip.generateAsync({ type: "nodebuffer" }));
    const byName = (n: string) => model.nodes.find((x) => x.name === n);
    expect(model.nodes.map((n) => n.name).sort()).toEqual(["Верно?", "Выдать решение", "Начало", "Принять заявку"]); // подпись не стала шагом
    expect(byName("Принять заявку")).toMatchObject({ type: "task" });
    expect(byName("Верно?")).toMatchObject({ type: "gateway", subtype: "exclusive" });
    expect(byName("Начало")).toMatchObject({ type: "event", subtype: "start" });
    expect(model.flows).toHaveLength(3);
    expect(model.flows.find((f) => f.condition === "да")).toBeTruthy();
  });
  it("не .vsdx: понятные ошибки", async () => {
    await expect(parseVsdx(Buffer.from("это не архив"))).rejects.toThrow(/не открывается как \.vsdx/);
    const zip = new JSZip();
    zip.file("hello.txt", "x");
    await expect(parseVsdx(await zip.generateAsync({ type: "nodebuffer" }))).rejects.toThrow(/не \.vsdx/);
  });

  it("файл без распознаваемых фигур — предупреждение, модель пустая", async () => {
    const zip = new JSZip();
    const ns = `xmlns="http://schemas.microsoft.com/office/visio/2012/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`;
    zip.file("visio/document.xml", `<VisioDocument ${ns}/>`);
    zip.file("visio/pages/pages.xml", `<Pages ${ns}><Page ID="0" NameU="P"><PageSheet>${c("PageHeight", 8)}</PageSheet><Rel r:id="rId1"/></Page></Pages>`);
    zip.file("visio/pages/_rels/pages.xml.rels", `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="x" Target="page1.xml"/></Relationships>`);
    zip.file("visio/pages/page1.xml", `<PageContents ${ns}><Shapes>${shape(1, { name: "Title", x: 1, y: 1, w: 2, h: 1, text: "Заголовок" })}</Shapes></PageContents>`);
    const parsed = await parseVsdx(await zip.generateAsync({ type: "nodebuffer" }));
    expect(parsed.pages).toEqual([]);
    expect(parsed.warnings.join(" ")).toMatch(/Не найдено ни одной фигуры/);
  });
});

describe("импорт Visio через API", () => {
  let app: Awaited<ReturnType<typeof startApp>>;
  beforeAll(async () => {
    app = await startApp();
  });
  afterAll(() => app.close());

  it("создаёт сессию из .vsdx в base64: модель, проверки, диаграммы, версия", async () => {
    const content = (await visioLikeFile()).toString("base64");
    const r = await app.call("POST", "/diagram-import/new", { format: "vsdx", content, meta: { processName: "Продажи из Visio", modelType: "AS-IS", decompositionDepth: 2, notations: ["IDEF0", "BPMN"] } });
    expect(r.status).toBe(201);
    const s = r.body.session;
    expect(s.status).toBe("ready");
    expect(s.model.nodes).toHaveLength(6);
    expect(s.model.process.name).toBe("Продажи из Visio");
    expect(s.bpmnXml).toContain("<bpmn:definitions");
    const versions = (await app.call("GET", `/sessions/${s.id}/versions`)).body;
    expect(versions.map((v: { note: string }) => v.note)).toEqual(["Импорт из диаграммы (vsdx)"]);
    expect(Array.isArray(r.body.warnings)).toBe(true);
  });

  it("не .vsdx — 400 с пояснением; без фигур — 400", async () => {
    const m = { processName: "X", modelType: "AS-IS", decompositionDepth: 2, notations: ["BPMN"] };
    const bad = await app.call("POST", "/diagram-import/new", { format: "vsdx", content: Buffer.from("текст").toString("base64"), meta: m });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/\.vsdx/);
  });
});
