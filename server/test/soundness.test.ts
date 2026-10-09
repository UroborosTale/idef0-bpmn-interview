import { describe, expect, it } from "vitest";
import { analyzeSoundness, type SoundNode } from "../src/shared/soundness.js";
import { validateModel } from "../src/pipeline/validate.js";
import { branchingModel } from "./fixtures.js";

const start = (id = "s"): SoundNode => ({ id, type: "event", subtype: "start", name: "Начало" });
const end = (id = "e", extra: Partial<SoundNode> = {}): SoundNode => ({ id, type: "event", subtype: "end", name: "Конец", ...extra });
const task = (id: string, extra: Partial<SoundNode> = {}): SoundNode => ({ id, type: "task", name: `шаг ${id}`, ...extra });
const gw = (id: string, subtype: string): SoundNode => ({ id, type: "gateway", subtype, name: `шлюз ${id}` });
const chain = (...ids: string[]) => ids.slice(1).map((to, i) => ({ from: ids[i], to }));

describe("анализ корректности BPMN (игра токенов)", () => {
  it("линейный процесс корректен", () => {
    const r = analyzeSoundness([start(), task("a"), task("b"), end()], chain("s", "a", "b", "e"));
    expect(r).toMatchObject({ analyzed: true, deadlocks: [], livelocks: [], unsynchronized: [] });
  });

  it("XOR-развилка и XOR-слияние корректны", () => {
    const nodes = [start(), gw("x", "exclusive"), task("a"), task("b"), gw("m", "exclusive"), end()];
    const flows = [...chain("s", "x"), { from: "x", to: "a" }, { from: "x", to: "b" }, { from: "a", to: "m" }, { from: "b", to: "m" }, ...chain("m", "e")];
    expect(analyzeSoundness(nodes, flows)).toMatchObject({ deadlocks: [], livelocks: [], unsynchronized: [] });
  });

  it("AND-развилка и AND-слияние корректны", () => {
    const nodes = [start(), gw("p", "parallel"), task("a"), task("b"), gw("j", "parallel"), end()];
    const flows = [...chain("s", "p"), { from: "p", to: "a" }, { from: "p", to: "b" }, { from: "a", to: "j" }, { from: "b", to: "j" }, ...chain("j", "e")];
    expect(analyzeSoundness(nodes, flows)).toMatchObject({ deadlocks: [], livelocks: [], unsynchronized: [] });
  });

  it("XOR-развилка и AND-слияние — блокировка", () => {
    const nodes = [start(), gw("x", "exclusive"), task("a"), task("b"), gw("j", "parallel"), end()];
    const flows = [...chain("s", "x"), { from: "x", to: "a" }, { from: "x", to: "b" }, { from: "a", to: "j" }, { from: "b", to: "j" }, ...chain("j", "e")];
    const r = analyzeSoundness(nodes, flows);
    expect(r.deadlocks).toHaveLength(1); // застрять можно с токеном от a или от b, но ждёт всегда один шлюз — это одна блокировка
    expect(r.deadlocks[0].waiting).toEqual(["j"]);
    expect(r.deadlocks[0].trace).toContain("шлюз x");
  });

  it("AND-развилка и XOR-слияние — нет синхронизации", () => {
    const nodes = [start(), gw("p", "parallel"), task("a"), task("b"), gw("m", "exclusive"), task("c"), end()];
    const flows = [...chain("s", "p"), { from: "p", to: "a" }, { from: "p", to: "b" }, { from: "a", to: "m" }, { from: "b", to: "m" }, ...chain("m", "c", "e")];
    const r = analyzeSoundness(nodes, flows);
    expect(r.unsynchronized.map((u) => u.node)).toEqual(["m"]);
    expect(r.deadlocks).toEqual([]);
  });

  it("цикл доработки с выходом корректен", () => {
    const m = branchingModel();
    const r = analyzeSoundness(m.nodes, m.flows);
    expect(r).toMatchObject({ analyzed: true, deadlocks: [], livelocks: [], unsynchronized: [] });
  });

  it("цикл без выхода — livelock", () => {
    const nodes = [start(), task("a"), gw("x", "exclusive"), task("b")];
    const flows = [...chain("s", "a", "x"), { from: "x", to: "b" }, { from: "x", to: "a" }, { from: "b", to: "a" }];
    const r = analyzeSoundness(nodes, flows);
    expect(r.deadlocks).toEqual([]);
    expect(r.livelocks.length).toBeGreaterThan(0);
  });

  it("включающий шлюз: OR-развилка и OR-слияние корректны", () => {
    const nodes = [start(), gw("o", "inclusive"), task("a"), task("b"), gw("j", "inclusive"), end()];
    const flows = [...chain("s", "o"), { from: "o", to: "a" }, { from: "o", to: "b" }, { from: "a", to: "j" }, { from: "b", to: "j" }, ...chain("j", "e")];
    expect(analyzeSoundness(nodes, flows)).toMatchObject({ deadlocks: [], livelocks: [], unsynchronized: [] });
  });

  it("граничное событие: ветка по таймеру и основная сходятся — корректно", () => {
    const nodes = [start(), task("a"), { id: "t", type: "event", subtype: "timer", name: "Вышло время", attached_to: "a" }, task("esc"), task("b"), end()];
    const flows = [...chain("s", "a", "b", "e"), ...chain("t", "esc", "e")];
    expect(analyzeSoundness(nodes, flows)).toMatchObject({ analyzed: true, deadlocks: [], livelocks: [], unsynchronized: [] });
  });

  it("терминатор гасит параллельные ветки", () => {
    const nodes = [start(), gw("p", "parallel"), task("a"), task("b"), end("e1", { trigger: { type: "terminate" } }), task("c")];
    const flows = [...chain("s", "p"), { from: "p", to: "a" }, { from: "p", to: "b" }, ...chain("a", "e1"), ...chain("b", "c")];
    const r = analyzeSoundness(nodes, flows);
    expect(r.deadlocks).toEqual([]);
    expect(r.livelocks).toEqual([]);
  });

  // параллельное согласование: одна ветка может закончиться отказом, другая идёт к параллельному слиянию
  const approval = (rejectEnd: SoundNode) => {
    const nodes = [start(), gw("p", "parallel"), task("a"), gw("x", "exclusive"), rejectEnd, task("b"), gw("j", "parallel"), end()];
    const flows = [...chain("s", "p"), { from: "p", to: "a" }, { from: "p", to: "b" }, ...chain("a", "x"), { from: "x", to: "j" }, { from: "x", to: rejectEnd.id }, { from: "b", to: "j" }, ...chain("j", "e")];
    return analyzeSoundness(nodes, flows);
  };

  it("обычный конец закрывает только свою ветку: параллельная ветка застревает на слиянии", () => {
    const r = approval(end("rej"));
    expect(r.deadlocks).toHaveLength(1);
    expect(r.deadlocks[0]).toMatchObject({ waiting: ["j"], afterEnd: true });
  });

  it("конец «Завершение» и «Ошибка» останавливают весь процесс", () => {
    for (const type of ["terminate", "error"]) expect(approval(end("rej", { trigger: { type } })).deadlocks, type).toEqual([]);
  });

  it("начальные события, сходящиеся в параллельный шлюз, наступают вместе", () => {
    const nodes = [start("s1"), start("s2"), gw("j", "parallel"), task("a"), end()];
    const flows = [{ from: "s1", to: "j" }, { from: "s2", to: "j" }, ...chain("j", "a", "e")];
    expect(analyzeSoundness(nodes, flows)).toMatchObject({ deadlocks: [], livelocks: [], unsynchronized: [] });
  });

  it("начальные события-альтернативы, сходящиеся в исключающий шлюз, корректны", () => {
    const nodes = [start("s1"), start("s2"), gw("m", "exclusive"), task("a"), end()];
    const flows = [{ from: "s1", to: "m" }, { from: "s2", to: "m" }, ...chain("m", "a", "e")];
    expect(analyzeSoundness(nodes, flows)).toMatchObject({ deadlocks: [], livelocks: [], unsynchronized: [] });
  });

  it("повторяющаяся ветка в цикле доработки не считается нехваткой синхронизации", () => {
    // задача с непрерывающим таймером-напоминанием в цикле: напоминание не успевает уйти, а цикл идёт снова
    const nodes = [start(), gw("m", "exclusive"), task("fill"), { id: "t", type: "event", subtype: "timer", name: "Прошёл день", attached_to: "fill", interrupting: false } as SoundNode, task("remind"), gw("ok", "exclusive"), end("e2")];
    const flows = [...chain("s", "m", "fill", "ok"), { from: "ok", to: "m" }, { from: "ok", to: "e2" }, ...chain("t", "remind")];
    expect(analyzeSoundness(nodes, flows)).toMatchObject({ analyzed: true, deadlocks: [], livelocks: [], unsynchronized: [] });
  });

  it("слишком большая диаграмма не разбирается", () => {
    // 16 параллельных веток дают 2^16 состояний
    const branches = Array.from({ length: 16 }, (_, i) => task(`t${i}`));
    const nodes = [start(), gw("p", "parallel"), ...branches, gw("j", "parallel"), end()];
    const flows = [...chain("s", "p"), ...branches.flatMap((b) => [{ from: "p", to: b.id }, { from: b.id, to: "j" }]), ...chain("j", "e")];
    expect(analyzeSoundness(nodes, flows).analyzed).toBe(false);
  });
});

