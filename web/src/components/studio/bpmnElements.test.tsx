import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { session, structuredModel } from "../../test/fixtures";
import { commit, field, renderWithModel } from "../../test/harness";
import type { ProcessLogicModel } from "../../types";
import { SIZE, autoLayout, boxMap, diagramExtras, isBoundary, modelExtents, visibleNodes, withLayout } from "../bpmn-editor/geometry";
import { addBoundaryEvent, addFlow, addMessage, addNodeAt, addPool, deleteMessage, deleteNode, deletePool, dropNodeIntoLane, setNodeRole, updateMessage } from "../bpmn-editor/model-ops";
import { ArtifactShape } from "../bpmn-editor/shapes";
import MessagesEditor, { PoolsEditor } from "./MessagesEditor";
import PropertiesPanel from "./PropertiesPanel";
import Studio from "./Studio";

type M = ProcessLogicModel;

/** Диаграмма операции o1 (структурированная модель) в виде общей схемы: шаги без bpmn_scope, как их видит редактор. */
const flat = () => {
  const m = structuredModel();
  return { ...m, nodes: m.nodes.filter((n) => n.bpmn_scope === "o1").map((n) => ({ ...n, bpmn_scope: undefined })), flows: m.flows.filter((f) => f.id.startsWith("bf")) } as M;
};

const withBoundary = (m: M = flat()) => addBoundaryEvent(m, "b1", "timer");

describe("граничные события: операции над моделью", () => {
  it("создаются на задаче: дорожка и область задачи, прерывающее по умолчанию", () => {
    const r = withBoundary(structuredModel());
    const host = structuredModel().nodes.find((n) => n.id === "b1")!;
    const node = r.model.nodes.find((n) => n.id === r.id)!;
    expect(node).toMatchObject({ type: "event", subtype: "intermediate", trigger: { type: "timer" }, name: "Срок истёк", attached_to: "b1", interrupting: true, role_id: host.role_id, bpmn_scope: "o1" });
    expect(addBoundaryEvent(structuredModel(), "b0").error).toMatch(/задаче или подпроцессу/); // к событию не крепится
    expect(addBoundaryEvent(structuredModel(), "нет").error).toBeTruthy();
    const second = addBoundaryEvent(r.model, "b1", "message");
    expect(second.id).not.toBe(r.id);
    expect(second.model.nodes.find((n) => n.id === second.id)!.name).toBe("Сообщение получено");
  });

  it("стрелку в граничное событие вести нельзя; из него — можно", () => {
    const { model, id } = withBoundary();
    expect(addFlow(model, "b2", id!).error).toMatch(/граничное событие/);
    const ok = addFlow(model, id!, "b2");
    expect(ok.error).toBeUndefined();
  });

  it("удаление задачи уносит её граничные события, их стрелки и потоки сообщений", () => {
    let { model, id } = withBoundary();
    model = addFlow(model, id!, "b2").model;
    model = addPool(model, "Другой процесс", "B002.02.01").model;
    model = addMessage(model, id!, "pool1").model;
    const gone = deleteNode(model, "b1");
    expect(gone.nodes.some((n) => n.id === id)).toBe(false);
    expect(gone.flows.every((f) => f.from !== id && f.to !== id)).toBe(true);
    expect(gone.messages).toEqual([]);
    expect(gone.pools).toHaveLength(1); // пул принадлежит процессу и остаётся
    // само граничное событие можно удалить отдельно
    expect(deleteNode(model, id!).nodes.some((n) => n.id === "b1")).toBe(true);
  });

  it("граничное событие следует за дорожкой своей задачи", () => {
    const m = withBoundary(structuredModel()).model;
    m.roles.push({ id: "r9", name: "Новая роль", kind: "internal", source: [] });
    const moved = setNodeRole(m, "b1", "r9");
    expect(moved.nodes.find((n) => n.attached_to === "b1")!.role_id).toBe("r9");
    const dropped = dropNodeIntoLane(moved, "b1");
    expect(dropped.nodes.find((n) => n.attached_to === "b1")!.role_id).toBe(dropped.nodes.find((n) => n.id === "b1")!.role_id);
  });
});

