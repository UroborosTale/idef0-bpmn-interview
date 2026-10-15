import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { buildVsdx } from "../src/export/vsdx.js";
import { applyDeletions, applyIdef0Edits, applySheetEdits, parseVsdx, reconcileVsdxEdit } from "../src/pipeline/vsdxImport.js";
import { structuredModel } from "./fixtures.js";

/** Правка файла так, как её делает Visio: меняется содержимое страницы внутри пакета. */
async function edit(buf: Buffer, page: number, fn: (xml: string) => string): Promise<Buffer> {
  const zip = await JSZip.loadAsync(buf);
  const name = `visio/pages/page${page}.xml`;
  zip.file(name, fn(await zip.file(name)!.async("string")), { createFolders: false });
  return zip.generateAsync({ type: "nodebuffer" });
}

/** Номер страницы файла по её названию. */
async function pageNo(buf: Buffer, title: string): Promise<number> {
  const xml = await (await JSZip.loadAsync(buf)).file("visio/pages/pages.xml")!.async("string");
  const names = [...xml.matchAll(/<Page ID="\d+" NameU="([^"]+)"/g)].map((m) => m[1]);
  const i = names.indexOf(title);
  if (i < 0) throw new Error(`нет страницы ${title}: ${names.join(", ")}`);
  return i + 1;
}

describe("правки из Visio в существующую модель", () => {
  it("файл без правок ничего не меняет", async () => {
    const m = structuredModel();
    const parsed = await parseVsdx(await buildVsdx(m));
    const { model, changes } = reconcileVsdxEdit(m, parsed);
    expect(changes).toEqual({ renamed: [], added: [], addedFlows: [], flowsRenamed: [], missing: [], missingFlows: [], shapeMap: [], flowMap: [] });
    expect(model.nodes.map((n) => n.name)).toEqual(m.nodes.map((n) => n.name));
    expect(model.flows).toHaveLength(m.flows.length);
  });

  it("переименование шага и условия стрелки в Visio возвращается в модель; метка pm_n больше не перекрывает текст", async () => {
    const m = structuredModel();
    const buf = await buildVsdx(m);
    const task = m.nodes.find((n) => n.bpmn_scope === "o1" && n.type === "task")!;
    const page = await pageNo(buf, "BPMN B002.01.01");
    const edited = await edit(buf, page, (xml) => xml.replace(`<Text>${task.name}</Text>`, "<Text>Новое название из Visio</Text>"));
    const { model, changes } = reconcileVsdxEdit(m, await parseVsdx(edited));
    expect(changes.renamed).toEqual([{ nodeId: task.id, from: task.name, to: "Новое название из Visio" }]);
    expect(model.nodes.find((n) => n.id === task.id)!.name).toBe("Новое название из Visio");
    expect(model.nodes.find((n) => n.id === task.id)!.tags).toContain("edited_externally");
    expect(m.nodes.find((n) => n.id === task.id)!.name).toBe(task.name); // исходная модель не тронута
  });

  it("удалённая в Visio фигура только перечисляется, модель не теряет шаг", async () => {
    const m = structuredModel();
    const buf = await buildVsdx(m);
    const task = m.nodes.find((n) => n.bpmn_scope === "o1" && n.type === "task")!;
    const page = await pageNo(buf, "BPMN B002.01.01");
    const edited = await edit(buf, page, (xml) => {
      // вырезаем фигуру шага: от начала <Shape> до его конца, по метке pm_id
      const at = xml.indexOf(`<Row N="pm_id"><Cell N="Value" V="${task.id}"`);
      expect(at).toBeGreaterThan(0);
      const from = xml.lastIndexOf("<Shape ID=", at);
      return xml.slice(0, from) + xml.slice(xml.indexOf("</Shape>", at) + "</Shape>".length);
    });
    const { model, changes } = reconcileVsdxEdit(m, await parseVsdx(edited));
    expect(changes.missing).toContain(task.id);
    expect(model.nodes.some((n) => n.id === task.id)).toBe(true);
  });
});

