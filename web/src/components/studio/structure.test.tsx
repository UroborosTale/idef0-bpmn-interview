import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { navRow } from "../../test/harness";
import { describe, expect, it, vi } from "vitest";
import { productStages } from "@shared/products";
import { session, structuredModel, purchaseModel } from "../../test/fixtures";
import { commit, field, renderWithModel } from "../../test/harness";
import type { ProcessLogicModel } from "../../types";
import { addScopeLane, deleteNode, deleteRole } from "../bpmn-editor/model-ops";
import { withScopeLayouts } from "../bpmn-editor/geometry";
import { buildIdef0 } from "../idef0-editor/geometry";
import { removeArrow } from "../idef0-editor/ops";
import AssignmentsEditor from "./AssignmentsEditor";
import EntryCard from "./EntryCard";
import { bpmnDoc, docIsStale, docTitle, idef0Doc } from "./docs";
import { removeEntry, usageOf } from "./dict-ops";
import PropertiesPanel from "./PropertiesPanel";
import StatusScheme from "./StatusScheme";
import Studio from "./Studio";

type M = ProcessLogicModel;

function studio(model: M = structuredModel()) {
  const onSave = vi.fn(async (_: M) => true);
  const r = render(<Studio session={session(model)} busy={false} onSave={onSave} />);
  const tabs = () => [...document.querySelectorAll(".doc-tab")].map((t) => t.firstChild!.textContent);
  const active = () => document.querySelector(".doc-tab.active")!.firstChild!.textContent;
  const shapes = () => [...document.querySelectorAll(".studio g[data-node-id]")].map((g) => g.getAttribute("data-node-id"));
  const title = () => document.querySelector(".props-head b")!.textContent;
  return { ...r, onSave, tabs, active, shapes, title };
}

describe("коды и вкладки по Соглашению", () => {
  it("заголовки вкладок: код процесса у IDEF0, код операции у BPMN", () => {
    const m = structuredModel();
    expect(docTitle(idef0Doc(null), m)).toBe("IDEF0 B002.00.00");
    expect(docTitle(idef0Doc("s1"), m)).toBe("IDEF0 B002.01.00");
    expect(docTitle(bpmnDoc(), m)).toBe("BPMN");
    expect(docTitle(bpmnDoc("o1"), m)).toBe("BPMN B002.01.01");
    expect(bpmnDoc("o1").key).toBe("bpmn:o1");
  });

  it("вкладка диаграммы операции закрывается, когда операцию удалили", () => {
    const m = structuredModel();
    expect(docIsStale(bpmnDoc("o1"), m)).toBe(false);
    expect(docIsStale(bpmnDoc("o1"), deleteNode(m, "o1"))).toBe(true);
    expect(docIsStale(bpmnDoc(), m)).toBe(false);
  });

  it("модель без кода процесса — вкладки как раньше", () => {
    expect(docTitle(idef0Doc(null), purchaseModel())).toBe("IDEF0 A0");
  });
});

