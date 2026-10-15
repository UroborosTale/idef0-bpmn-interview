import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { buildVsdx } from "../src/export/vsdx.js";
import { buildModelFromParsedVsdx, parseVsdx } from "../src/pipeline/vsdxImport.js";
import { demoModel } from "../src/reference/demo.js";
import { decodeVisioBpmn, type VisioProps } from "../src/shared/visioBpmn.js";

const props = (o: Record<string, string>): VisioProps => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { value: v }]));

describe("свойства BPMN фигур Visio: словарь значений", () => {
  it("тип задачи читается на русском и английском; «Нет»/None — не задан", () => {
    const task = (v: string) => decodeVisioBpmn(props({ BpmnActivityType: "Task", BpmnTaskType: v }));
    expect(task("Пользователь").taskType).toBe("user");
    expect(task("User").taskType).toBe("user");
    expect(task("Служба").taskType).toBe("service");
    expect(task("Получить").taskType).toBe("receive");
    expect(task("Создание экземпляра приема").taskType).toBe("receive");
    expect(task("Отправить").taskType).toBe("send");
    expect(task("Сценарий").taskType).toBe("script");
    expect(task("Вручную").taskType).toBe("manual");
    expect(task("Бизнес-правило").taskType).toBe("business_rule");
    expect(task("None").taskType).toBeUndefined();
    expect(task("Нет").taskType).toBeUndefined();
    expect(task("Нет").kind).toBe("task");
  });

  it("неопознанное значение не ошибка: тип не задан, причина попадает в lost", () => {
    const r = decodeVisioBpmn(props({ BpmnActivityType: "Task", BpmnTaskType: "Аннотация" }));
    expect(r.taskType).toBeUndefined();
    expect(r.lost.join()).toContain("Аннотация".toLowerCase());
  });

  it("подпроцесс и цикличность", () => {
    expect(decodeVisioBpmn(props({ BpmnActivityType: "Подпроцесс" })).kind).toBe("subprocess");
    expect(decodeVisioBpmn(props({ BpmnActivityType: "Sub-Process" })).kind).toBe("subprocess");
    const loop = (v: string) => decodeVisioBpmn(props({ BpmnActivityType: "Task", BpmnLoopType: v })).loop;
    expect(loop("Стандартная")).toBe("standard");
    expect(loop("Параллельная составная")).toBe("parallel");
    expect(loop("Последовательная составная")).toBe("sequential");
    expect(loop("None")).toBeUndefined();
  });

  it("шлюз: исключающий, включающий, параллельный, событийный; сложный и параллельный событийный — с оговоркой", () => {
    const gw = (v: string, ex = "Data") => decodeVisioBpmn(props({ BpmnGatewayType: v, BpmnExclusiveType: ex }));
    expect(gw("Оператор исключающего ИЛИ").gateway).toBe("exclusive");
    expect(gw("Exclusive").gateway).toBe("exclusive");
    expect(gw("Exclusive", "Event").gateway).toBe("event_based");
    expect(gw("Исключающее событие(создание нового экземпляра)").gateway).toBe("event_based_start");
    expect(gw("Оператор включающего ИЛИ").gateway).toBe("inclusive");
    expect(gw("Оператор И").gateway).toBe("parallel");
    expect(gw("Parallel").gateway).toBe("parallel");
    // комплексный и параллельный событийный шлюзы теперь поддерживаются: ничего не теряется
    const complex = gw("Сложный оператор");
    expect(complex.gateway).toBe("complex");
    expect(complex.lost).toEqual([]);
    const pe = gw("Параллельное событие(создание нового экземпляра)");
    expect(pe.gateway).toBe("parallel_event_based");
    expect(pe.lost).toEqual([]);
    expect(gw("Оператор И").kind).toBe("gateway");
  });

  it("событие: вид, без прерывания, генерация и триггер (из BpmnTriggerOrResult, иначе из BpmnEventDetailType)", () => {
    const ev = (t: string, trig = "None", detail?: string) => decodeVisioBpmn(props({ BpmnEventType: t, BpmnTriggerOrResult: trig, ...(detail ? { BpmnEventDetailType: detail } : {}) }));
    expect(ev("Начальное событие").position).toBe("start");
    expect(ev("Start").position).toBe("start");
    expect(ev("Завершающее событие", "Terminate").trigger).toBe("terminate");
    expect(ev("Промежуточное событие", "Message")).toMatchObject({ position: "intermediate", trigger: "message", throwing: false, nonInterrupting: false });
    expect(ev("Промежуточное (без прерывания)", "Timer")).toMatchObject({ position: "intermediate", trigger: "timer", nonInterrupting: true });
    expect(ev("Промежуточное (генерация)", "Escalation")).toMatchObject({ trigger: "escalation", throwing: true });
    expect(ev("Intermediate Throwing", "Link")).toMatchObject({ trigger: "link", throwing: true });
    expect(ev("Начальное событие", "None", "Сообщение").trigger).toBe("message");
    expect(ev("Начальное событие", "Parallel Multiple").trigger).toBe("parallel_multiple");
    expect(ev("Начальное событие", "Multiple").trigger).toBe("multiple");
    expect(ev("Промежуточное событие", "Compensation").trigger).toBe("compensation");
    expect(ev("Промежуточное событие", "Нет").trigger).toBeUndefined();
    expect(ev("Начальное событие").kind).toBe("event");
  });

  it("поток: управления, сообщений, ассоциация; условие и «по умолчанию»", () => {
    const fl = (t: string, c = "None") => decodeVisioBpmn(props({ BpmnConnectingObjectType: t, BpmnConditionType: c }));
    expect(fl("Поток управления")).toMatchObject({ kind: "flow", flowType: "sequence" });
    expect(fl("Поток управления").condition).toBeUndefined();
    expect(fl("Поток сообщений").flowType).toBe("message");
    expect(fl("Ассоциация").flowType).toBe("association");
    expect(fl("Поток управления", "Выражение").condition).toBe("expression");
    expect(fl("Поток управления", "По умолчанию").condition).toBe("default");
    expect(fl("Sequence Flow", "Default").condition).toBe("default");
    expect(fl("Sequence Flow", "None").condition).toBeUndefined();
  });

  it("фигура без свойств Bpmn* и артефакты", () => {
    expect(decodeVisioBpmn({})).toEqual({ lost: [] });
    expect(decodeVisioBpmn(props({ BpmnElementType: "Артефакт" })).kind).toBe("ignore");
  });
});

