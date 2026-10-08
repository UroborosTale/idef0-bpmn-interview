import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { issueKey, splitAccepted, validateModel } from "@shared/validate";
import { api } from "../../api/client";
import { session, structuredModel } from "../../test/fixtures";
import type { ProcessLogicModel, ValidationIssue } from "../../types";
import ProblemsPanel from "./ProblemsPanel";
import Studio from "./Studio";
import { acceptIssue, normalizedProcessCode, quickFixFor, revokeAcceptance } from "./quick-fixes";

type M = ProcessLogicModel;

const issuesOf = (m: M, rule: string, element?: string) => validateModel(m).filter((i) => i.rule === rule && (element === undefined || i.element_id === element));
const flow = (id: string, from: string, to: string, condition: string | null = null) => ({ id, from, to, condition, source: [], confirmed_by: [] });
const node = (m: M, id: string) => m.nodes.find((n) => n.id === id)!;

/** Применяет исправление к первому замечанию правила и проверяет, что замечание исчезло. */
function fixAndCheck(m: M, rule: string, element?: string, optionId?: string): M {
  const issue = issuesOf(m, rule, element)[0];
  expect(issue, `есть замечание ${rule}`).toBeTruthy();
  const fix = quickFixFor(m, issue);
  expect(fix, `есть исправление для ${rule}`).toBeTruthy();
  const next = fix!.apply(m, optionId);
  expect(issuesOf(next, rule, element), `${rule} после исправления`).toEqual([]);
  return next;
}