describe("внешние пулы и потоки сообщений: операции над моделью", () => {
  it("пул, поток, переименование, удаление", () => {
    let m = flat();
    const pool = addPool(m, "  Анализ эффективности ", " B002.02.01 ");
    expect(pool.model.pools[0]).toEqual({ id: "pool1", name: "Анализ эффективности", code: "B002.02.01" });
    expect(addPool(pool.model, "").model.pools[1].name).toBe("Внешний процесс");
    m = pool.model;
    expect(addMessage(m, "b1", "b2").error).toMatch(/шаг диаграммы и внешний пул/);
    expect(addMessage(m, "pool1", "pool1").error).toBeTruthy();
    const msg = addMessage(m, "b2", "pool1", " Запрос ");
    expect(msg.model.messages).toEqual([{ id: "msg1", from: "b2", to: "pool1", name: "Запрос" }]);
    expect(addMessage(msg.model, "b2", "pool1").error).toMatch(/уже есть/);
    expect(addMessage(msg.model, "pool1", "b2").error).toBeUndefined(); // обратное направление — другой поток
    expect(updateMessage(msg.model, "msg1", { name: null }).messages[0].name).toBeNull();
    expect(deleteMessage(msg.model, "msg1").messages).toEqual([]);
    expect(deletePool(msg.model, "pool1").messages).toEqual([]);
  });
});

describe("геометрия добавочных элементов в редакторе", () => {
  it("граничное событие стоит на нижней границе задачи и в раскладке не участвует", () => {
    let m = flat();
    const b = addBoundaryEvent(m, "b1");
    m = addFlow(b.model, b.id!, "b9").model;
    const laid = withLayout(m);
    expect(laid.nodes.find((n) => n.id === b.id)!.layout).toBeUndefined();
    expect(withLayout(laid)).toBe(laid); // все шаги расставлены, граничным позиция не нужна
    const host = boxMap(visibleNodes(laid)).get("b1")!;
    const box = boxMap(visibleNodes(laid)).get(b.id!)!;
    expect(box.y + box.h / 2).toBe(host.y + host.h);
    expect(box.x).toBeGreaterThanOrEqual(host.x - box.w / 2);
    expect(box.w).toBe(SIZE.event.w);
    // стрелка из граничного события в раскладке идёт «от задачи»: цель стоит правее задачи
    const auto = autoLayout(m);
    expect(auto.has(b.id!)).toBe(false);
    expect(auto.get("b9")!.x).toBeGreaterThan(auto.get("b1")!.x);
    expect(isBoundary(laid.nodes.find((n) => n.id === b.id)!, laid.nodes)).toBe(true);
  });

  it("документы над задачей, хранилища под ней; пулы и потоки сообщений под дорожками; мир диаграммы растёт", () => {
    let m = withLayout(flat());
    m.nodes.find((n) => n.id === "b1")!.inputs = ["d1"];
    m.nodes.find((n) => n.id === "b1")!.outputs = ["d2"];
    const before = modelExtents(m).h;
    const pool = addPool(m, "Другой процесс");
    m = addMessage(pool.model, "b2", pool.id!).model;
    const shown = visibleNodes(m);
    const boxes = boxMap(shown);
    const ex = diagramExtras(m, shown, boxes);
    expect(ex.artifacts.map((a) => a.kind)).toEqual(["input", "output", "store"]); // d1, d2, ELMA365
    const host = boxes.get("b1")!;
    for (const a of ex.artifacts) {
      if (a.kind === "store") expect(a.box.y).toBeGreaterThan(host.y + host.h);
      else expect(a.box.y + a.box.h).toBeLessThan(host.y);
    }
    expect(ex.pools).toHaveLength(1);
    expect(ex.pools[0].box.y).toBeGreaterThan(Math.max(...[...boxes.values()].map((b) => b.y + b.h)));
    expect(ex.messages).toHaveLength(1);
    expect(modelExtents(m).h).toBeGreaterThan(before);
    // самостоятельный пул без потоков сообщений тоже рисуется
    expect(diagramExtras(addPool(withLayout(flat()), "Пустой").model, shown, boxes).pools).toHaveLength(1);
  });

  it("новая фигура из палитры не ломает граничные события", () => {
    const m = withBoundary().model;
    const added = addNodeAt(m, { type: "task", name: "Новая задача" }, 400, 100);
    expect(added.model.nodes.filter((n) => n.attached_to)).toHaveLength(1);
  });
});