describe("диаграммы BPMN операций в студии", () => {
  it("навигатор показывает коды по Соглашению и кнопку BPMN у операций", () => {
    studio();
    const codes = [...document.querySelectorAll("[data-nav-fn]")].map((r) => r.querySelector(".nav-code")!.textContent);
    expect(codes).toEqual(["B002.01.00", "B002.01.01", "B002.01.02", "B002.02.00", "B002.02.01"]);
    expect([...document.querySelectorAll("[data-nav-bpmn]")].map((b) => b.getAttribute("data-nav-bpmn"))).toEqual(["o1", "o2", "o3"]);
    expect(document.querySelector('[data-nav-bpmn="o1"]')!.className).toMatch(/\bon\b/); // у o1 диаграмма есть
    expect(document.querySelector('[data-nav-bpmn="o2"]')!.className).not.toMatch(/\bon\b/);
  });

  it("кнопка BPMN открывает диаграмму операции: на ней только её шаги, общая схема их не показывает", () => {
    const s = studio();
    expect(s.shapes()).toEqual(["s1", "s2"]); // общая схема процесса: функции верхнего уровня
    fireEvent.click(document.querySelector('[data-nav-bpmn="o1"]')!);
    expect(s.active()).toBe("BPMN B002.01.01");
    expect(s.shapes()).toEqual(["b0", "b1", "b2", "b9"]);
    expect(document.querySelectorAll("[data-lane-id]").length).toBe(2); // дорожка исполнителя и «Без исполнителя»
  });

  it("щелчок по шагу: свойства подоперации с кодом и ссылкой на операцию, без блоков IDEF0", () => {
    const s = studio();
    fireEvent.click(document.querySelector('[data-nav-bpmn="o1"]')!);
    fireEvent.pointerDown(document.querySelector('[data-node-id="b1"]')!, { button: 0, pointerId: 1 });
    expect(s.title()).toBe("Свойства элемента");
    expect(document.querySelector(".prop-kind")!.textContent).toMatch(/Задача\s*B002\.01\.01\/001\s*· шаг операции\s*B002\.01\.01 Актуализация реестра/);
    const sections = [...document.querySelectorAll(".prop-section > summary")].map((x) => x.firstChild!.textContent);
    expect(sections).not.toContain("Стороны блока IDEF0");
    expect(sections).not.toContain("RACI");
    expect(sections).toContain("Сроки и стоимость");
  });

  it("новая фигура из палитры становится шагом этой операции и не попадает в общую схему", async () => {
    const s = studio();
    fireEvent.click(document.querySelector('[data-nav-bpmn="o1"]')!);
    fireEvent.click([...document.querySelectorAll(".bpe-palette button")].find((b) => b.textContent === "Задача")!);
    expect(s.shapes()).toHaveLength(5);
    await act(async () => fireEvent.click(screen.getByTitle("Сохранить (Ctrl+S)")));
    const saved = s.onSave.mock.calls[0][0];
    expect(saved.nodes.filter((n) => n.bpmn_scope === "o1")).toHaveLength(5);
    expect(saved.nodes.filter((n) => !n.bpmn_scope).map((n) => n.id)).toEqual(["s1", "s2", "o1", "o2", "o3"]);
    fireEvent.click([...document.querySelectorAll(".doc-tab")].find((t) => t.textContent?.startsWith("BPMN") && !t.textContent.includes("B002"))!);
    expect(s.shapes()).toEqual(["s1", "s2"]);
  });

  it("правка шага (перенос, переименование) записывается в модель только для его операции", async () => {
    const s = studio();
    fireEvent.click(document.querySelector('[data-nav-bpmn="o1"]')!);
    fireEvent.pointerDown(document.querySelector('[data-node-id="b2"]')!, { button: 0, pointerId: 1 });
    commit(field("Название"), "Внести код в реестр");
    await act(async () => fireEvent.click(screen.getByTitle("Сохранить (Ctrl+S)")));
    const saved = s.onSave.mock.calls[0][0];
    expect(saved.nodes.find((n) => n.id === "b2")).toMatchObject({ name: "Внести код в реестр", bpmn_scope: "o1" });
    expect(saved.flows).toHaveLength(3);
  });

  it("в ленте выгрузки: BPMN операции — только на её вкладке, архив — если есть диаграммы операций", () => {
    studio();
    const links = () => [...document.querySelectorAll(".ribbon-links a")].map((a) => a.textContent);
    expect(links()).toEqual(["BPMN", "BPMN всех операций (zip)", "IDEF0 (SVG)", "Visio", "Модель (JSON)"]);
    fireEvent.click(document.querySelector('[data-nav-bpmn="o1"]')!);
    expect(links()).toContain("BPMN операции");
    expect([...document.querySelectorAll(".ribbon-links a")].find((a) => a.textContent === "BPMN операции")!.getAttribute("href")).toMatch(/export\/bpmn\?scope=o1$/);
  });

  it("отмена правки на диаграмме операции возвращает модель", () => {
    const s = studio();
    fireEvent.click(document.querySelector('[data-nav-bpmn="o1"]')!);
    fireEvent.click([...document.querySelectorAll(".bpe-palette button")].find((b) => b.textContent === "Задача")!);
    expect(s.shapes()).toHaveLength(5);
    fireEvent.click(screen.getByTitle("Отменить (Ctrl+Z)"));
    expect(s.shapes()).toEqual(["b0", "b1", "b2", "b9"]);
  });

  it("свойства операции: кнопка «Диаграмма BPMN операции» и роли", () => {
    const s = studio();
    fireEvent.click(document.querySelector('[data-nav-fn="o1"]')!);
    fireEvent.click(screen.getByText("Диаграмма BPMN операции"));
    expect(s.active()).toBe("BPMN B002.01.01");
  });

  it("шаги диаграммы операции, у которых нет позиций, расставляются при открытии модели", () => {
    const m = structuredModel();
    m.nodes.forEach((n) => n.bpmn_scope && (n.layout = null));
    const laid = withScopeLayouts(m);
    const xs = laid.nodes.filter((n) => n.bpmn_scope).map((n) => n.layout?.x);
    expect(xs.every((x) => typeof x === "number")).toBe(true);
    expect(new Set(xs).size).toBeGreaterThan(1);
    expect(withScopeLayouts(structuredModel())).toBeTruthy();
    expect(withScopeLayouts(purchaseModel())).toEqual(purchaseModel());
  });

  it("новая дорожка диаграммы операции — роль и её исполнитель", () => {
    const r = addScopeLane(structuredModel(), "o2");
    expect(r.model.roles).toHaveLength(4);
    expect(r.model.assignments).toContainEqual({ node_id: "o2", role_id: r.id, kind: "executor", functions: [] });
  });
});