describe("быстрые исправления замечаний", () => {
  it("код процесса приводится к шаблону: b2, В-002, c15 → B002.00.00", () => {
    expect(normalizedProcessCode("b2")).toBe("B002.00.00");
    expect(normalizedProcessCode(" В-002 ")).toBe("B002.00.00");
    expect(normalizedProcessCode("c15")).toBe("C015.00.00");
    expect(normalizedProcessCode("A001.00.00")).toBe("A001.00.00");
    expect(normalizedProcessCode("Z1")).toBeNull();
    expect(normalizedProcessCode("процесс")).toBeNull();
    const m = structuredModel();
    m.process.code = "b2"; // не по шаблону — код процесса не распознан, правило действует
    const issue = validateModel(m).find((i) => i.rule === "process_code_format")!;
    expect(issue).toBeTruthy();
    const fix = quickFixFor(m, issue)!;
    expect(fix.label).toBe("Привести код к виду B002.00.00");
    expect(fix.apply(m).process.code).toBe("B002.00.00");
    // код уже верный или не разбирается — исправления нет
    m.process.code = "Z1";
    expect(quickFixFor(m, validateModel(m).find((i) => i.rule === "process_code_format")!)).toBeNull();
  });

  it("лишний шлюз: один вход и выход — соседние шаги соединяются, условие сохраняется; без входа или выхода — шлюз удаляется", () => {
    const m = structuredModel();
    m.nodes.push({ ...node(m, "b1"), id: "g1", type: "gateway", subtype: "exclusive", name: "Лишний", system_ids: [] });
    m.flows = [flow("bf1", "b0", "b1"), flow("x1", "b1", "g1"), flow("x2", "g1", "b2", "да"), flow("bf3", "b2", "b9")];
    const next = fixAndCheck(m, "bpmn_gateway_unbalanced", "g1");
    expect(next.nodes.some((n) => n.id === "g1")).toBe(false);
    expect(next.flows.filter((f) => f.from === "b1" && f.to === "b2")).toHaveLength(1);
    expect(next.flows.find((f) => f.from === "b1" && f.to === "b2")!.condition).toBe("да");
    expect(next.flows.some((f) => f.from === "g1" || f.to === "g1")).toBe(false);

    const dangling = structuredModel();
    dangling.nodes.push({ ...node(dangling, "b1"), id: "g2", type: "gateway", subtype: "exclusive", name: "Висит" });
    dangling.flows.push(flow("y1", "b1", "g2"));
    const removed = fixAndCheck(dangling, "bpmn_gateway_unbalanced", "g2");
    expect(removed.flows.some((f) => f.to === "g2")).toBe(false);
  });

  it("петля IDEF0: из входов и управления-данных убирается то, что функция сама выпускает", () => {
    const m = structuredModel();
    node(m, "o1").inputs.push("d2");
    const next = fixAndCheck(m, "idef0_self_loop", "o1");
    expect(node(next, "o1").inputs).toEqual(["d1"]);
    expect(node(next, "o1").outputs).toEqual(["d2"]);
  });

  it("граничное событие: открепить от несуществующей задачи; убрать входящие стрелки", () => {
    const lost = structuredModel();
    lost.nodes.push({ ...node(lost, "b0"), id: "be", type: "event", subtype: "timer", name: "Срок истёк", attached_to: "нет" });
    const detached = fixAndCheck(lost, "bpmn_boundary_no_host", "be");
    expect(node(detached, "be").attached_to).toBeNull();

    const m = structuredModel();
    m.nodes.push({ ...node(m, "b0"), id: "be", type: "event", subtype: "timer", name: "Срок истёк", attached_to: "b1" });
    m.flows.push(flow("bad", "b2", "be"), flow("ok", "be", "b9"));
    const next = fixAndCheck(m, "bpmn_boundary_incoming", "be");
    expect(next.flows.some((f) => f.to === "be")).toBe(false);
    expect(next.flows.some((f) => f.from === "be")).toBe(true);
  });

  it("поток сообщений от шлюза или таймера убирается", () => {
    const m = structuredModel();
    m.pools.push({ id: "x1", name: "Внешний участник" });
    node(m, "b9"); // конец; таймер ниже
    m.nodes.push({ ...node(m, "b0"), id: "tm", type: "event", subtype: "timer", name: "Через 3 дня" });
    m.messages.push({ id: "m1", from: "tm", to: "x1" });
    const next = fixAndCheck(m, "bpmn_message_endpoint", "tm");
    expect(next.messages).toEqual([]);
    expect(next.pools).toHaveLength(1); // пул остаётся
  });

  it("исполнитель операции: по шагам диаграммы — сразу; без шагов — выбор должности", () => {
    const withSteps = structuredModel();
    withSteps.nodes.push({ ...node(withSteps, "b1"), id: "s1x", name: "Шаг", bpmn_scope: "o2", role_id: "r3" }, { ...node(withSteps, "b1"), id: "s2x", name: "Ещё шаг", bpmn_scope: "o2", role_id: "r3" });
    const issue = issuesOf(withSteps, "role_no_executor", "o2")[0];
    const fix = quickFixFor(withSteps, issue)!;
    expect(fix.options).toBeUndefined();
    expect(fix.label).toContain(withSteps.roles.find((r) => r.id === "r3")!.name);
    const next = fixAndCheck(withSteps, "role_no_executor", "o2");
    expect(next.assignments.filter((a) => a.node_id === "o2")).toEqual([{ node_id: "o2", role_id: "r3", kind: "executor", functions: [] }]);
    expect(node(next, "o2").role_id).toBe("r3");

    const bare = structuredModel();
    const chooser = quickFixFor(bare, issuesOf(bare, "role_no_executor", "o2")[0])!;
    expect(chooser.options!.map((o) => o.id)).toEqual(["r1", "r2", "r3"]);
    const chosen = fixAndCheck(bare, "role_no_executor", "o2", "r2");
    expect(chosen.assignments.some((a) => a.node_id === "o2" && a.role_id === "r2" && a.kind === "executor")).toBe(true);
    expect(chooser.apply(bare)).toBe(bare); // без выбора ничего не меняется
  });

  it("владелец процесса и подпроцесса: выбор должности", () => {
    const m = structuredModel();
    const sub = fixAndCheck(m, "role_no_owner", "s2", "r1");
    expect(sub.assignments.some((a) => a.node_id === "s2" && a.role_id === "r1" && a.kind === "owner")).toBe(true);
    const bare = structuredModel();
    bare.assignments = [];
    const proc = issuesOf(bare, "role_no_owner").find((i) => i.element_id === null)!;
    const fixed = quickFixFor(bare, proc)!.apply(bare, "r1");
    expect(fixed.assignments).toEqual([{ node_id: null, role_id: "r1", kind: "owner", functions: [] }]);
    const noRoles = structuredModel();
    noRoles.roles = [];
    noRoles.assignments = [];
    expect(quickFixFor(noRoles, proc)).toBeNull();
  });

  it("операция без диаграммы: заготовка «начало → шаг → конец» с дорожкой исполнителя и позициями", () => {
    const m = structuredModel();
    const next = fixAndCheck(m, "operation_no_bpmn", "o3");
    const steps = next.nodes.filter((n) => n.bpmn_scope === "o3");
    expect(steps.map((n) => [n.type, n.subtype ?? "", n.name])).toEqual([
      ["event", "start", "Операция запущена"],
      ["task", "user", "Анализ соответствия"],
      ["event", "end", "Операция завершена"],
    ]);
    expect(steps.every((n) => n.role_id === "r2" && n.layout)).toBe(true); // o3 исполняет r2
    expect(next.flows.filter((f) => steps.some((s) => s.id === f.from))).toHaveLength(2);
    // события заготовки сформулированы фактами, остальные замечания по ней молчат
    expect(validateModel(next).filter((i) => i.element_id && steps.some((s) => s.id === i.element_id))).toEqual([]);
  });

  it("тупик потока: соединить с единственным концом или добавить новый конец", () => {
    const m = structuredModel();
    m.nodes.push({ ...node(m, "b1"), id: "b3", name: "Сообщить руководителю", layout: { x: 600, y: 100 } });
    m.flows.push(flow("x1", "b1", "b3"));
    const joined = fixAndCheck(m, "bpmn_dead_end", "b3");
    expect(joined.flows.some((f) => f.from === "b3" && f.to === "b9")).toBe(true);

    const twoEnds = structuredModel();
    twoEnds.nodes.push({ ...node(twoEnds, "b9"), id: "b8", name: "Другой конец" }, { ...node(twoEnds, "b1"), id: "b3", name: "Сообщить руководителю", layout: { x: 600, y: 100 } });
    twoEnds.flows.push(flow("x1", "b1", "b3"));
    const fresh = fixAndCheck(twoEnds, "bpmn_dead_end", "b3");
    const added = fresh.nodes.find((n) => n.name === "Операция завершена")!;
    expect(added).toMatchObject({ type: "event", subtype: "end", bpmn_scope: "o1", role_id: node(twoEnds, "b3").role_id });
    expect(added.layout!.x).toBeGreaterThan(600);
    expect(fresh.flows.some((f) => f.from === "b3" && f.to === added.id)).toBe(true);
  });

  it("разветвление и слияние без шлюза: вставляется шлюз, стрелки переключаются на него", () => {
    const split = structuredModel();
    split.nodes.push({ ...node(split, "b1"), id: "b3", name: "Третий шаг" });
    split.flows.push(flow("x1", "b1", "b3"));
    const after = fixAndCheck(split, "bpmn_split_without_gateway", "b1");
    const gw = after.nodes.find((n) => n.type === "gateway")!;
    expect(after.flows.filter((f) => f.from === "b1")).toEqual([expect.objectContaining({ to: gw.id })]);
    expect(after.flows.filter((f) => f.from === gw.id).map((f) => f.to).sort()).toEqual(["b2", "b3"]);

    const merge = structuredModel();
    merge.nodes.push({ ...node(merge, "b1"), id: "b3", name: "Параллельный шаг" });
    merge.flows.push(flow("x1", "b0", "b3"), flow("x2", "b3", "b2"));
    const before = fixAndCheck(merge, "bpmn_merge_without_gateway", "b2");
    const g = before.nodes.find((n) => n.type === "gateway")!;
    expect(before.flows.filter((f) => f.to === "b2")).toEqual([expect.objectContaining({ from: g.id })]);
    expect(before.flows.filter((f) => f.to === g.id)).toHaveLength(2);
    expect(g.layout!.x).toBeLessThan(node(before, "b2").layout!.x);
  });

  it("код источника продукта: очистить поле поставщика или потребителя", () => {
    const m = structuredModel();
    m.data.find((d) => d.id === "d3")!.supplier = "Операция B002.09.09";
    const next = fixAndCheck(m, "data_ref_unknown_code", "d3");
    expect(next.data.find((d) => d.id === "d3")!.supplier).toBeNull();
    const c = structuredModel();
    c.data.find((d) => d.id === "d3")!.consumer = "Операция B002.09.09";
    expect(fixAndCheck(c, "data_ref_unknown_code", "d3").data.find((d) => d.id === "d3")!.consumer).toBeNull();
  });

  it("для замечаний без однозначного решения исправления нет", () => {
    const m = structuredModel();
    for (const issue of validateModel(m).filter((i) => ["idef0_block_count", "data_no_supplier", "data_no_consumer"].includes(i.rule))) expect(quickFixFor(m, issue)).toBeNull();
  });
});

