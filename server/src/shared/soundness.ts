import { isBoundaryNode } from "./bpmnArtifacts.js";
import { eventSpec } from "./events.js";

/**
 * Анализ корректности (soundness) диаграммы BPMN по поведению, а не по структуре.
 *
 * Диаграмма переводится в сеть с токенами (workflow-сеть): место — стрелка потока, переход — срабатывание шага или шлюза.
 * Затем перебираются все достижимые состояния (игра токенов) и ищутся:
 *  - взаимная блокировка: процесс остановился, а токены остались (ветки разошлись исключающим шлюзом, а сходятся параллельным);
 *  - цикл без выхода: процесс продолжает работать, но завершиться уже не может;
 *  - нехватка синхронизации: на один шаг одновременно приходят потоки по двум входам (параллельные ветки слиты исключающим шлюзом).
 *
 * Правила: у шага несколько входящих стрелок без шлюза — каждая запускает шаг отдельно (неявное «ИЛИ»), несколько исходящих — все сразу
 * (неявное «И»). Условия на стрелках не вычисляются: любая ветка исключающего шлюза возможна. Включающий шлюз-слияние ждёт токены,
 * которые ещё могут до него дойти. Процесс завершён, когда токенов не осталось; конечные события «Завершение», «Ошибка» и «Отмена»
 * гасят все токены, обычное конец закрывает только свою ветку.
 * Узел без исходящих стрелок считается концом процесса (к нему генератор достраивает конечное событие).
 * Несколько начальных событий — альтернативы, кроме тех, что сходятся в один параллельный шлюз: они наступают вместе.
 */

export interface SoundNode {
  id: string;
  name: string;
  type: string;
  subtype?: string | null;
  trigger?: unknown;
  attached_to?: string | null;
  interrupting?: boolean | null;
}
export interface SoundFlow {
  from: string;
  to: string;
}

export interface SoundnessReport {
  /** false — диаграмма слишком велика для перебора (или не с чего начинать): проверка не проводилась. */
  analyzed: boolean;
  /** Остановки без завершения: узлы, перед которыми остались ждущие токены, и путь (названия шагов), которым процесс к этому пришёл. */
  deadlocks: { waiting: string[]; trace: string[]; afterEnd: boolean }[];
  /** Состояния, из которых процесс не может ни завершиться, ни остановиться: узлы, по которым ходят токены. */
  livelocks: { looping: string[]; trace: string[] }[];
  /** Шаги, на которые могут прийти сразу два потока по разным входам, и путь к этому. */
  unsynchronized: { node: string; trace: string[] }[];
}

export const MAX_STATES = 20000;
/** Конечные события, которые прерывают весь процесс, а не одну ветку: терминатор, ошибка (прерывает область) и отмена. */
const ENDS_ALL = new Set<string>(["terminate", "error", "cancel"]);
const MAX_FANOUT = 6;

interface Transition {
  /** Узел, чьё срабатывание это переход (для пути и мёртвых шагов). */
  node: string;
  consume: number[];
  produce: number[];
  /** Гасит все токены (терминатор). */
  clear?: boolean;
  /** Включающее слияние: срабатывает, когда по пустым входам больше ничего не придёт, и забирает токены со всех занятых входов. */
  orJoin?: number[];
}

const notAnalyzed = (): SoundnessReport => ({ analyzed: false, deadlocks: [], livelocks: [], unsynchronized: [] });

/** Непустые подмножества; у большого набора — только «все» и «по одному», чтобы не взрывать число переходов. */
function subsets<T>(arr: T[]): T[][] {
  if (arr.length > MAX_FANOUT) return [arr, ...arr.map((x) => [x])];
  const res: T[][] = [];
  for (let mask = 1; mask < 1 << arr.length; mask++) res.push(arr.filter((_, i) => mask & (1 << i)));
  return res;
}