describe("панель «Свойства»: граничные события, потоки сообщений, пулы", () => {
  const panel = (model: M, selection: Parameters<typeof PropertiesPanel>[0]["selection"]) => {
    const h = { onSelect: vi.fn(), onGoto: vi.fn(), onReveal: vi.fn(), onOpenDecomposition: vi.fn(), onOpenDoc: vi.fn(), onClose: vi.fn() };
    const r = renderWithModel(model, (m, onChange) => <PropertiesPanel model={m} selection={selection} session={{ id: "s", fragments: [], updatedAt: "t" }} issues={[]} activeKind="bpmn" onChange={onChange} {...h} />);
    return { ...r, ...h };
  };

  it("у задачи: кнопки добавляют граничные события и открывают их свойства", () => {
    const p = panel(structuredModel(), { kind: "node", id: "b1" });
    expect(screen.getByText("На границе задачи событий нет.")).toBeTruthy();
    fireEvent.click(screen.getByText("+ Ошибка"));
    const created = p.model().nodes.find((n) => n.attached_to === "b1")!;
    expect(created).toMatchObject({ subtype: "intermediate", trigger: { type: "error" }, bpmn_scope: "o1" });
    expect(p.onSelect).toHaveBeenCalledWith(expect.objectContaining({ kind: "node", id: created.id }));
  });

  it("у граничного события: к какой задаче прикреплено, прерывание; открепить — обычное событие", () => {
    const { model, id } = withBoundary(structuredModel());
    const p = panel(model, { kind: "node", id: id! });
    const host = field("Прикреплено к задаче") as unknown as HTMLSelectElement;
    expect(host.value).toBe("b1");
    expect([...host.options].map((o) => o.value)).toEqual(["", "b1", "b2"]); // задачи этой же диаграммы, кроме самого события
    const box = screen.getByLabelText(/Прерывает задачу/) as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    expect(p.model().nodes.find((n) => n.id === id)!.interrupting).toBe(false);
    fireEvent.change(host, { target: { value: "b2" } });
    expect(p.model().nodes.find((n) => n.id === id)!.attached_to).toBe("b2");
    fireEvent.change(host, { target: { value: "" } });
    expect(p.model().nodes.find((n) => n.id === id)!.attached_to).toBeNull();
    expect(screen.queryByLabelText(/Прерывает задачу/)).toBeNull();
  });

  it("потоки сообщений шага: создать пул и связать, отправка и получение, название, снять", () => {
    const p = panel(structuredModel(), { kind: "node", id: "b2" });
    expect(screen.getByText("Потоков сообщений нет.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Внешний пул"), { target: { value: "__new__" } });
    fireEvent.change(screen.getByLabelText("Название внешнего процесса или участника"), { target: { value: "Анализ эффективности" } });
    fireEvent.change(screen.getByPlaceholderText("B002.02.01"), { target: { value: "B002.02.01" } });
    fireEvent.click(screen.getByText("Создать и связать"));
    expect(p.model().pools).toEqual([{ id: "pool1", name: "Анализ эффективности", code: "B002.02.01" }]);
    expect(p.model().messages).toEqual([{ id: "msg1", from: "b2", to: "pool1", name: null }]);
    expect(screen.getByText("→ отправляет в")).toBeTruthy();
    expect(document.querySelector(".message-pool")!.textContent).toBe("B002.02.01 Анализ эффективности");
    commit(screen.getByPlaceholderText("Название сообщения"), "Запрос на анализ");
    expect(p.model().messages[0].name).toBe("Запрос на анализ");

    fireEvent.change(screen.getByLabelText("Направление сообщения"), { target: { value: "in" } });
    fireEvent.change(screen.getByLabelText("Внешний пул"), { target: { value: "pool1" } });
    expect(p.model().messages.map((m) => `${m.from}>${m.to}`)).toEqual(["b2>pool1", "pool1>b2"]);
    expect(screen.getByText("← получает из")).toBeTruthy();
    fireEvent.click(screen.getAllByTitle("Убрать поток сообщений")[0]);
    expect(p.model().messages.map((m) => `${m.from}>${m.to}`)).toEqual(["pool1>b2"]);
  });

  it("у шлюза потоков сообщений нет; у шагов других задач раздел виден", () => {
    const gw = structuredModel();
    gw.nodes.push({ ...gw.nodes.find((n) => n.id === "b1")!, id: "g1", type: "gateway", subtype: "exclusive", name: "Данные верны?" });
    panel(gw, { kind: "node", id: "g1" });
    expect(screen.queryByText("Потоки сообщений")).toBeNull();
  });

  it("пулы процесса: название, код, число потоков, удаление вместе с потоками", () => {
    let m = structuredModel();
    const pool = addPool(m, "Другой процесс", "B002.02.01");
    m = addMessage(pool.model, "b2", pool.id!).model;
    const p = panel(m, null);
    expect(screen.getByText("Потоков сообщений: 1")).toBeTruthy();
    commit(screen.getByDisplayValue("Другой процесс"), "Процесс-партнёр");
    commit(screen.getByDisplayValue("B002.02.01"), "");
    expect(p.model().pools[0]).toMatchObject({ name: "Процесс-партнёр", code: null });
    fireEvent.click(screen.getByTitle("Удалить пул и 1 поток(ов) сообщений"));
    expect(p.model().pools).toEqual([]);
    expect(p.model().messages).toEqual([]);
  });

  it("пустой список пулов подсказывает, откуда пул создаётся", () => {
    renderWithModel(structuredModel(), (m, onChange) => <PoolsEditor model={m} onChange={onChange} />);
    expect(screen.getByText(/Пул создаётся из потока сообщений/)).toBeTruthy();
  });

  it("MessagesEditor: без пулов в списке — только «Новый пул…»", () => {
    renderWithModel(structuredModel(), (m, onChange) => <MessagesEditor model={m} nodeId="b1" onChange={onChange} />);
    const select = screen.getByLabelText("Внешний пул") as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(["", "__new__"]);
  });
});