describe("ролевая модель", () => {
  const editor = (model: M = structuredModel(), nodeId: string | null = "o1") => renderWithModel(model, (m, onChange) => <AssignmentsEditor model={m} nodeId={nodeId} onChange={onChange} />);

  it("показывает назначения функции: вид, должность, функции", () => {
    editor();
    const rows = [...document.querySelectorAll(".assignment")];
    expect(rows).toHaveLength(2);
    expect((within(rows[0] as HTMLElement).getByTitle(/Проверяет качество/) as HTMLSelectElement).value).toBe("controller");
    expect((rows[1].querySelector("textarea") as HTMLTextAreaElement).value).toBe("Внесение данных в реестр");
  });

  it("назначить должность, сменить вид, записать функции, снять", () => {
    const r = editor(structuredModel(), "o2");
    expect(screen.getByText("Роли не назначены.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Назначить должность"), { target: { value: "r3" } });
    expect(r.model().assignments.at(-1)).toEqual({ node_id: "o2", role_id: "r3", kind: "executor", functions: [] });
    fireEvent.change(document.querySelector(".assignment select")!, { target: { value: "controller" } });
    expect(r.model().assignments.at(-1)!.kind).toBe("controller");
    commit(document.querySelector(".assignment textarea")!, "Проверка качества\n\n  Фиксирование замечаний ");
    expect(r.model().assignments.at(-1)!.functions).toEqual(["Проверка качества", "Фиксирование замечаний"]);
    fireEvent.click(screen.getByTitle("Снять роль"));
    expect(r.model().assignments.filter((a) => a.node_id === "o2")).toEqual([]);
  });

  it("новая должность создаётся прямо из списка назначения", () => {
    const r = editor(structuredModel(), "o2");
    fireEvent.change(screen.getByLabelText("Назначить должность"), { target: { value: "__new__" } });
    const input = screen.getByPlaceholderText("Название должности и Enter");
    fireEvent.change(input, { target: { value: "Главный бухгалтер" } });
    fireEvent.keyDown(input, { key: "Enter" });
    const role = r.model().roles.at(-1)!;
    expect(role.name).toBe("Главный бухгалтер");
    expect(r.model().assignments.at(-1)).toMatchObject({ node_id: "o2", role_id: role.id });
  });

  it("роли процесса в целом: node_id = null", () => {
    const r = editor(structuredModel(), null);
    expect(document.querySelectorAll(".assignment")).toHaveLength(1);
    fireEvent.change(screen.getByLabelText("Назначить должность"), { target: { value: "r2" } });
    expect(r.model().assignments.at(-1)).toMatchObject({ node_id: null, role_id: "r2" });
  });

  it("панель функции и процесса содержат ролевую модель", () => {
    const panel = (selection: Parameters<typeof PropertiesPanel>[0]["selection"]) =>
      renderWithModel(structuredModel(), (m, onChange) => (
        <PropertiesPanel model={m} selection={selection} session={{ id: "s", fragments: [], updatedAt: "t" }} issues={[]} activeKind="bpmn" onChange={onChange} onSelect={() => {}} onGoto={() => {}} onReveal={() => {}} onOpenDecomposition={() => {}} onOpenDoc={() => {}} onClose={() => {}} />
      ));
    const a = panel({ kind: "node", id: "o1" });
    expect(document.body.textContent).toContain("Ролевая модель");
    a.unmount();
    panel(null);
    expect(document.body.textContent).toContain("Ролевая модель процесса");
  });

  it("код процесса: подсказка о формате и о построении кодов", () => {
    const view = (code: string) => {
      const m = structuredModel();
      m.process.code = code;
      return renderWithModel(m, (mm, onChange) => (
        <PropertiesPanel model={mm} selection={null} session={{ id: "s", fragments: [], updatedAt: "t" }} issues={[]} activeKind="bpmn" onChange={onChange} onSelect={() => {}} onGoto={() => {}} onReveal={() => {}} onOpenDecomposition={() => {}} onOpenDoc={() => {}} onClose={() => {}} />
      ));
    };
    const a = view("B002.00.00");
    expect(document.body.textContent).toMatch(/подпроцессы B002\.01\.00/);
    a.unmount();
    const b = view("Z1");
    expect(document.body.textContent).toMatch(/Код не по шаблону/);
    b.unmount();
    view("");
    expect(document.body.textContent).toMatch(/Без кода функции нумеруются A1/);
  });

  it("роль на диаграмме IDEF0 — механизм; стрелка-механизм снимает и исполнителя, и назначение", () => {
    const m = structuredModel();
    const arrows = buildIdef0(m, "s1").arrows.filter((a) => a.kind === "role" && a.nodeId === "o1");
    expect(arrows.map((a) => a.entityId)).toEqual(["r2", "r3"]);
    const noExec = removeArrow(m, arrows[0]);
    expect(noExec.nodes.find((n) => n.id === "o1")!.role_id).toBeNull();
    expect(noExec.assignments.some((a) => a.node_id === "o1" && a.role_id === "r2")).toBe(false);
    expect(noExec.assignments.some((a) => a.node_id === "o1" && a.role_id === "r3")).toBe(true);
  });

  it("где используется должность: исполнитель и назначенные роли; удаление должности снимает назначения", () => {
    const m = structuredModel();
    expect(usageOf(m, "roles", "r3").map((u) => `${u.nodeId}:${u.how}`)).toEqual(["o1:контролер"]);
    const exec = usageOf(m, "roles", "r2").map((u) => `${u.nodeId}:${u.how}`);
    expect(exec).toContain("o1:исполнитель");
    expect(exec.filter((x) => x === "o1:исполнитель")).toHaveLength(1); // исполнитель и назначение — одна запись
    const gone = removeEntry(m, "roles", "r3");
    expect(gone.assignments.some((a) => a.role_id === "r3")).toBe(false);
    expect(deleteRole(m, "r3").model.assignments.some((a) => a.role_id === "r3")).toBe(false);
  });

  it("удаление функции снимает её назначения", () => {
    const m = deleteNode(structuredModel(), "s1");
    expect(m.assignments.some((a) => a.node_id === "s1" || a.node_id === "o1")).toBe(false);
    expect(m.assignments.some((a) => a.node_id === null)).toBe(true);
  });
});