describe("принятые замечания", () => {
  const warn = (m: M, rule: string) => validateModel(m).find((i) => i.rule === rule)!;

  it("принятое предупреждение уходит из действующих с причиной; ошибки принять нельзя", () => {
    let m = structuredModel();
    const issue = warn(m, "operation_no_bpmn");
    m = acceptIssue(m, issue, "  Диаграмма будет после интервью  ");
    const all = validateModel(m);
    const { active, accepted } = splitAccepted(m.accepted_issues, all);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({ rule: "operation_no_bpmn", element_id: "o2", reason: "Диаграмма будет после интервью" });
    expect(active.some((i) => i.rule === "operation_no_bpmn" && i.element_id === "o2")).toBe(false);
    expect(active.some((i) => i.rule === "operation_no_bpmn" && i.element_id === "o3")).toBe(true); // другая операция — по-прежнему замечание
    expect(m.accepted_issues[0].at).toMatch(/^\d{4}-\d\d-\d\dT/);
    // ошибка остаётся действующей, даже если запись о принятии есть
    const err: ValidationIssue = { id: "e", notation: "BPMN", severity: "error", rule: "bpmn_dead_end", message: "тупик", element_id: "x" };
    const split = splitAccepted([{ rule: "bpmn_dead_end", element_id: "x", reason: "нельзя" }], [err]);
    expect(split.active).toEqual([err]);
    expect(split.accepted).toEqual([]);
  });

  it("замечание без элемента принимается по тексту: изменился текст — принятие не действует", () => {
    let m = structuredModel();
    const issue = warn(m, "data_no_supplier");
    expect(issue.element_id === "d1" ? issueKey(issue) : issueKey(issue)).toContain("data_no_supplier");
    const global: ValidationIssue = { id: "g", notation: "IDEF0", severity: "warning", rule: "idef0_block_count", message: "На A0 2 функции", element_id: null };
    m = acceptIssue(m, global, "Процесс небольшой");
    expect(m.accepted_issues[0]).toMatchObject({ element_id: null, message: "На A0 2 функции" });
    expect(splitAccepted(m.accepted_issues, [global]).accepted).toHaveLength(1);
    expect(splitAccepted(m.accepted_issues, [{ ...global, message: "На A0 7 функций" }]).accepted).toHaveLength(0);
  });

  it("повторное принятие заменяет причину, «Вернуть» снимает принятие", () => {
    let m = structuredModel();
    const issue = warn(m, "operation_no_bpmn");
    m = acceptIssue(m, issue, "первая причина");
    m = acceptIssue(m, issue, "вторая причина");
    expect(m.accepted_issues).toHaveLength(1);
    expect(m.accepted_issues[0].reason).toBe("вторая причина");
    m = revokeAcceptance(m, issue);
    expect(m.accepted_issues).toEqual([]);
    expect(splitAccepted(m.accepted_issues, validateModel(m)).accepted).toEqual([]);
  });
});