describe("студия: новые элементы на диаграмме операции", () => {
  const studio = (model: M) => {
    const onSave = vi.fn(async (_: M) => true);
    render(<Studio session={session(model)} busy={false} onSave={onSave} />);
    fireEvent.click(document.querySelector('[data-nav-bpmn="o1"]')!);
    return { onSave };
  };
  const shapes = () => [...document.querySelectorAll(".studio g[data-node-id]")].map((g) => g.getAttribute("data-node-id"));
  const palette = (label: string) => [...document.querySelectorAll(".bpe-palette button")].find((b) => b.textContent === label) as HTMLElement;
  const select = (id: string) => {
    fireEvent.pointerDown(document.querySelector(`[data-node-id="${id}"]`)!, { button: 0, pointerId: 1 });
    fireEvent.pointerUp(document.querySelector(".studio svg.bpe-svg")!, { pointerId: 1 });
  };

  it("палитра: «Бизнес-правила» добавляет задачу с этим видом", async () => {
    const { onSave } = studio(structuredModel());
    fireEvent.click(palette("Бизнес-правила"));
    expect(document.querySelector(".studio")!.textContent).toContain("Правила");
    await act(async () => fireEvent.click(screen.getByTitle("Сохранить (Ctrl+S)")));
    const added = onSave.mock.calls[0][0].nodes.find((n) => n.name === "Применить правило")!;
    expect(added).toMatchObject({ type: "task", subtype: "business_rule", bpmn_scope: "o1" });
  });

  it("«Гр. событие»: без выбранной задачи — подсказка; с выбранной — событие на её границе, которое нельзя перетащить", async () => {
    const { onSave } = studio(structuredModel());
    fireEvent.click(palette("Гр. событие"));
    expect(screen.getByText(/Выберите задачу/)).toBeTruthy();
    select("b1");
    fireEvent.click(palette("Гр. событие"));
    const ids = shapes();
    expect(ids).toHaveLength(5);
    const bid = ids.find((id) => !["b0", "b1", "b2", "b9"].includes(id!))!;
    const host = document.querySelector('[data-node-id="b1"] rect:not([fill="transparent"])')!;
    const hostBottom = Number(host.getAttribute("y")) + Number(host.getAttribute("height"));
    const circle = document.querySelector(`[data-node-id="${bid}"] circle`)!;
    expect(Number(circle.getAttribute("cy"))).toBe(hostBottom);
    // перенос граничного события не меняет модель, выбор срабатывает
    const before = document.querySelector(`[data-node-id="${bid}"] circle`)!.getAttribute("cx");
    fireEvent.pointerDown(document.querySelector(`[data-node-id="${bid}"]`)!, { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(document.querySelector(".studio svg.bpe-svg")!, { pointerId: 1, clientX: 300, clientY: 300 });
    fireEvent.pointerUp(document.querySelector(".studio svg.bpe-svg")!, { pointerId: 1 });
    expect(document.querySelector(`[data-node-id="${bid}"] circle`)!.getAttribute("cx")).toBe(before);
    expect(document.querySelector(".props-head b")!.textContent).toBe("Свойства элемента");
    await act(async () => fireEvent.click(screen.getByTitle("Сохранить (Ctrl+S)")));
    expect(onSave.mock.calls[0][0].nodes.find((n) => n.id === bid)).toMatchObject({ attached_to: "b1", subtype: "intermediate", trigger: { type: "timer" }, bpmn_scope: "o1" });
  });

  it("значки документов и хранилищ, внешний пул и поток сообщений рисуются; клик по значку открывает карточку документа или системы", () => {
    const m = structuredModel();
    m.nodes.find((n) => n.id === "b1")!.inputs = ["d1"];
    m.nodes.find((n) => n.id === "b1")!.outputs = ["d2"];
    const pool = addPool(m, "Анализ эффективности", "B002.02.01");
    const withMessage = addMessage(pool.model, "b2", pool.id!, "Запрос на анализ").model;
    studio(withMessage);
    expect([...document.querySelectorAll("[data-artifact]")].map((a) => `${a.getAttribute("data-artifact")}:${a.getAttribute("data-artifact-kind")}`)).toEqual(["b1:input", "b1:output", "b1:store"]);
    expect(document.querySelector("[data-pool-id]")!.textContent).toContain("B002.02.01 Анализ эффективности");
    expect(document.querySelector(".studio svg.bpe-svg")!.textContent).toContain("Запрос на анализ");
    fireEvent.pointerDown(document.querySelector('[data-artifact-kind="input"]')!, { button: 0, pointerId: 1 });
    expect(document.querySelector(".prop-kind")!.textContent).toMatch(/Документ \/ данные/);
    fireEvent.pointerDown(document.querySelector('[data-artifact-kind="store"]')!, { button: 0, pointerId: 1 });
    expect(document.querySelector(".prop-kind")!.textContent).toMatch(/Информационная система/);
  });

  it("двойной щелчок по значку документа переименовывает его во всей модели", () => {
    const m = structuredModel();
    m.nodes.find((n) => n.id === "b1")!.inputs = ["d1"];
    studio(m);
    const icon = document.querySelector('[data-artifact-kind="input"]')!;
    fireEvent.pointerDown(icon, { button: 0, pointerId: 1 });
    fireEvent.doubleClick(icon);
    const input = document.querySelector(".studio input.bpe-rename, .studio .bpe-overlay input, .studio foreignObject input") as HTMLInputElement | null;
    expect(input).not.toBeNull();
    fireEvent.change(input!, { target: { value: "Заявка v2" } });
    fireEvent.keyDown(input!, { key: "Enter" });
    expect(document.querySelector(".studio")!.textContent).toContain("Заявка v2");
  });

  describe("внешний пул добавляется и перемещается", () => {
    const svgEl = () => document.querySelector(".studio svg.bpe-svg")!;
    const pool = () => document.querySelector("[data-pool-id] rect")!;

    it("кнопка палитры добавляет пул, выбирает его; пул перетаскивается, отмена возвращает его", () => {
      studio(structuredModel());
      expect(document.querySelector("[data-pool-id]")).toBeNull();
      fireEvent.click(screen.getByText("Внешний пул"));
      expect(document.querySelector("[data-pool-id]")).not.toBeNull();
      expect(document.querySelector(".prop-kind")!.textContent).toMatch(/Внешний пул/);
      const before = [pool().getAttribute("x"), pool().getAttribute("y")];
      fireEvent.pointerDown(document.querySelector("[data-pool-id]")!, { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
      fireEvent.pointerMove(svgEl(), { pointerId: 1, clientX: 220, clientY: 160 });
      fireEvent.pointerUp(svgEl(), { pointerId: 1, clientX: 220, clientY: 160 });
      expect([pool().getAttribute("x"), pool().getAttribute("y")]).not.toEqual(before);
      fireEvent.keyDown(document.querySelector(".studio")!, { key: "z", ctrlKey: true });
      expect([pool().getAttribute("x"), pool().getAttribute("y")]).toEqual(before);
    });

    it("панель выбранного значка и пула: «Вернуть на место» возвращает автоматическое положение", () => {
    const m = structuredModel();
    m.nodes.find((n) => n.id === "b1")!.inputs = ["d1"];
    studio(addPool(m, "Поставщики", null, "o1").model);
    const svg = document.querySelector(".studio svg.bpe-svg")!;
    const move = (el: Element, dx: number, dy: number) => {
      fireEvent.pointerDown(el, { button: 0, pointerId: 9, clientX: 100, clientY: 100 });
      fireEvent.pointerMove(svg, { pointerId: 9, clientX: 100 + dx, clientY: 100 + dy });
      fireEvent.pointerUp(svg, { pointerId: 9, clientX: 100 + dx, clientY: 100 + dy });
    };
    const reset = () => screen.getByText("Вернуть на место", { selector: "button" }) as HTMLButtonElement;
    const icon = () => document.querySelector('[data-artifact-kind="input"]')!;
    const iconAt = () => icon().querySelector("g path")!.getAttribute("d");
    const auto = iconAt();
    move(icon(), 60, 40);
    expect(iconAt()).not.toBe(auto);
    expect(reset().disabled).toBe(false);
    fireEvent.click(reset());
    expect(iconAt()).toBe(auto);
    expect(reset().disabled).toBe(true);

    const poolAt = () => document.querySelector("[data-pool-id] rect")!.getAttribute("x");
    const poolAuto = poolAt();
    move(document.querySelector("[data-pool-id]")!, 80, 30);
    expect(poolAt()).not.toBe(poolAuto);
    fireEvent.click(reset());
    expect(poolAt()).toBe(poolAuto);
  });

  it("инструмент «Поток сообщений» из палитры: щелчок по шагу, затем по пулу создаёт отдельную стрелку; Esc отменяет", () => {
      studio(addPool(structuredModel(), "Поставщики", null, "o1").model);
      const press = (el: Element) => {
        fireEvent.pointerDown(el, { button: 0, pointerId: 3 });
        fireEvent.pointerUp(svgEl(), { pointerId: 3 });
      };
      const tool = screen.getByText("Поток сообщений");
      fireEvent.click(tool);
      expect(tool.getAttribute("aria-pressed")).toBe("true");
      press(document.querySelector('.studio g[data-node-id="b1"]')!);
      press(document.querySelector("[data-pool-id]")!);
      expect(document.querySelector("[data-message-id]")).not.toBeNull();
      expect(document.querySelector(".prop-kind")!.textContent).toMatch(/Поток сообщений/);
      expect(tool.getAttribute("aria-pressed")).toBe("false");
      // инструмент выключен: щелчок по пулу снова обычный выбор
      press(document.querySelector("[data-pool-id]")!);
      expect(document.querySelector(".prop-kind")!.textContent).toMatch(/Внешний пул/);
      fireEvent.click(tool);
      fireEvent.keyDown(document.querySelector(".bpe-root") ?? svgEl(), { key: "Escape" });
      expect(tool.getAttribute("aria-pressed")).toBe("false");
    });

    it("● шага, отпущенная на пуле, создаёт поток сообщений", () => {
      const m = addPool(structuredModel(), "Поставщики", null, "o1").model;
      studio(m);
      fireEvent.pointerDown(document.querySelector('.studio g[data-node-id="b1"]')!, { button: 0, pointerId: 2, clientX: 10, clientY: 10 });
      fireEvent.pointerUp(svgEl(), { pointerId: 2, clientX: 10, clientY: 10 });
      const from = document.querySelector("[data-connect]")!;
      const id = from.getAttribute("data-connect")!;
      fireEvent.pointerDown(from, { button: 0, pointerId: 1 });
      const real = document.elementFromPoint;
      document.elementFromPoint = () => document.querySelector("[data-pool-id] rect");
      fireEvent.pointerUp(svgEl(), { pointerId: 1, clientX: 5, clientY: 5 });
      document.elementFromPoint = real;
      expect(document.querySelector("[data-message-id]")).not.toBeNull();
      expect(id).toBeTruthy();
    });
  });

  describe("внешний пул и поток сообщений правятся на диаграмме", () => {
    const withPool = () => {
      const pool = addPool(structuredModel(), "Поставщики");
      return addMessage(pool.model, "b2", pool.id!, "Запрос предложений").model;
    };
    const svgEl = () => document.querySelector(".studio svg.bpe-svg")!;

    it("щелчок открывает карточку пула или потока, двойной щелчок переименовывает, Delete удаляет", () => {
      studio(withPool());
      fireEvent.pointerDown(document.querySelector("[data-pool-id]")!, { button: 0, pointerId: 1 });
      fireEvent.pointerUp(svgEl(), { pointerId: 1 });
      expect(document.querySelector(".prop-kind")!.textContent).toMatch(/Внешний пул/);
      fireEvent.doubleClick(document.querySelector("[data-pool-id]")!);
      const input = document.querySelector(".studio input.bpe-rename") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "Новые поставщики" } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(document.querySelector("[data-pool-id]")!.textContent).toContain("Новые поставщики");

      fireEvent.pointerDown(document.querySelector("[data-message-id]")!, { button: 0, pointerId: 1 });
      fireEvent.pointerUp(svgEl(), { pointerId: 1 });
      expect(document.querySelector(".prop-kind")!.textContent).toMatch(/Поток сообщений/);
      fireEvent.keyDown(document.querySelector(".bpe-root") ?? svgEl(), { key: "Delete" });
      expect(document.querySelector("[data-message-id]")).toBeNull();
    });

    it("поток сообщений переименовывается двойным щелчком по линии", () => {
      studio(withPool());
      fireEvent.doubleClick(document.querySelector("[data-message-id]")!);
      const input = document.querySelector(".studio input.bpe-rename") as HTMLInputElement;
      expect(input.value).toBe("Запрос предложений");
      fireEvent.change(input, { target: { value: "Запрос цен" } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(svgEl().textContent).toContain("Запрос цен");
    });
  });

  it("значок документа можно перетащить: он смещается, задача остаётся на месте, отмена возвращает значок", () => {
    const m = structuredModel();
    m.nodes.find((n) => n.id === "b1")!.inputs = ["d1"];
    studio(m);
    const icon = () => document.querySelector('[data-artifact-kind="input"]')!;
    const spot = () => icon().querySelector("g path")!.getAttribute("d");
    const task = () => document.querySelector('.studio g[data-node-id="b1"] rect')!.getAttribute("x");
    const [before, taskBefore] = [spot(), task()];
    fireEvent.pointerDown(icon(), { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(document.querySelector(".studio svg.bpe-svg")!, { pointerId: 1, clientX: 160, clientY: 130 });
    fireEvent.pointerUp(document.querySelector(".studio svg.bpe-svg")!, { pointerId: 1, clientX: 160, clientY: 130 });
    expect(spot()).not.toBe(before);
    expect(task()).toBe(taskBefore);
    fireEvent.keyDown(document.querySelector(".studio .bpe-root, .studio")!, { key: "z", ctrlKey: true });
    expect(spot()).toBe(before);
  });

  it("ArtifactShape: подсказка с названием и видом, у хранилища нет стрелки", () => {
    const art = { key: "k", nodeId: "t", kind: "store" as const, entityId: "s", name: "ELMA365", box: { x: 0, y: 0, w: 22, h: 26 }, edge: [[11, 26], [11, 40]] as [number, number][] };
    const { container } = render(
      <svg>
        <ArtifactShape artifact={art} />
        <ArtifactShape artifact={{ ...art, kind: "input", name: "Заявка" }} />
      </svg>
    );
    const titles = [...container.querySelectorAll("title")].map((t) => t.textContent);
    expect(titles).toEqual(["Хранилище данных: ELMA365", "Входной документ: Заявка"]);
    const paths = [...container.querySelectorAll("g[data-artifact] > path")];
    expect(paths[0].getAttribute("marker-end")).toBeNull();
    expect(paths[1].getAttribute("marker-end")).toMatch(/arrow-thin/);
  });
});
