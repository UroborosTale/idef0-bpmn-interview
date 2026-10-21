import type { ProcessLogicModel } from "../types/model.js";
import { quoted } from "../shared/quote.js";

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
      text: `Процесс ${quoted(model.process.name)} запускается, когда ${decapPhrase(model.process.trigger ?? "наступает соответствующее событие")}. Его цель — ${decapPhrase(model.process.goal ?? "не описана")}.`,
      sourceRefs: [],
    });
  }

  let counter = 0;
  const visitsCount = new Map<string, number>();
  const connector = (i: number) => (i === 0 ? "Сначала" : i === 1 ? "Затем" : "После этого");
  /** Название шага за техническим шлюзом: в пересказе шлюзы не называются. */
  const stepLabel = (id: string): string => {
    let node = nodeById.get(id);
    for (let guard = 0; node?.type === "gateway" && guard < 10; guard++) {
      const nexts = outAdj.get(node.id) ?? [];
      const next = nexts.find((f) => !f.is_default) ?? nexts[0];
      if (!next) break;
      node = nodeById.get(next.to);
    }
    return node ? decapPhrase(node.name) : "";
  };

  function walk(nodeId: string, pathVisited: Set<string>, stepIndex: number) {
    const node = nodeById.get(nodeId);
    if (!node) return;
    const newPath = new Set(pathVisited);
    if (pathVisited.has(nodeId)) {
      // шлюз — техническая точка ветвления, шагом его не называем
      if (node.type !== "gateway") {
        out.push({ id: `vp-${++counter}`, text: `Если нужно, шаг ${quoted(node.name)} повторяется заново, пока не будет выполнено условие для продолжения.`, sourceRefs: [nodeId] });
      }
      return;
    }
    newPath.add(nodeId);
    const visits = (visitsCount.get(nodeId) ?? 0) + 1;
    visitsCount.set(nodeId, visits);
    if (visits > 1) {
      // этот шаг уже описан в другой ветке — не повторяем абзац, но продолжаем путь
      for (const f of outAdj.get(nodeId) ?? []) walk(f.to, newPath, stepIndex);
      return;
    }

    if (node.type === "event") {
      if (node.subtype === "end") {
        out.push({ id: `vp-${++counter}`, text: `В завершение: ${decapPhrase(node.name)}.`, sourceRefs: [nodeId] });
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
      const hasConditions = nexts.some((f) => f.condition);
      const targetNames = nexts.map((f) => stepLabel(f.to));
      if (!hasConditions && (node.subtype === "parallel" || node.subtype === "parallel_event_based")) {
        out.push({
          id: `vp-${++counter}`,
          text: `Дальше шаги идут параллельно: ${targetNames.join(", ")}.`,
          sourceRefs: [nodeId, ...nexts.map((f) => f.id)],
        });
      } else if (!hasConditions && node.subtype === "event_based") {
        out.push({
          id: `vp-${++counter}`,
          text: `Дальше зависит от того, что наступит раньше: ${targetNames.join(" или ")}.`,
          sourceRefs: [nodeId, ...nexts.map((f) => f.id)],
        });
      } else {
        const branchTexts = nexts.map((f, i) => {
          const targetName = targetNames[i];
          if (f.condition) return `если ${decapPhrase(f.condition)} — ${targetName}`;
          return `${i === 0 ? "в другом случае" : "или"} — ${targetName}`;
        });
        out.push({
          id: `vp-${++counter}`,
          text: `Дальше зависит от ситуации: ${branchTexts.join("; ")}.`,
          sourceRefs: [nodeId, ...nexts.map((f) => f.id)],
        });
      }
      for (const f of nexts) walk(f.to, newPath, stepIndex + 1);
      return;
    }

    const roleName = node.role_id ? roleById.get(node.role_id) : null;
    const lead = connector(stepIndex);
    const roleText = roleName ? decapPhrase(roleName) : "кто-то";
    const phrase = verbPhraseThirdPerson(decapPhrase(node.name));
    const text = phrase
      ? `${lead} ${roleText} ${phrase}.`
      : `${lead} ${roleText} выполнит шаг ${quoted(node.name)}.`;
    out.push({ id: `vp-${++counter}`, text, sourceRefs: [nodeId] });
    for (const f of outAdj.get(nodeId) ?? []) walk(f.to, newPath, stepIndex + 1);
  }

  for (const r of roots) walk(r.id, new Set(), 0);
  // одинаковые абзацы (общая часть веток после слияния) не повторяем
  const seen = new Set<string>();
  const unique = out.filter((p) => (seen.has(p.text) ? false : (seen.add(p.text), true)));
  if (unique.length === 0) unique.push({ id: "vp-empty", text: "Пока не удалось описать последовательность шагов процесса.", sourceRefs: [] });
  return unique;
}