describe("панель проверок: исправить и принять", () => {
  const issues = (m: M) => validateModel(m);
  const panel = (extra: Partial<Parameters<typeof ProblemsPanel>[0]> = {}) => {
    const m = structuredModel();
    const onFix = vi.fn();
    const onAccept = vi.fn();
    const onRevoke = vi.fn();
    const onGoto = vi.fn();
    render(<ProblemsPanel model={m} issues={issues(m)} onGoto={onGoto} fixFor={(i) => quickFixFor(m, i)} onFix={onFix} onAccept={onAccept} onRevoke={onRevoke} {...extra} />);
    return { m, onFix, onAccept, onRevoke, onGoto };
  };
  const row = (rule: string, element?: string) => [...document.querySelectorAll(`[data-issue-rule="${rule}"]`)].find((r) => !element || r.textContent!.includes(element)) as HTMLElement;

  it("кнопка «Исправить» у замечаний с исправлением; у остальных её нет", () => {
    const { onFix, onGoto } = panel();
    expect(within(row("operation_no_bpmn")).getByText("Исправить")).toBeTruthy();
    expect(within(row("idef0_block_count")).queryByText("Исправить")).toBeNull();
    fireEvent.click(within(row("operation_no_bpmn")).getByText("Исправить"));
    expect(onFix).toHaveBeenCalledWith(expect.objectContaining({ rule: "operation_no_bpmn" }), expect.objectContaining({ label: "Создать заготовку диаграммы BPMN" }));
    expect(onGoto).not.toHaveBeenCalled(); // нажатие на кнопку не открывает диаграмму
  });

  it("исправление с выбором: список должностей, выбор применяет исправление", () => {
    const { onFix } = panel();
    const select = within(row("role_no_owner")).getByLabelText("Назначить владельца…") as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(["Назначить владельца…", ...structuredModel().roles.map((r) => r.name)]);
    fireEvent.change(select, { target: { value: "r1" } });
    expect(onFix).toHaveBeenCalledWith(expect.objectContaining({ rule: "role_no_owner" }), expect.objectContaining({ label: "Назначить владельца…" }), "r1");
  });

  it("принять: причина обязательна; Enter и кнопка принимают, «Отмена» закрывает", () => {
    const { onAccept } = panel();
    fireEvent.click(within(row("operation_no_bpmn")).getByText("Принять…"));
    const input = screen.getByPlaceholderText("Почему принимаем (запишем в модель)");
    const confirm = screen.getByRole("button", { name: "Принять" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "   " } });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "Так в документе" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onAccept).toHaveBeenCalledWith(expect.objectContaining({ rule: "operation_no_bpmn" }), "Так в документе");
    expect(screen.queryByPlaceholderText("Почему принимаем (запишем в модель)")).toBeNull();
    fireEvent.click(within(row("operation_no_bpmn")).getByText("Принять…"));
    fireEvent.click(screen.getByText("Отмена"));
    expect(screen.queryByPlaceholderText("Почему принимаем (запишем в модель)")).toBeNull();
  });

  it("ошибки принять нельзя: у них нет кнопки «Принять…»", () => {
    const m = structuredModel();
    m.flows = m.flows.filter((f) => f.id !== "bf3"); // b2 без продолжения при наличии конца — ошибка «тупик»
    const err = validateModel(m).find((i) => i.severity === "error")!;
    expect(err).toBeTruthy();
    render(<ProblemsPanel model={m} issues={validateModel(m)} onGoto={vi.fn()} onAccept={vi.fn()} fixFor={(i) => quickFixFor(m, i)} />);
    const errRow = document.querySelector(`.problem-row.error`)!;
    expect(within(errRow as HTMLElement).queryByText("Принять…")).toBeNull();
  });

  it("принятые: по флажку, с причиной, «Вернуть»; в счётчик не входят", () => {
    const m = structuredModel();
    const all = issues(m);
    const target = all.find((i) => i.rule === "operation_no_bpmn" && i.element_id === "o2")!;
    const accepted = [{ ...target, reason: "Диаграмма будет позже", at: null }];
    const { onRevoke } = panel({ issues: all.filter((i) => i !== target), acceptedIssues: accepted });
    expect(document.querySelectorAll("[data-accepted-rule]")).toHaveLength(0);
    fireEvent.click(screen.getByLabelText(/принятые \(1\)/));
    const acc = document.querySelector("[data-accepted-rule='operation_no_bpmn']") as HTMLElement;
    expect(acc.textContent).toContain("принято: Диаграмма будет позже");
    fireEvent.click(within(acc).getByText("Вернуть"));
    expect(onRevoke).toHaveBeenCalledWith(expect.objectContaining({ element_id: "o2" }));
    expect(document.querySelector(".problems-head .pill-count.warn")!.textContent).toBe(String(all.length - 1));
  });

  it("группировка по правилам: заголовки с числом замечаний и порядком", () => {
    panel();
    fireEvent.click(screen.getByLabelText("по правилам"));
    const heads = [...document.querySelectorAll(".problem-group")].map((h) => h.textContent);
    expect(heads).toContain("Операция без диаграммы BPMN 2");
    expect(heads.length).toBe(new Set(issues(structuredModel()).map((i) => i.rule)).size);
    const rules = [...document.querySelectorAll("[data-issue-rule]")].map((r) => r.getAttribute("data-issue-rule"));
    // замечания одного правила идут подряд
    const compact = rules.filter((r, i) => r !== rules[i - 1]);
    expect(compact.length).toBe(new Set(rules).size);
  });
});