describe("карточка продукта", () => {
  const card = (dict: "data" | "roles", id: string, onGoto = vi.fn(), model: M = structuredModel()) =>
    renderWithModel(model, (m, onChange) => <EntryCard model={m} dict={dict} id={id} sessionId="s" fragments={[]} stamp="t" onChange={onChange} onGoto={onGoto} />);

  it("источник и назначение выводятся из связей функций, со ссылкой на функцию", () => {
    const onGoto = vi.fn();
    card("data", "d3", onGoto);
    const section = screen.getByText("Карточка продукта").closest("details")!;
    const fields = [...section.querySelectorAll(".bpe-field")];
    const chips = (i: number) => [...fields[i].querySelectorAll(".usage-chip")].map((c) => c.textContent);
    expect(chips(0).join()).toMatch(/B002\.01\.00.*Моделирование процесса/); // выпускает подпроцесс s1
    expect(chips(2).join()).toMatch(/B002\.02\.00/); // использует s2
    fireEvent.click(fields[0].querySelector(".usage-chip")!);
    expect(onGoto).toHaveBeenCalledWith("s1");
  });

  it("вход процесса без поставщика и выход без потребителя помечаются", () => {
    card("data", "d1");
    expect(screen.getByText(/вход процесса без поставщика/)).toBeTruthy();
    document.body.innerHTML = "";
    card("data", "d4");
    expect(screen.getByText(/выход процесса без потребителя/)).toBeTruthy();
  });

  it("внешний поставщик, ценность и стандарт качества сохраняются в карточке", () => {
    const r = card("data", "d1");
    commit(field("Внешний поставщик"), "Протокол совещания");
    commit(field("Внешний потребитель"), "Конечный продукт");
    commit(field("Ценность для потребителя"), "Основание для внесения в реестр");
    commit(field("Стандарт качества"), "Идентифицирован процесс");
    expect(r.model().data[0]).toMatchObject({ supplier: "Протокол совещания", consumer: "Конечный продукт", value: "Основание для внесения в реестр", quality_standard: "Идентифицирован процесс" });
    expect(screen.queryByText(/вход процесса без поставщика/)).toBeNull(); // поставщик указан
  });

  it("у должности — квалификация", () => {
    const r = card("roles", "r3");
    commit(field("Требуемая квалификация и специализация"), "Высшее образование");
    expect(r.model().roles[2].qualification).toBe("Высшее образование");
  });

  it("у справочников, кроме продуктов, карточки продукта нет", () => {
    card("roles", "r1");
    expect(screen.queryByText("Карточка продукта")).toBeNull();
  });
});