export function analyzeSoundness(nodes: SoundNode[], flows: SoundFlow[]): SoundnessReport {
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const boundaryIds = new Set(nodes.filter((n) => isBoundaryNode(n as never, nodes as never)).map((n) => n.id));
  const boundaryOf = new Map<string, SoundNode[]>();
  for (const n of nodes) if (boundaryIds.has(n.id)) boundaryOf.set(n.attached_to!, [...(boundaryOf.get(n.attached_to!) ?? []), n]);

  // Место 0 — начало процесса, далее по месту на каждую стрелку; placeNode — узел, который ждёт токен в этом месте.
  const START = 0;
  const placeNode: string[] = [""];
  const newPlace = (node: string): number => placeNode.push(node) - 1;
  const ins = new Map<string, number[]>();
  const outs = new Map<string, number[]>();
  const add = (map: Map<string, number[]>, id: string, p: number) => map.set(id, [...(map.get(id) ?? []), p]);
  for (const f of flows) {
    if (!byId.has(f.from) || !byId.has(f.to)) continue;
    const p = newPlace(f.to);
    add(ins, f.to, p);
    add(outs, f.from, p);
  }
  const inOf = (id: string) => ins.get(id) ?? [];
  const outOf = (id: string) => outs.get(id) ?? [];

  // Точки входа: явные начальные события (экземпляр процесса начинается с одного из них) или, если их нет, все узлы без входящих стрелок.
  const starts = nodes.filter((n) => n.type === "event" && n.subtype === "start" && !boundaryIds.has(n.id));
  const entries = nodes.filter((n) => inOf(n.id).length === 0 && !boundaryIds.has(n.id));
  const sources = starts.length > 0 ? starts : entries;
  if (sources.length === 0) return notAnalyzed();

  const transitions: Transition[] = [];
  const entryPlace = (id: string): number => {
    const p = newPlace(id);
    add(ins, id, p);
    return p;
  };
  if (starts.length > 0) {
    // Начальные события, сходящиеся в один параллельный шлюз, — «процесс начинается, когда наступили все»: берём их вместе.
    const joinOf = (s: SoundNode): string | null => {
      const next = flows.filter((f) => f.from === s.id).map((f) => byId.get(f.to));
      return next.length === 1 && next[0]?.type === "gateway" && next[0].subtype === "parallel" ? next[0].id : null;
    };
    const groups = new Map<string, SoundNode[]>();
    for (const s of starts) groups.set(joinOf(s) ?? `alone:${s.id}`, [...(groups.get(joinOf(s) ?? `alone:${s.id}`) ?? []), s]);
    for (const group of groups.values()) transitions.push({ node: "", consume: [START], produce: group.map((s) => entryPlace(s.id)) });
  } else transitions.push({ node: "", consume: [START], produce: entries.map((e) => entryPlace(e.id)) });

  const spec = (n: SoundNode) => eventSpec(n as never, false);
  for (const n of nodes) {
    if (boundaryIds.has(n.id)) continue;
    const incoming = inOf(n.id);
    const outgoing = outOf(n.id);
    if (incoming.length === 0) continue; // недостижимый узел: о нём сообщает проверка достижимости

    if (n.type === "gateway") {
      const kind = n.subtype ?? "exclusive";
      if (kind === "parallel") {
        transitions.push({ node: n.id, consume: incoming, produce: outgoing });
      } else if (kind === "inclusive") {
        const outSets = outgoing.length <= 1 ? [outgoing] : subsets(outgoing);
        for (const produce of outSets) transitions.push(incoming.length > 1 ? { node: n.id, consume: [], produce, orJoin: incoming } : { node: n.id, consume: incoming, produce });
      } else {
        // исключающий и по событиям: из любого входа в любой выход
        for (const from of incoming) {
          if (outgoing.length === 0) transitions.push({ node: n.id, consume: [from], produce: [] });
          for (const to of outgoing) transitions.push({ node: n.id, consume: [from], produce: [to] });
        }
      }
      continue;
    }

    const isEnd = n.type === "event" && spec(n).position === "end";
    const stopsAll = isEnd && ENDS_ALL.has(spec(n).trigger);
    const hostBoundaries = boundaryOf.get(n.id) ?? [];
    if (hostBoundaries.length === 0) {
      for (const from of incoming) transitions.push({ node: n.id, consume: [from], produce: isEnd ? [] : outgoing, clear: stopsAll });
      continue;
    }

    // Задача с граничными событиями: вход → «выполняется» → выход, а пока она выполняется, сработает граничное событие.
    // Непрерывающее событие упрощено: при запуске задачи его ветка либо появляется, либо нет.
    const active = newPlace(n.id);
    const extras: number[][] = [[], ...subsets(hostBoundaries.filter((b) => b.interrupting === false)).map((set) => set.flatMap((b) => outOf(b.id)))];
    for (const from of incoming) for (const extra of extras) transitions.push({ node: n.id, consume: [from], produce: [active, ...extra] });
    transitions.push({ node: n.id, consume: [active], produce: outgoing });
    for (const b of hostBoundaries.filter((x) => x.interrupting !== false)) transitions.push({ node: b.id, consume: [active], produce: outOf(b.id) });
  }

  const placeCount = placeNode.length;

  // Включающее слияние: из каких мест токен ещё может дойти до входа (по стрелкам; сквозь сам шлюз не ходим).
  const upstreamCache = new Map<string, Map<number, Set<number>>>();
  const upstream = (join: string, inputs: number[]): Map<number, Set<number>> => {
    let cached = upstreamCache.get(join);
    if (cached) return cached;
    const prev: number[][] = Array.from({ length: placeCount }, () => []);
    for (let p = 1; p < placeCount; p++) {
      const node = placeNode[p];
      if (!node || node === join) continue;
      for (const q of [...outOf(node), ...(boundaryOf.get(node) ?? []).flatMap((b) => outOf(b.id))]) prev[q].push(p);
    }
    cached = new Map();
    for (const target of inputs) {
      const reach = new Set<number>([target]);
      const stack = [target];
      while (stack.length > 0) for (const q of prev[stack.pop()!]) if (!reach.has(q)) (reach.add(q), stack.push(q));
      cached.set(target, reach);
    }
    upstreamCache.set(join, cached);
    return cached;
  };

  const enabled = (m: number[], t: Transition): boolean => {
    if (!t.orJoin) return t.consume.every((p) => m[p] > 0);
    const marked = t.orJoin.filter((p) => m[p] > 0);
    if (marked.length === 0) return false;
    const reach = upstream(t.node, t.orJoin);
    for (const p of t.orJoin) {
      if (m[p] > 0) continue;
      for (let q = 1; q < placeCount; q++) if (m[q] > 0 && !marked.includes(q) && reach.get(p)!.has(q)) return false;
    }
    return true;
  };

  // --- перебор достижимых состояний ---
  const initial = new Array<number>(placeCount).fill(0);
  initial[START] = 1;
  const states: number[][] = [initial];
  const index = new Map<string, number>([[initial.join(","), 0]]);
  const parent: ({ from: number; node: string } | null)[] = [null];
  const succ: number[][] = [[]];
  const cutOff: boolean[] = [false]; // из состояния есть ход, оборванный из-за второго токена на стрелке

  for (let i = 0; i < states.length; i++) {
    if (states.length > MAX_STATES) return notAnalyzed();
    const m = states[i];
    for (const t of transitions) {
      if (!enabled(m, t)) continue;
      let next: number[];
      if (t.clear) next = new Array<number>(placeCount).fill(0);
      else {
        next = m.slice();
        for (const p of t.orJoin ?? []) if (next[p] > 0) next[p] -= 1;
        for (const p of t.consume) next[p] -= 1;
        for (const p of t.produce) next[p] += 1;
      }
      const over = t.produce.find((p) => next[p] > 1);
      if (over !== undefined) {
        // два токена на одной стрелке (работа копится в цикле): дальше этой ветки не идём, иначе число токенов не ограничено
        cutOff[i] = true;
        continue;
      }
      const k = next.join(",");
      let j = index.get(k);
      if (j === undefined) {
        j = states.length;
        index.set(k, j);
        states.push(next);
        parent.push({ from: i, node: t.node });
        succ.push([]);
        cutOff.push(false);
      }
      succ[i].push(j);
    }
  }

  // --- выводы ---
  const nameOf = (id: string) => byId.get(id)?.name ?? id;
  const traceTo = (state: number): string[] => {
    const path: string[] = [];
    for (let cur = state; parent[cur]; cur = parent[cur]!.from) if (parent[cur]!.node) path.unshift(nameOf(parent[cur]!.node));
    return path.filter((s, i) => s !== path[i - 1]).slice(-8); // путь — подсказка, где процесс свернул не туда
  };
  /** Путь к состоянию проходил через конечное событие: оно закрыло свою ветку, а остальные продолжились. */
  const passedEnd = (state: number): boolean => {
    for (let cur = state; parent[cur]; cur = parent[cur]!.from) {
      const n = byId.get(parent[cur]!.node);
      if (n?.type === "event" && spec(n).position === "end") return true;
    }
    return false;
  };
  const waitingNodes = (m: number[]) => [...new Set(m.flatMap((c, p) => (c > 0 && p > 0 ? [placeNode[p]] : [])))];
  const isEmpty = (m: number[]) => m.every((c) => c === 0);

  const rev: number[][] = states.map(() => []);
  states.forEach((_, i) => succ[i].forEach((j) => rev[j].push(i)));
  const backward = (seeds: number[]): boolean[] => {
    const marked = new Array<boolean>(states.length).fill(false);
    const queue = seeds.slice();
    for (const s of seeds) marked[s] = true;
    while (queue.length > 0) for (const p of rev[queue.pop()!]) if (!marked[p]) (marked[p] = true, queue.push(p));
    return marked;
  };
  // завершение возможно из пустого состояния; оборванные ветки (нехватка синхронизации) считаем способными завершиться
  const canFinish = backward(states.flatMap((m, i) => (isEmpty(m) || cutOff[i] ? [i] : [])));
  const deadStates = states.flatMap((m, i) => (!canFinish[i] && succ[i].length === 0 ? [i] : []));
  const canStop = backward(deadStates);

  const report: SoundnessReport = { analyzed: true, deadlocks: [], livelocks: [], unsynchronized: [] };
  // Блокировка с одним и тем же набором ждущих узлов — одна; если до неё можно дойти и без конечного события, это путаница шлюзов, а не отказ.
  const deadlockBy = new Map<string, SoundnessReport["deadlocks"][number]>();
  for (const i of deadStates) {
    const waiting = waitingNodes(states[i]);
    const id = waiting.slice().sort().join("|");
    const found = { waiting, trace: traceTo(i), afterEnd: passedEnd(i) };
    const old = deadlockBy.get(id);
    if (!old || (old.afterEnd && !found.afterEnd)) deadlockBy.set(id, found);
  }
  report.deadlocks = [...deadlockBy.values()].sort((a, b) => Number(a.afterEnd) - Number(b.afterEnd) || a.trace.length - b.trace.length);
  const seen = new Set<string>();
  states.forEach((m, i) => {
    if (canFinish[i] || canStop[i]) return;
    const looping = waitingNodes(m);
    const id = looping.slice().sort().join("|");
    if (!seen.has(id)) (seen.add(id), report.livelocks.push({ looping, trace: traceTo(i) }));
  });
  report.livelocks.sort((a, b) => a.trace.length - b.trace.length);

  // Нехватка синхронизации: на один шаг (не конец процесса) одновременно приходят потоки по двум разным входам — ветки, разошедшиеся параллельно, слились без параллельного шлюза.
  const merges = nodes.filter((n) => inOf(n.id).length >= 2 && !boundaryIds.has(n.id) && !(n.type === "event" && spec(n).position === "end") && !(n.type === "gateway" && (n.subtype === "parallel" || n.subtype === "inclusive")));
  const flagged = new Set<string>();
  for (let i = 0; i < states.length; i++) {
    for (const n of merges) {
      if (flagged.has(n.id) || inOf(n.id).filter((p) => states[i][p] > 0).length < 2) continue;
      flagged.add(n.id);
      report.unsynchronized.push({ node: n.id, trace: traceTo(i) });
    }
  }
  return report;
}