// --- импорт файла: мастера со свойствами, экземпляры переопределяют часть ячеек ---

const NS = `xmlns="http://schemas.microsoft.com/office/visio/2012/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`;
const c = (n: string, v: number | string) => `<Cell N="${n}" V="${v}"/>`;
const propSection = (o: Record<string, string>) => `<Section N="Property">${Object.entries(o).map(([k, v]) => `<Row N="${k}">${c("Value", v)}</Row>`).join("")}</Section>`;
const shape = (id: number, o: { master?: number; x: number; y: number; w: number; h: number; text?: string; props?: Record<string, string> }) =>
  `<Shape ID="${id}" ${o.master ? `Master="${o.master}" ` : ""}Type="Shape">${c("PinX", o.x)}${c("PinY", o.y)}${c("Width", o.w)}${c("Height", o.h)}${c("LocPinX", o.w / 2)}${c("LocPinY", o.h / 2)}${o.props ? propSection(o.props) : ""}${o.text ? `<Text>${o.text}</Text>` : ""}</Shape>`;
const flow = (id: number, b: [number, number], e: [number, number], o: { text?: string; props?: Record<string, string> } = {}) =>
  `<Shape ID="${id}" Master="9" Type="Shape">${c("BeginX", b[0])}${c("BeginY", b[1])}${c("EndX", e[0])}${c("EndY", e[1])}${c("BeginArrow", 0)}${c("EndArrow", 13)}${o.props ? propSection(o.props) : ""}${o.text ? `<Text>${o.text}</Text>` : ""}</Shape>`;