describe("анализ корректности в проверках модели", () => {
  it("XOR → AND: ошибка bpmn_deadlock с подсказкой и привязкой к шлюзу", () => {
    const m = branchingModel();
    m.nodes = [
      { ...m.nodes[0] },
      { ...m.nodes[1], id: "a", name: "проверить договор" },
      { ...m.nodes[2], id: "x", name: "Есть замечания?" },
      { ...m.nodes[1], id: "b", name: "вернуть на доработку" },
      { ...m.nodes[1], id: "c", name: "подписать договор" },
      { ...m.nodes[2], id: "j", subtype: "parallel", name: "Всё готово?" },
      { ...m.nodes[6] },
    ];
    m.flows = [
      { id: "1", from: "s", to: "a" }, { id: "2", from: "a", to: "x" }, { id: "3", from: "x", to: "b" }, { id: "4", from: "x", to: "c" },
      { id: "5", from: "b", to: "j" }, { id: "6", from: "c", to: "j" }, { id: "7", from: "j", to: "e" },
    ].map((f) => ({ ...f, source: [], confirmed_by: [] }));
    const issue = validateModel(m).find((i) => i.rule === "bpmn_deadlock");
    expect(issue?.severity).toBe("error");
    expect(issue?.element_id).toBe("j");
    expect(issue?.message).toContain("Всё готово?");
  });

  it("корректная ветвящаяся схема не получает замечаний о поведении", () => {
    const rules = validateModel(branchingModel()).map((i) => i.rule);
    for (const r of ["bpmn_deadlock", "bpmn_possible_livelock", "bpmn_lack_of_sync"]) expect(rules).not.toContain(r);
  });
});

