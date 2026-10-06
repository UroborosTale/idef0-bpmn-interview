/**
 * ФТ-М9.1.2: подбор похожих утверждённых примеров из корпуса ("поиск по
 * эмбеддингам" в ТЗ). В этом окружении нет доступа к внешнему сервису
 * эмбеддингов (Anthropic не предоставляет embeddings API, а поднимать
 * отдельный векторный индекс ради одного узла — избыточно), поэтому
 * применяется детерминированный офлайн-заменитель: TF-IDF + косинусное
 * сходство по токенам текста. Он даёт содержательное ранжирование по
 * лексическому пересечению без сети и внешних сервисов — тот же принцип
 * "детерминированный офлайн-режим", что и у mockProvider.ts.
 */

const STOPWORDS = new Set([
  "и", "в", "на", "для", "по", "от", "с", "из", "к", "о", "об", "а", "но", "или",
  "не", "при", "за", "до", "со", "во", "то", "же", "что", "это", "как", "мы", "он", "она", "они",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

function termFreq(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  return tf;
}

function cosineSim(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const v of a.values()) normA += v * v;
  for (const v of b.values()) normB += v * v;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const [term, freq] of small) {
    const other = large.get(term);
    if (other) dot += freq * other;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export interface CorpusEntryInput {
  id: string;
  processName: string;
  rawText: string;
}

export interface SimilarCorpusEntry {
  id: string;
  processName: string;
  score: number;
}

/** Ранжирует записи корпуса по сходству текста с запросом (нисходяще), отсекая незначимые совпадения. */
export function findSimilarEntries(queryText: string, entries: CorpusEntryInput[], limit = 3): SimilarCorpusEntry[] {
  const queryVec = termFreq(tokenize(queryText));
  if (queryVec.size === 0) return [];

  const scored = entries.map((e) => ({ id: e.id, processName: e.processName, score: cosineSim(queryVec, termFreq(tokenize(e.rawText))) }));
  return scored
    .filter((s) => s.score >= 0.05)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** Короткая few-shot подсказка для LLM-промпта по похожим утверждённым процессам (не сырой текст — только названия и счёт схожести). */
export function buildFewShotContext(similar: SimilarCorpusEntry[]): string | undefined {
  if (similar.length === 0) return undefined;
  const lines = similar.map((s) => `- «${s.processName}» (схожесть ${(s.score * 100).toFixed(0)}%)`);
  return `Похожие ранее утверждённые процессы в корпусе организации (учти терминологию и стиль, но извлекай факты только из текущего текста):\n${lines.join("\n")}`;
}