const connect = (from: number, end: "Begin" | "End", to: number) => `<Connect FromSheet="${from}" FromCell="${end}X" FromPart="${end === "Begin" ? 9 : 12}" ToSheet="${to}" ToCell="PinX" ToPart="3"/>`;

/** Мастера как в трафарете «BPMN»: в каждом — свойства по умолчанию (в кэше у списков английский токен). */
const MASTERS: [string, Record<string, string>][] = [
  ["Задача", { BpmnActivityType: "Task", BpmnTaskType: "None", BpmnLoopType: "None" }],
  ["Шлюз", { BpmnGatewayType: "Exclusive", BpmnExclusiveType: "Data" }],
  ["Промежуточное событие", { BpmnEventType: "Intermediate", BpmnTriggerOrResult: "None" }],
  ["Завершающее событие", { BpmnEventType: "End", BpmnTriggerOrResult: "None" }],
  ["Начальное событие", { BpmnEventType: "Start", BpmnTriggerOrResult: "None" }],
  ["Примечание", { BpmnElementType: "Artifact" }],
  ["Пул или дорожка", { BpmnPoolElementType: "Pool" }],
  ["Хранилище данных", { BpmnElementType: "Artifact" }],
  ["Поток управления", { BpmnConnectingObjectType: "Sequence Flow", BpmnConditionType: "None" }],
];
const M = { task: 1, gateway: 2, mid: 3, end: 4, start: 5, note: 6 };