/**
 * Строчная первая буква для середины фразы; имена систем и аббревиатуры не трогаем:
 * «ERP «Закупки»», «IT-отдел», «ООО» остаются как есть.
 */
function decapPhrase(value: string | null | undefined): string {
  const s = (value ?? "").trim();
  if (!s) return s;
  const first = s.split(/\s+/)[0];
  if (/^[A-Z]/.test(first) || /[«»"]/.test(first)) return s;
  const letters = first.replace(/[^\p{L}]/gu, "");
  if (letters.length >= 2 && letters === letters.toUpperCase()) return s;
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/** Частые глаголы-исключения: их форма не выводится правилом. */
const VERB_FORMS: Record<string, string> = {
  принять: "примет",
  поднять: "поднимет",
  начать: "начнёт",
  выбрать: "выберет",
  взять: "возьмёт",
  найти: "найдёт",
  учесть: "учтёт",
  создать: "создаст",
  дать: "даст",
  стать: "станет",
  открыть: "откроет",
  закрыть: "закроет",
  подписать: "подпишет",
  записать: "запишет",
  описать: "опишет",
  выписать: "выпишет",
  послать: "пошлёт",
  выслать: "вышлет",
  разослать: "разошлёт",
};

/**
 * «направить заявку» → «направит заявку». Грубая эвристика для связного пересказа, не лингвистический разбор.
 * null — первый компонент не глагол в инфинитиве («Проведение экспертизы»): вызывающий скажет «выполнит шаг …».
 */
function verbPhraseThirdPerson(infinitivePhrase: string): string | null {
  const [verb, ...rest] = infinitivePhrase.split(" ");
  const form = thirdPerson(verb);
  if (!form) return null;
  // «сравнить предложения и выбрать победителя»: второй однородный глагол тоже ставим в ту же форму
  const tail = rest
    .join(" ")
    .replace(/(^|\s)и\s+([а-яё-]+(?:ть|ти|чь))(?=\s|$)/giu, (m, before: string, next: string) => {
      const conjugated = thirdPerson(next);
      return conjugated ? `${before}и ${conjugated}` : m;
    });
  return tail ? `${form} ${tail}` : form;
}

function thirdPerson(verb: string): string | null {
  const v = verb.toLowerCase();
  const known = VERB_FORMS[v];
  if (known) return known;
  const stem = (n: number) => v.slice(0, -n);
  if (/[ае]ть$/.test(v) && /[ое]в[ае]ть$/.test(v)) return `${stem(5)}${v.endsWith("овать") ? "ует" : "юет"}`;
  if (v.endsWith("ить")) return `${stem(3)}ит`;
  if (v.endsWith("ать")) {
    // подписать → подпишет, сказать → скажет; остальные — по общему правилу
    if (/[сз]$/.test(stem(3))) return `${stem(3).replace(/[сз]$/, (c) => (c === "с" ? "ш" : "ж"))}ет`;
    return `${stem(3)}ает`;
  }
  if (v.endsWith("ять")) return `${stem(3)}яет`;
  if (v.endsWith("еть")) return `${stem(3)}еет`;
  if (v.endsWith("ти")) return /[с]$/.test(stem(2)) ? `${stem(2)}ёт` : `${stem(2)}дёт`;
  if (v.endsWith("чь")) return `${stem(2)}чёт`;
  if (v.endsWith("ть")) return null;
  return null;
}