describe("фигуры из палитры Visio (без меток pm_*)", () => {
  /** Фигура, нарисованная в Visio без меток: форма и имя, как у палитры оболочки. */
  const shape = (id: number, nameU: string, geometry: "rect" | "oval" | "diamond", text: string, cx: number, cy: number, w: number, h: number) => {
    const W = w / 96;
    const H = h / 96;
    const rows =
      geometry === "oval"
        ? `<Row T="Ellipse" IX="1"><Cell N="X" V="${W / 2}"/><Cell N="Y" V="${H / 2}"/><Cell N="A" V="${W}"/><Cell N="B" V="${H / 2}"/><Cell N="C" V="${W / 2}"/><Cell N="D" V="${H}"/></Row>`
        : geometry === "diamond"
          ? [[W / 2, H], [W, H / 2], [W / 2, 0], [0, H / 2], [W / 2, H]].map(([x, y], i) => `<Row T="${i === 0 ? "MoveTo" : "LineTo"}" IX="${i + 1}"><Cell N="X" V="${x}"/><Cell N="Y" V="${y}"/></Row>`).join("")
          : [[0, 0], [W, 0], [W, H], [0, H], [0, 0]].map(([x, y], i) => `<Row T="${i === 0 ? "MoveTo" : "LineTo"}" IX="${i + 1}"><Cell N="X" V="${x}"/><Cell N="Y" V="${y}"/></Row>`).join("");
    return `<Shape ID="${id}" NameU="${nameU}" Type="Shape"><Cell N="PinX" V="${cx / 96}"/><Cell N="PinY" V="${cy / 96}"/><Cell N="Width" V="${W}"/><Cell N="Height" V="${H}"/><Cell N="LocPinX" V="${W / 2}"/><Cell N="LocPinY" V="${H / 2}"/><Section N="Geometry" IX="0"><Cell N="NoFill" V="0"/><Cell N="NoLine" V="0"/>${rows}</Section><Text>${text}</Text></Shape>`;
  };

  it("задача, шлюзы «или» и «и», начальное и конечное события становятся новыми шагами операции; значок шлюза — не название", async () => {
    const m = structuredModel();
    const buf = await buildVsdx(m);
    const page = await pageNo(buf, "BPMN B002.01.01");
    const edited = await edit(buf, page, (xml) =>
      xml.replace(
        "</Shapes>",
        shape(9001, "Задача.40", "rect", "Новая задача", 700, 300, 150, 90) +
          shape(9002, "Шлюз «или».41", "diamond", "X", 900, 300, 50, 50) +
          shape(9003, "Шлюз «и».42", "diamond", "+", 1000, 300, 50, 50) +
          shape(9004, "Начальное событие.43", "oval", "Начало", 1100, 300, 36, 36) +
          shape(9005, "Конечное событие.44", "oval", "Конец", 1200, 300, 36, 36) +
          "</Shapes>"
      )
    );
    const { model, changes } = reconcileVsdxEdit(m, await parseVsdx(edited));
    expect(changes.added).toHaveLength(5);
    const added = model.nodes.filter((n) => changes.added.includes(n.id));
    const by = (type: string, subtype?: string) => added.find((n) => n.type === type && (subtype === undefined || n.subtype === subtype));
    expect(by("task")!.name).toBe("Новая задача");
    expect(by("gateway", "exclusive")!.name).toBe("(без названия)");
    expect(by("gateway", "parallel")!.name).toBe("(без названия)");
    expect(by("event", "start")!.name).toBe("Начало");
    expect(by("event", "end")!.name).toBe("Конец");
    expect(added.every((n) => n.bpmn_scope === "o1" && n.tags.includes("added_externally"))).toBe(true);
    // каждая новая фигура сопоставлена шагу: оболочка пометит её, и повторный приём правок дубликатов не создаст
    expect(changes.shapeMap.map((x) => x.shapeId).sort()).toEqual(["9001", "9002", "9003", "9004", "9005"]);
    expect(changes.shapeMap.every((x) => x.page === "BPMN B002.01.01" && changes.added.includes(x.nodeId))).toBe(true);
  });

  it("шлюзы «включающий» и «событийный», события с типом (сообщение, таймер, завершение) распознаются по имени фигуры палитры", async () => {
    const m = structuredModel();
    const buf = await buildVsdx(m);
    const page = await pageNo(buf, "BPMN B002.01.01");
    const edited = await edit(buf, page, (xml) =>
      xml.replace(
        "</Shapes>",
        shape(9011, "Шлюз «включающий».50", "diamond", "O", 900, 300, 50, 50) +
          shape(9012, "Шлюз «событийный».51", "diamond", "O", 1000, 300, 50, 50) +
          shape(9013, "Начальное событие «сообщение».52", "oval", "Сообщение", 1100, 300, 36, 36) +
          shape(9014, "Промежуточное событие «таймер».53", "oval", "Таймер", 1200, 300, 36, 36) +
          shape(9015, "Конечное событие «завершение процесса».54", "oval", "Завершение процесса", 1300, 300, 36, 36) +
          "</Shapes>"
      )
    );
    const { model, changes } = reconcileVsdxEdit(m, await parseVsdx(edited));
    const added = model.nodes.filter((n) => changes.added.includes(n.id));
    expect(added).toHaveLength(5);
    expect(added.find((n) => n.type === "gateway" && n.subtype === "inclusive")).toBeTruthy();
    expect(added.find((n) => n.type === "gateway" && n.subtype === "event_based")).toBeTruthy();
    const ev = (name: string) => added.find((n) => n.type === "event" && n.name === name)!;
    expect(ev("Сообщение")).toMatchObject({ subtype: "start", trigger: { type: "message" } });
    expect(ev("Таймер")).toMatchObject({ subtype: "intermediate", trigger: { type: "timer" } });
    expect(ev("Завершение процесса")).toMatchObject({ subtype: "end", trigger: { type: "terminate" } });
  });
});