describe("студия: исправить и принять", () => {
  const open = () => {
    vi.spyOn(api, "listProposals").mockResolvedValue([]);
    vi.spyOn(api, "listTasks").mockResolvedValue([]);
    const onSave = vi.fn(async (_: M) => true);
    render(<Studio session={session(structuredModel())} busy={false} onSave={onSave} />);
    return { onSave };
  };
  const status = () => document.querySelector(".statusbar")!.textContent!;
  const row = (rule: string, text?: string) => [...document.querySelectorAll(`[data-issue-rule="${rule}"]`)].find((r) => !text || r.textContent!.includes(text)) as HTMLElement;

  it("«Исправить» применяет исправление шагом истории: замечание исчезает, Ctrl+Z возвращает", async () => {
    const { onSave } = open();
    expect(status()).toMatch(/предупреждений: 7/);
    fireEvent.click(within(row("operation_no_bpmn", "B002.01.02")).getByText("Исправить"));
    expect(status()).toMatch(/предупреждений: 6/);
    expect(row("operation_no_bpmn", "B002.01.02")).toBeUndefined();
    expect(document.querySelector('[data-nav-bpmn="o2"]')!.className).toMatch(/\bon\b/); // у операции появилась диаграмма
    expect(status()).toContain("есть несохранённые изменения");
    fireEvent.click(screen.getByTitle("Отменить (Ctrl+Z)"));
    expect(status()).toMatch(/предупреждений: 7/);
    fireEvent.click(screen.getByTitle("Повторить (Ctrl+Y)"));
    await act(async () => fireEvent.click(screen.getByTitle("Сохранить (Ctrl+S)")));
    expect(onSave.mock.calls[0][0].nodes.filter((n) => n.bpmn_scope === "o2")).toHaveLength(3);
  });

  it("исправление с выбором: владелец подпроцесса назначается из списка", () => {
    open();
    const select = within(row("role_no_owner")).getByLabelText("Назначить владельца…");
    fireEvent.change(select, { target: { value: "r1" } });
    expect(row("role_no_owner")).toBeUndefined();
    expect(status()).toMatch(/предупреждений: 6/);
  });

  it("«Принять…» записывает причину в модель: счётчики падают, в строке состояния «принято: 1», Ctrl+Z отменяет; «Вернуть» возвращает", async () => {
    const { onSave } = open();
    fireEvent.click(within(row("idef0_block_count")).getByText("Принять…"));
    fireEvent.change(screen.getByPlaceholderText("Почему принимаем (запишем в модель)"), { target: { value: "Два подпроцесса — так в документе" } });
    fireEvent.click(screen.getByRole("button", { name: "Принять" }));
    expect(row("idef0_block_count")).toBeUndefined();
    expect(status()).toMatch(/предупреждений: 6/);
    expect(status()).toContain("принято: 1");

    fireEvent.click(screen.getByLabelText(/принятые \(1\)/));
    const acc = document.querySelector("[data-accepted-rule='idef0_block_count']") as HTMLElement;
    expect(acc.textContent).toContain("Два подпроцесса — так в документе");
    // отмена шага истории возвращает замечание
    fireEvent.click(screen.getByTitle("Отменить (Ctrl+Z)"));
    expect(status()).toMatch(/предупреждений: 7/);
    expect(status()).not.toContain("принято");
    fireEvent.click(screen.getByTitle("Повторить (Ctrl+Y)"));
    // «Вернуть» снимает принятие
    fireEvent.click(within(document.querySelector("[data-accepted-rule='idef0_block_count']") as HTMLElement).getByText("Вернуть"));
    expect(status()).toMatch(/предупреждений: 7/);
    // принятие сохраняется вместе с моделью
    fireEvent.click(within(row("idef0_block_count")).getByText("Принять…"));
    fireEvent.change(screen.getByPlaceholderText("Почему принимаем (запишем в модель)"), { target: { value: "Осознанно" } });
    fireEvent.click(screen.getByRole("button", { name: "Принять" }));
    await act(async () => fireEvent.click(screen.getByTitle("Сохранить (Ctrl+S)")));
    expect(onSave.mock.calls.at(-1)![0].accepted_issues).toEqual([expect.objectContaining({ rule: "idef0_block_count", element_id: null, reason: "Осознанно" })]);
  });
});
