const STOPWORDS = new Set([
  "и", "в", "на", "для", "по", "от", "с", "из", "к", "о", "об", "а", "но", "или",
  "не", "при", "за", "до", "со", "во", "то", "же", "как", "что", "это", "процесс", "процесса", "процессом",
]);

function tokenize(name: string): Set<string> {
  const words = name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
  return new Set(words);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const w of a) if (b.has(w)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export interface DuplicateCandidateInput {
  id: string;
  name: string;
  classification: string;
  department: string | null;
  level: string;
}

export interface DuplicateCandidate {
  aId: string;
  aName: string;
  bId: string;
  bName: string;
  score: number;
  reason: string;
}

/** ФТ-М3.4: эвристический поиск дублей в реестре процессов по схожести названий (+ бонус за совпадение классификации/подразделения). */
export function detectDuplicates(processes: DuplicateCandidateInput[], dismissedKeys: Set<string>): DuplicateCandidate[] {
  const candidates: DuplicateCandidate[] = [];
  const tokensById = new Map(processes.map((p) => [p.id, tokenize(p.name)] as const));

  for (let i = 0; i < processes.length; i++) {
    for (let j = i + 1; j < processes.length; j++) {
      const a = processes[i];
      const b = processes[j];
      const key = [a.id, b.id].sort().join("|");
      if (dismissedKeys.has(key)) continue;

      const nameSim = jaccard(tokensById.get(a.id)!, tokensById.get(b.id)!);
      if (nameSim < 0.4) continue;

      let score = nameSim;
      const reasons: string[] = [`совпадение слов в названии: ${(nameSim * 100).toFixed(0)}%`];
      if (a.classification === b.classification) {
        score += 0.1;
        reasons.push("одинаковая классификация");
      }
      if (a.department && b.department && a.department === b.department) {
        score += 0.1;
        reasons.push("одно подразделение");
      }
      score = Math.min(1, score);

      candidates.push({ aId: a.id, aName: a.name, bId: b.id, bName: b.name, score, reason: reasons.join("; ") });
    }
  }

  return candidates.sort((x, y) => y.score - x.score);
}