describe("размер листа, заданный в Visio", () => {
  /** Растягивает рамку листа так, как это делает Visio: меняет ширину и высоту фигуры (дюймы), левый верхний угол остаётся. */
  const resizeSheet = (xml: string, dxPx: number, dyPx: number) => {
    const at = xml.indexOf('<Cell N="Value" V="sheet"');
    const start = xml.lastIndexOf("<Shape ", at);
    const end = xml.indexOf("</Shape>", at) + "</Shape>".length;
    let shape = xml.slice(start, end);
    const cell = (name: string, f: (v: number) => number) => {
      const re = new RegExp('(<Cell N="' + name + '" V=")([-0-9.]+)');
      shape = shape.replace(re, (_m, pre: string, v: string) => pre + f(Number(v)));
    };
    cell("Width", (v) => v + dxPx / 96);
    cell("Height", (v) => v + dyPx / 96);
    cell("PinX", (v) => v + dxPx / 192);
    cell("PinY", (v) => v - dyPx / 192);
    return xml.slice(0, start) + shape + xml.slice(end);
  };

  it("лист IDEF0 растянули в Visio — настройки листа модели получают новый размер; без правки ничего не меняется", async () => {
    const m = structuredModel();
    const buf = await buildVsdx(m);
    const same = applySheetEdits(JSON.parse(JSON.stringify(m)), (await parseVsdx(buf)).sheets);
    expect(same).toBe(0);
    const page = await pageNo(buf, "IDEF0 B002.00.00");
    const edited = await edit(buf, page, (xml) => resizeSheet(xml, 200, 120));
    const sheets = (await parseVsdx(edited)).sheets.filter((x) => x.kind === "idef0" && x.key === "");
    expect(sheets).toHaveLength(1);
    const model = JSON.parse(JSON.stringify(m));
    expect(applySheetEdits(model, sheets)).toBe(1);
    const f = model.idef0_frames[""];
    expect(f.w).toBeGreaterThan(sheets[0].orig[2]);
    expect(f.h).toBeGreaterThan(sheets[0].orig[3] - 12);
    expect(f.w % 20).toBe(0); // лист ложится на клетки
  });

  it("лист BPMN, включённый и растянутый в Visio, показывается и хранит размер", async () => {
    const m = structuredModel();
    m.bpmn_frames = { o1: { show: true } };
    const buf = await buildVsdx(m);
    const page = await pageNo(buf, "BPMN B002.01.01");
    const edited = await edit(buf, page, (xml) => resizeSheet(xml, 160, 80));
    const model = JSON.parse(JSON.stringify(m));
    expect(applySheetEdits(model, (await parseVsdx(edited)).sheets)).toBe(1);
    expect(model.bpmn_frames.o1).toMatchObject({ show: true });
    expect(model.bpmn_frames.o1.w).toBeGreaterThan(0);
  });
});

