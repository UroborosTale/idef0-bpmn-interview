import type { ProcessLogicModel } from "../types/model.js";

/**
 * ФТ-М4.4.1: пересказ процесса обычным языком, без терминов нотаций
 * (никаких "шлюз", "узел", "BPMN-событие" — только связный рассказ о том,
 * кто что делает). Использует тот же обход графа от старта, что и
 * pipeline/regulation.ts, но рендерит прозой, а не техническим списком.
 */
export interface VerificationParagraph {
  id: string;
  text: string;
  sourceRefs: string[];
}

export function buildParaphrase(model: ProcessLogicModel): VerificationParagraph[] {
  const nodeById = new Map(model.nodes.map((n) => [n.id, n] as const));
  const roleById = new Map(model.roles.map((r) => [r.id, r.name] as const));
  const outAdj = new Map<string, typeof model.flows>();
  for (const f of model.flows) outAdj.set(f.from, [...(outAdj.get(f.from) ?? []), f]);

  const starts = model.nodes.filter((n) => n.type === "event" && n.subtype === "start");
  const inCount = new Map<string, number>();
  for (const f of model.flows) inCount.set(f.to, (inCount.get(f.to) ?? 0) + 1);
  const roots = starts.length > 0 ? starts : model.nodes.filter((n) => (inCount.get(n.id) ?? 0) === 0);

  const out: VerificationParagraph[] = [];
  if (model.process.goal || model.process.trigger) {
    out.push({
      id: "vp-intro",
      text: `Процесс «${model.process.name}» запускается, когда ${model.process.trigger ?? "наступает соответствующее событие"}. Его цель — ${model.process.goal ?? "не описана"}.`,
      sourceRefs: [],
    });
  }

  let counter = 0;
  const globalVisitCount = new Map<string, number>();
  const MAX_REVISITS = 2;
  const connector = (i: number) => (i === 0 ? "Сначала" : i === 1 ? "Затем" : "После этого");

  function walk(nodeId: string, pathVisited: Set<string>, stepIndex: number) {
    const node = nodeById.get(nodeId);
    if (!node) return;
    if (pathVisited.has(nodeId)) {
      out.push({ id: `vp-${++counter}`, text: `Если нужно, шаг «${node.name}» повторяется заново, пока не будет выполнено условие для продолжения.`, sourceRefs: [nodeId] });
      return;
    }
    const visits = (globalVisitCount.get(nodeId) ?? 0) + 1;
    globalVisitCount.set(nodeId, visits);
    if (visits > MAX_REVISITS) return;
    const newPath = new Set(pathVisited);
    newPath.add(nodeId);

    if (node.type === "event") {
      if (node.subtype === "end") {
        out.push({ id: `vp-${++counter}`, text: `В завершение: ${node.name.toLowerCase()}.`, sourceRefs: [nodeId] });
        return;
      }
      for (const f of outAdj.get(nodeId) ?? []) walk(f.to, newPath, stepIndex);
      return;
    }

    if (node.type === "gateway") {
      const nexts = outAdj.get(nodeId) ?? [];
      if (nexts.length <= 1) {
        for (const f of nexts) walk(f.to, newPath, stepIndex);
        return;
      }
      const branchTexts = nexts.map((f) => {
        const targetName = nodeById.get(f.to)?.name?.toLowerCase() ?? "";
        return f.condition ? `если ${f.condition} — ${targetName}` : `в другом случае — ${targetName}`;
      });
      out.push({
        id: `vp-${++counter}`,
        text: `Дальше зависит от ситуации: ${branchTexts.join("; ")}.`,
        sourceRefs: [nodeId, ...nexts.map((f) => f.id)],
      });
      for (const f of nexts) walk(f.to, newPath, stepIndex + 1);
      return;
    }

    const roleName = node.role_id ? roleById.get(node.role_id) : null;
    const lead = stepIndex === 0 ? connector(0) : connector(stepIndex);
    const text = roleName
      ? `${lead} ${roleName.toLowerCase()} ${verbPhraseThirdPerson(node.name)}.`
      : `${lead} кто-то ${verbPhraseThirdPerson(node.name)}.`;
    out.push({ id: `vp-${++counter}`, text, sourceRefs: [nodeId] });
    for (const f of outAdj.get(nodeId) ?? []) walk(f.to, newPath, stepIndex + 1);
  }

  for (const r of roots) walk(r.id, new Set(), 0);
  if (out.length === 0) out.push({ id: "vp-empty", text: "Пока не удалось описать последовательность шагов процесса.", sourceRefs: [] });
  return out;
}

/** "направить заявку" -> "направляет заявку" (очень грубая эвристика для связного пересказа, не лингвистический разбор). */
function verbPhraseThirdPerson(infinitivePhrase: string): string {
  const [verb, ...rest] = infinitivePhrase.split(" ");
  const tail = rest.join(" ");
  let form = verb;
  if (verb.endsWith("ить")) form = verb.slice(0, -3) + "ит";
  else if (verb.endsWith("ать")) form = verb.slice(0, -3) + "ает";
  else if (verb.endsWith("еть")) form = verb.slice(0, -3) + "еет";
  else if (verb.endsWith("ти")) form = verb.slice(0, -2) + "ёт";
  return tail ? `${form} ${tail}` : form;
}
