/**
 * Столбцы диаграммы BPMN: общий алгоритм серверной раскладки и кнопки «Расставить» в редакторе.
 *
 * Столбец фигуры — длиннейший путь до неё от начала (петли отбрасываются поиском в глубину). Строка — дорожка роли, поэтому в одну
 * ячейку «столбец × дорожка» попадает не больше одной фигуры: занятая ячейка сдвигает фигуру в следующий столбец. Такая раскладка
 * ставит ветки шлюза в одной дорожке в разные столбцы, и стрелки к дальней ветке не идут над ближней, как это было бы при общем
 * столбце.
 */

export interface RankInput {
  /** Фигуры в порядке модели (он решает ничьи). */
  ids: string[];
  /** Номер дорожки каждой фигуры. */
  lane: Map<string, number>;
  /** Стрелки между фигурами (неизвестные концы и петли на себя отбрасываются). */
  edges: { from: string; to: string }[];
  /** Шлюзы: стрелка от шлюза в другую дорожку идёт вертикально, цель встаёт в тот же столбец (как в Business Studio). Без набора — прежнее правило. */
  verticalFrom?: Set<string>;
}

export interface Ranked {
  rank: Map<string, number>;
  /** Прямые (без петель) связи. */
  fwd: Map<string, string[]>;
  preds: Map<string, string[]>;
}

export function rankColumns({ ids, lane, edges, verticalFrom }: RankInput): Ranked {
  const order = new Map(ids.map((id, i) => [id, i] as const));
  const out = new Map<string, string[]>();
  const hasIn = new Set<string>();
  for (const e of edges) {
    if (e.from === e.to || !order.has(e.from) || !order.has(e.to)) continue;
    out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
    hasIn.add(e.to);
  }

  // убираем обратные рёбра (петли), чтобы получить DAG
  const fwd = new Map<string, string[]>();
  const state = new Map<string, 1 | 2>();
  const dfs = (u: string) => {
    state.set(u, 1);
    for (const v of out.get(u) ?? []) {
      if (state.get(v) === 1) continue;
      fwd.set(u, [...(fwd.get(u) ?? []), v]);
      if (!state.has(v)) dfs(v);
    }
    state.set(u, 2);
  };
  for (const id of [...ids.filter((i) => !hasIn.has(i)), ...ids]) if (!state.has(id)) dfs(id);

  const preds = new Map<string, string[]>();
  const indeg = new Map<string, number>(ids.map((id) => [id, 0]));
  for (const [u, vs] of fwd) {
    for (const v of vs) {
      preds.set(v, [...(preds.get(v) ?? []), u]);
      indeg.set(v, (indeg.get(v) ?? 0) + 1);
    }
  }

  const rank = new Map<string, number>();
  const taken = new Set<string>();
  const queue = ids.filter((id) => indeg.get(id) === 0);
  while (queue.length > 0) {
    queue.sort((a, b) => order.get(a)! - order.get(b)!);
    const u = queue.shift()!;
    // обычно столбец — на один правее самого дальнего предшественника; стрелка от шлюза в другую дорожку вертикальна (тот же столбец)
    let r = Math.max(0, ...(preds.get(u) ?? []).map((p) => (rank.get(p) ?? -1) + (verticalFrom?.has(p) && lane.get(p) !== lane.get(u) ? 0 : 1)));
    while (taken.has(`${r}:${lane.get(u)}`)) r++;
    taken.add(`${r}:${lane.get(u)}`);
    rank.set(u, r);
    for (const v of fwd.get(u) ?? []) {
      indeg.set(v, indeg.get(v)! - 1);
      if (indeg.get(v) === 0) queue.push(v);
    }
  }
  return { rank, fwd, preds };
}