describe("правки IDEF0 и удаление фигур из Visio", () => {
  it("файл без правок: ничего не переименовано и не пропало", async () => {
    const m = structuredModel();
    const parsed = await parseVsdx(await buildVsdx(m));
    const c = applyIdef0Edits(JSON.parse(JSON.stringify(m)), parsed.idef0);
    expect(c).toEqual({ functions: [], arrows: [], missingFunctions: [], missingArrows: [] });
  });

  it("блок и стрелка IDEF0 переименованы в Visio — названия функции и сущности меняются в модели", async () => {
    const m = structuredModel();
    const buf = await buildVsdx(m);
    const fn = m.nodes.find((n) => !n.bpmn_scope && (n.type === "task" || n.type === "subprocess") && !n.idef0_parent)!;
    const page = await pageNo(buf, "IDEF0 B002.00.00");
    const edited = await edit(buf, page, (xml) => xml.replace(/<Text>[\s\S]*?<\/Text>/g, (t) => t.split(fn.name).join("Новое название блока"))); // правится текст фигуры, метка pm_n остаётся прежней
    const parsed = await parseVsdx(edited);
    const model = JSON.parse(JSON.stringify(m));
    const c = applyIdef0Edits(model, parsed.idef0);
    expect(c.functions.length + c.arrows.length).toBeGreaterThan(0);
    if (c.functions.length) expect(model.nodes.find((n: { id: string }) => n.id === fn.id).name).toBe("Новое название блока");
  });

  it("удаление: шаг убирается вместе со стрелками и граничными событиями, функция — с вложенными и шагами диаграммы; без вызова модель не меняется", async () => {
    const m = structuredModel();
    const op = m.nodes.find((n) => n.idef0_parent && m.nodes.some((x) => x.bpmn_scope === n.id))!;
    const model = JSON.parse(JSON.stringify(m));
    const r = applyDeletions(model, [op.id], []);
    expect(r.nodes).toBeGreaterThan(1); // операция и её шаги
    expect(model.nodes.some((n: { id: string; bpmn_scope?: string }) => n.id === op.id || n.bpmn_scope === op.id)).toBe(false);
    expect(model.flows.every((f: { from: string; to: string }) => model.nodes.some((n: { id: string }) => n.id === f.from) && model.nodes.some((n: { id: string }) => n.id === f.to))).toBe(true);
    // шаг BPMN
    const step = m.nodes.find((n) => n.bpmn_scope && n.type === "task")!;
    const m2 = JSON.parse(JSON.stringify(m));
    expect(applyDeletions(m2, [step.id], []).nodes).toBe(1);
    expect(m2.flows.some((f: { from: string; to: string }) => f.from === step.id || f.to === step.id)).toBe(false);
  });
});

describe("новые шлюзы Business Studio", () => {
  it("комплексный и два событийных шлюза «для запуска процесса»: BPMN-элементы и признак запуска в файле", async () => {
    const { generateBpmn } = await import("../src/pipeline/bpmn.js");
    const m = structuredModel();
    const op = m.nodes.filter((n) => n.bpmn_scope === "o1");
    const base = op.find((n) => n.type === "task")!;
    const mk = (id: string, subtype: string) => ({ ...base, id, name: id, type: "gateway" as const, subtype, inputs: [], outputs: [], controls: [] });
    m.nodes.push(mk("gx1", "complex"), mk("gx2", "event_based_start"), mk("gx3", "parallel_event_based"));
    const { xml } = await generateBpmn(m, "o1");
    expect(xml).toMatch(/<bpmn:complexGateway id="Node_gx1"/);
    expect(xml).toMatch(/<bpmn:eventBasedGateway id="Node_gx2"[^>]*instantiate="true"/);
    expect(xml).toMatch(/<bpmn:eventBasedGateway id="Node_gx3"[^>]*instantiate="true"[^>]*eventGatewayType="Parallel"/);
  });

  it("фигуры палитры Visio с такими названиями приходят как комплексный и событийные шлюзы", async () => {
    const m = structuredModel();
    const buf = await buildVsdx(m);
    const page = await pageNo(buf, "BPMN B002.01.01");
    const diamond = (id: number, nameU: string, cx: number) =>
      `<Shape ID="${id}" NameU="${nameU}" Type="Shape"><Cell N="PinX" V="${cx / 96}"/><Cell N="PinY" V="${300 / 96}"/><Cell N="Width" V="${50 / 96}"/><Cell N="Height" V="${50 / 96}"/><Cell N="LocPinX" V="${25 / 96}"/><Cell N="LocPinY" V="${25 / 96}"/><Section N="Geometry" IX="0"><Cell N="NoFill" V="0"/><Cell N="NoLine" V="0"/>` +
      [[25, 50], [50, 25], [25, 0], [0, 25], [25, 50]].map(([x, y], i) => `<Row T="${i === 0 ? "MoveTo" : "LineTo"}" IX="${i + 1}"><Cell N="X" V="${x / 96}"/><Cell N="Y" V="${y / 96}"/></Row>`).join("") +
      `</Section><Text>*</Text></Shape>`;
    const edited = await edit(buf, page, (xml) => xml.replace("</Shapes>", diamond(9101, "Шлюз «комплексный»", 900) + diamond(9102, "Шлюз «событийный, запуск процесса»", 1000) + diamond(9103, "Шлюз «параллельный событийный, запуск процесса»", 1100) + "</Shapes>"));
    const { model, changes } = reconcileVsdxEdit(m, await parseVsdx(edited));
    const subs = model.nodes.filter((n) => changes.added.includes(n.id)).map((n) => n.subtype).sort();
    expect(subs).toEqual(["complex", "event_based_start", "parallel_event_based"].sort());
  });
});