async function stencilFile(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("visio/document.xml", `<VisioDocument ${NS}/>`);
  zip.file("visio/masters/masters.xml", `<Masters ${NS}>${MASTERS.map(([n], i) => `<Master ID="${i + 1}" NameU="${n}" Name="${n}"><Rel r:id="rId${i + 1}"/></Master>`).join("")}</Masters>`);
  zip.file("visio/masters/_rels/masters.xml.rels", `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${MASTERS.map((_, i) => `<Relationship Id="rId${i + 1}" Type="x" Target="master${i + 1}.xml"/>`).join("")}</Relationships>`);
  MASTERS.forEach(([, p], i) => zip.file(`visio/masters/master${i + 1}.xml`, `<MasterContents ${NS}><Shapes><Shape ID="1" Type="Shape">${propSection(p)}</Shape></Shapes></MasterContents>`));
  zip.file("visio/pages/pages.xml", `<Pages ${NS}><Page ID="0" NameU="Заказ" Name="Заказ"><PageSheet>${c("PageWidth", 14)}${c("PageHeight", 8)}</PageSheet><Rel r:id="rId1"/></Page></Pages>`);
  zip.file("visio/pages/_rels/pages.xml.rels", `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="x" Target="page1.xml"/></Relationships>`);
  zip.file(
    "visio/pages/page1.xml",
    `<PageContents ${NS}><Shapes>` +
      // верхний ряд: старт по таймеру → пользовательская задача → параллельный шлюз → отправка (цикл) → конец с завершением
      shape(10, { master: M.start, x: 1, y: 6, w: 0.4, h: 0.4, text: "Старт", props: { BpmnTriggerOrResult: "Timer" } }) +
      shape(11, { master: M.task, x: 3, y: 6, w: 1.5, h: 0.8, text: "Принять заказ", props: { BpmnTaskType: "Пользователь" } }) +
      shape(12, { master: M.gateway, x: 5, y: 6, w: 0.6, h: 0.6, text: "Параллельно", props: { BpmnGatewayType: "Оператор И" } }) +
      shape(13, { master: M.task, x: 7, y: 6, w: 1.5, h: 0.8, text: "Отправить счёт", props: { BpmnTaskType: "Отправить", BpmnLoopType: "Стандартная" } }) +
      shape(14, { master: M.end, x: 9.5, y: 6, w: 0.4, h: 0.4, text: "Готово", props: { BpmnTriggerOrResult: "Terminate" } }) +
      // граничное событие на нижней кромке задачи 13: таймер без прерывания
      shape(15, { master: M.mid, x: 7, y: 5.6, w: 0.4, h: 0.4, text: "Просрочка", props: { BpmnEventType: "Промежуточное (без прерывания)", BpmnTriggerOrResult: "Timer" } }) +
      // нижний ряд: ветка «по умолчанию» и шаг с неопознанным типом
      shape(16, { master: M.task, x: 5, y: 3, w: 1.5, h: 0.8, text: "Запасной путь", props: { BpmnTaskType: "Аннотация" } }) +
      shape(17, { master: M.note, x: 11, y: 3, w: 1.5, h: 0.8, text: "Примечание к заказу" }) +
      flow(30, [1.2, 6], [2.25, 6]) +
      flow(31, [3.75, 6], [4.7, 6]) +
      flow(32, [5.3, 6], [6.25, 6], { text: "да", props: { BpmnConditionType: "Выражение" } }) +
      flow(33, [7.75, 6], [9.3, 6]) +
      flow(34, [5, 5.7], [5, 3.4], { props: { BpmnConditionType: "По умолчанию" } }) +
      flow(35, [11, 3.4], [11, 5], { props: { BpmnConnectingObjectType: "Ассоциация" } }) +
      flow(36, [8, 5], [8, 4], { props: { BpmnConnectingObjectType: "Поток сообщений" } }) +
      `</Shapes><Connects>${[
        [30, 10, 11],
        [31, 11, 12],
        [32, 12, 13],
        [33, 13, 14],
        [34, 12, 16],
      ].map(([f, a, b]) => connect(f, "Begin", a) + connect(f, "End", b)).join("")}</Connects></PageContents>`
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

const meta = { processName: "Импорт", modelType: "AS-IS" as const, decompositionDepth: 2, notations: ["IDEF0", "BPMN"] as ("IDEF0" | "BPMN")[] };

describe("импорт Visio: свойства BPMN фигур трафарета", () => {
  it("тип задачи, шлюза, вид и триггер события, граничное без прерывания и ветка «по умолчанию» берутся из свойств", async () => {
    const { model, warnings } = buildModelFromParsedVsdx(await parseVsdx(await stencilFile()), meta);
    const n = (name: string) => model.nodes.find((x) => x.name === name)!;
    expect(n("Принять заказ")).toMatchObject({ type: "task", subtype: "user" });
    expect(n("Отправить счёт")).toMatchObject({ type: "task", subtype: "send" });
    expect(n("Параллельно")).toMatchObject({ type: "gateway", subtype: "parallel" });
    expect(n("Старт")).toMatchObject({ type: "event", subtype: "start", trigger: { type: "timer" } });
    expect(n("Готово")).toMatchObject({ type: "event", subtype: "end", trigger: { type: "terminate" } });
    const boundary = n("Просрочка");
    expect(boundary).toMatchObject({ type: "event", subtype: "intermediate", trigger: { type: "timer" }, attached_to: n("Отправить счёт").id, interrupting: false });
    // примечание — артефакт, а не шаг
    expect(model.nodes.some((x) => x.name === "Примечание к заказу")).toBe(false);
    // неопознанный тип задачи: шаг остаётся обычной задачей
    expect(n("Запасной путь")).toMatchObject({ type: "task" });
    expect(n("Запасной путь").subtype).toBeUndefined();

    const flowBetween = (a: string, b: string) => model.flows.find((f) => f.from === n(a).id && f.to === n(b).id);
    expect(flowBetween("Параллельно", "Отправить счёт")?.condition).toBe("да");
    expect(flowBetween("Параллельно", "Запасной путь")).toMatchObject({ is_default: true, condition: null });
    expect(model.flows).toHaveLength(5); // ассоциация и поток сообщений потоками управления не стали

    const text = warnings.join("\n");
    expect(text).toContain("ассоциации (1)");
    expect(text).toContain("потоки сообщений (1)");
    expect(n("Отправить счёт").loop).toBe("standard");
    expect(text).toMatch(/тип задачи «аннотация»/);
  });

  it("фигура с размером по умолчанию (Width и Height только в мастере) не теряется", async () => {
    const zip = new JSZip();
    zip.file("visio/document.xml", `<VisioDocument ${NS}/>`);
    zip.file("visio/masters/masters.xml", `<Masters ${NS}><Master ID="1" NameU="Начальное событие" Name="Начальное событие"><Rel r:id="rId1"/></Master><Master ID="2" NameU="Задача" Name="Задача"><Rel r:id="rId2"/></Master></Masters>`);
    zip.file("visio/masters/_rels/masters.xml.rels", `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="x" Target="master1.xml"/><Relationship Id="rId2" Type="x" Target="master2.xml"/></Relationships>`);
    const top = (cells: string, p: Record<string, string>) => `<MasterContents ${NS}><Shapes><Shape ID="5" Type="Group">${c("Width", 0.5)}${c("Height", 0.5)}${c("LocPinX", 0.25)}${c("LocPinY", 0.25)}${cells}${propSection(p)}</Shape></Shapes></MasterContents>`;
    zip.file("visio/masters/master1.xml", top("", { BpmnEventType: "Start", BpmnTriggerOrResult: "None" }));
    zip.file("visio/masters/master2.xml", top("", { BpmnActivityType: "Task", BpmnTaskType: "None" }));
    zip.file("visio/pages/pages.xml", `<Pages ${NS}><Page ID="0" NameU="P" Name="P"><PageSheet>${c("PageWidth", 8)}${c("PageHeight", 4)}</PageSheet><Rel r:id="rId1"/></Page></Pages>`);
    zip.file("visio/pages/_rels/pages.xml.rels", `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="x" Target="page1.xml"/></Relationships>`);
    // у экземпляров только положение: размер, как в Visio, достаётся от мастера
    const inst = (id: number, master: number, x: number, text: string) => `<Shape ID="${id}" Master="${master}" Type="Group">${c("PinX", x)}${c("PinY", 2)}<Text>${text}</Text></Shape>`;
    zip.file("visio/pages/page1.xml", `<PageContents ${NS}><Shapes>${inst(1, 1, 1, "Старт")}${inst(2, 2, 3, "Шаг")}</Shapes></PageContents>`);
    const { model } = buildModelFromParsedVsdx(await parseVsdx(await zip.generateAsync({ type: "nodebuffer" })), meta);
    expect(model.nodes.find((x) => x.name === "Старт")).toMatchObject({ type: "event", subtype: "start" });
    expect(model.nodes.find((x) => x.name === "Шаг")?.type).toBe("task");
  });

  it("строка свойства экземпляра без значения (только список Format) не затирает значение мастера", async () => {
    const zip = new JSZip();
    zip.file("visio/document.xml", `<VisioDocument ${NS}/>`);
    zip.file("visio/masters/masters.xml", `<Masters ${NS}><Master ID="1" NameU="Шлюз" Name="Шлюз"><Rel r:id="rId1"/></Master></Masters>`);
    zip.file("visio/masters/_rels/masters.xml.rels", `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="x" Target="master1.xml"/></Relationships>`);
    zip.file("visio/masters/master1.xml", `<MasterContents ${NS}><Shapes><Shape ID="5" Type="Group">${propSection({ BpmnGatewayType: "Оператор И", BpmnExclusiveType: "Данные" })}</Shape></Shapes></MasterContents>`);
    zip.file("visio/pages/pages.xml", `<Pages ${NS}><Page ID="0" NameU="P" Name="P"><PageSheet>${c("PageWidth", 8)}${c("PageHeight", 4)}</PageSheet><Rel r:id="rId1"/></Page></Pages>`);
    zip.file("visio/pages/_rels/pages.xml.rels", `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="x" Target="page1.xml"/></Relationships>`);
    // у экземпляра переопределён только список значений, само значение наследуется
    const formatOnly = `<Section N="Property"><Row N="BpmnGatewayType">${c("Format", "Исключающее ИЛИ;Оператор И")}</Row></Section>`;
    zip.file("visio/pages/page1.xml", `<PageContents ${NS}><Shapes><Shape ID="1" Master="1" Type="Group">${c("PinX", 2)}${c("PinY", 2)}${c("Width", 0.6)}${c("Height", 0.6)}${formatOnly}<Text>Ветвление</Text></Shape></Shapes></PageContents>`);
    const { model } = buildModelFromParsedVsdx(await parseVsdx(await zip.generateAsync({ type: "nodebuffer" })), meta);
    expect(model.nodes.find((x) => x.name === "Ветвление")).toMatchObject({ type: "gateway", subtype: "parallel" });
  });

  it("без свойств Bpmn* вид по-прежнему определяется по имени мастера", async () => {
    const zip = new JSZip();
    zip.file("visio/document.xml", `<VisioDocument ${NS}/>`);
    zip.file("visio/masters/masters.xml", `<Masters ${NS}>${["Task", "Decision"].map((n, i) => `<Master ID="${i + 1}" NameU="${n}" Name="${n}"/>`).join("")}</Masters>`);
    zip.file("visio/pages/pages.xml", `<Pages ${NS}><Page ID="0" NameU="P" Name="P"><PageSheet>${c("PageWidth", 8)}${c("PageHeight", 4)}</PageSheet><Rel r:id="rId1"/></Page></Pages>`);
    zip.file("visio/pages/_rels/pages.xml.rels", `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="x" Target="page1.xml"/></Relationships>`);
    zip.file("visio/pages/page1.xml", `<PageContents ${NS}><Shapes>${shape(1, { master: 1, x: 2, y: 2, w: 1.5, h: 0.8, text: "Шаг" })}${shape(2, { master: 2, x: 5, y: 2, w: 0.6, h: 0.6, text: "Ветка?" })}</Shapes></PageContents>`);
    const { model } = buildModelFromParsedVsdx(await parseVsdx(await zip.generateAsync({ type: "nodebuffer" })), meta);
    expect(model.nodes.find((x) => x.name === "Шаг")?.type).toBe("task");
    expect(model.nodes.find((x) => x.name === "Ветка?")?.type).toBe("gateway");
  });
});

describe("экспорт VSDX: свойства BPMN в «Данных фигуры» Visio", () => {
  it("фигуры несут раздел Property с теми же именами и значениями, что в трафарете", async () => {
    const zip = await JSZip.loadAsync(await buildVsdx(demoModel()));
    const pages = await Promise.all(Object.keys(zip.files).filter((n) => /^visio\/pages\/page\d+\.xml$/.test(n)).map((n) => zip.file(n)!.async("string")));
    const xml = pages.join(" ");
    for (const name of ["BpmnActivityType", "BpmnTaskType", "BpmnGatewayType", "BpmnExclusiveType", "BpmnEventType", "BpmnTriggerOrResult", "BpmnConnectingObjectType", "BpmnConditionType"]) {
      expect(xml, name).toContain(`<Row N="${name}">`);
    }
    // значение выбирается из списка (Type 1) и входит в него
    const row = xml.match(/<Row N="BpmnEventType"><Cell N="Value" V="([^"]*)"[^>]*\/>.*?<Cell N="Format" V="([^"]*)"/s)!;
    expect(row[2].split(";")).toContain(row[1]);
    expect(xml).toMatch(/<Cell N="Type" V="1"\/>/);
  });

  it("круговой обмен: подтип задачи, тип шлюза, вид и триггер события возвращаются из файла", async () => {
    const src = demoModel();
    const { model } = buildModelFromParsedVsdx(await parseVsdx(await buildVsdx(src)), meta);
    const find = (name: string, type: string) => model.nodes.find((n) => n.name === name && n.type === type);
    let tasks = 0;
    let gateways = 0;
    let triggers = 0;
    for (const n of src.nodes) {
      const got = find(n.name, n.type);
      if (!got) continue;
      if (n.type === "task" && n.subtype) {
        expect(got.subtype, n.name).toBe(n.subtype);
        tasks++;
      }
      if (n.type === "gateway" && n.subtype) {
        expect(got.subtype, n.name).toBe(n.subtype);
        gateways++;
      }
      if (n.type === "event" && n.trigger && n.trigger.type !== "none") {
        expect(got.trigger?.type, n.name).toBe(n.trigger.type);
        if (n.trigger.name) expect(got.trigger?.name, n.name).toBe(n.trigger.name);
        triggers++;
      }
    }
    expect(tasks + gateways + triggers).toBeGreaterThan(0);
  });
});