describe("схема перехода статусов", () => {
  it("продукты по стадиям: входы, выпуск функций, ветвление; группы по функции", () => {
    const s = productStages(structuredModel());
    expect(Object.fromEntries(s.items.map((i) => [i.id, i.layer]))).toEqual({ d1: 0, d3: 1, d4: 2 });
    expect(s.edges).toEqual([{ from: "d1", to: "d3" }, { from: "d3", to: "d4" }]);
    expect(s.layers).toBe(3);
    expect(s.items.map((i) => i.group)).toEqual(["in@0", "s1@1", "s2@2"]);
  });

  it("цикл связей стадий не создаёт; продукты вне функций не попадают", () => {
    const m = structuredModel();
    m.nodes.find((n) => n.id === "s1")!.inputs.push("d4"); // d4 → d3 замыкает цикл
    const s = productStages(m);
    expect(s.items.map((i) => i.id).sort()).toEqual(["d1", "d3", "d4"]);
    expect(s.layers).toBeGreaterThan(0);
    expect(s.items.every((i) => Number.isFinite(i.layer))).toBe(true);
  });

  it("рисуется: рамки групп, стрелки и подписи продуктов; пустая модель — подсказка", () => {
    const m = structuredModel();
    m.nodes.find((n) => n.id === "s1")!.outputs = ["d3", "d2"]; // два продукта одной функции — одна рамка
    const { container, rerender } = render(<StatusScheme model={m} />);
    expect(container.querySelectorAll("[data-product-id]")).toHaveLength(4);
    expect(container.querySelectorAll("svg.scheme-svg g[transform] > rect").length).toBe(1); // рамка группы d3+d2
    expect(container.querySelectorAll("svg.scheme-svg path[marker-end]").length).toBeGreaterThan(1);
    const empty = structuredModel();
    empty.nodes = [];
    rerender(<StatusScheme model={empty} />);
    expect(screen.getByText(/Схему построить не из чего/)).toBeTruthy();
  });

  it("отчёт открывается из навигатора", () => {
    const s = studio();
    fireEvent.click(navRow("Схема перехода статусов", true));
    expect(s.active()).toBe("Схема перехода статусов");
    expect(document.querySelector("svg.scheme-svg")).toBeTruthy();
  });
});
