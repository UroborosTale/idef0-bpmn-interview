import type { ExtractionChunkResult, LLMFragmentInput } from "./types.js";

/**
 * Эвристический офлайн-экстрактор для русскоязычных текстов интервью.
 * Не заменяет LLM по качеству, но детерминированно демонстрирует
 * весь конвейер (фрагменты → роли/действия/связи → модель) без сети.
 */

const VERB_STEMS: Array<{ stem: string; inf: string }> = [
  { stem: "направля", inf: "направить заявку" },
  { stem: "направ", inf: "направить документ" },
  { stem: "передава", inf: "передать документ" },
  { stem: "переда", inf: "передать документ" },
  { stem: "согласовыва", inf: "согласовать заявку" },
  { stem: "согласов", inf: "согласовать заявку" },
  { stem: "согласу", inf: "согласовать заявку" },
  { stem: "утвержда", inf: "утвердить документ" },
  { stem: "утверд", inf: "утвердить документ" },
  { stem: "проверя", inf: "проверить данные" },
  { stem: "провер", inf: "проверить данные" },
  { stem: "подготавл", inf: "подготовить документ" },
  { stem: "подготов", inf: "подготовить документ" },
  { stem: "оформля", inf: "оформить документ" },
  { stem: "оформ", inf: "оформить документ" },
  { stem: "заполня", inf: "заполнить форму" },
  { stem: "заполн", inf: "заполнить форму" },
  { stem: "отправля", inf: "отправить документ" },
  { stem: "отправ", inf: "отправить документ" },
  { stem: "получа", inf: "получить документ" },
  { stem: "получ", inf: "получить документ" },
  { stem: "рассматрив", inf: "рассмотреть заявку" },
  { stem: "рассмотр", inf: "рассмотреть заявку" },
  { stem: "принима", inf: "принять решение" },
  { stem: "прини", inf: "принять решение" },
  { stem: "отклоня", inf: "отклонить заявку" },
  { stem: "отклон", inf: "отклонить заявку" },
  { stem: "созда", inf: "создать документ" },
  { stem: "формиру", inf: "сформировать документ" },
  { stem: "выставля", inf: "выставить счёт" },
  { stem: "выставл", inf: "выставить счёт" },
  { stem: "подписыва", inf: "подписать документ" },
  { stem: "подпис", inf: "подписать документ" },
  { stem: "регистриру", inf: "зарегистрировать документ" },
  { stem: "уведомля", inf: "уведомить участника" },
  { stem: "уведом", inf: "уведомить участника" },
  { stem: "назнача", inf: "назначить ответственного" },
  { stem: "назнач", inf: "назначить ответственного" },
  { stem: "запраш", inf: "запросить информацию" },
  { stem: "предоставля", inf: "предоставить документ" },
  { stem: "предостав", inf: "предоставить документ" },
  { stem: "выполня", inf: "выполнить задачу" },
  { stem: "выполн", inf: "выполнить задачу" },
  { stem: "закрыва", inf: "закрыть заявку" },
  { stem: "выда", inf: "выдать пропуск" },
  { stem: "начина", inf: "начать процесс" },
  { stem: "заверша", inf: "завершить процесс" },
  { stem: "заверш", inf: "завершить процесс" },
  { stem: "проверк", inf: "проверить данные" },
  { stem: "звон", inf: "позвонить клиенту" },
  { stem: "организу", inf: "организовать" },
  { stem: "взаимодейству", inf: "взаимодействовать" },
  { stem: "определя", inf: "определить" },
  { stem: "контролиру", inf: "проконтролировать" },
  { stem: "собира", inf: "собрать" },
  { stem: "приглаша", inf: "пригласить" },
  { stem: "оценива", inf: "оценить" },
  { stem: "куриру", inf: "курировать" },
  { stem: "информир", inf: "проинформировать участника" },
];

const ROLE_WORDS = [
  "менеджер", "клиент", "бухгалтер", "директор", "руководитель", "юрист",
  "специалист", "оператор", "кассир", "курьер", "исполнитель", "заказчик",
  "поставщик", "секретарь", "инженер", "аналитик", "кадровик", "hr",
  "администратор", "консультант", "инспектор", "координатор", "владелец",
  "сотрудник", "начальник", "экономист", "снабженец", "логист", "охранник", "вахтёр", "вахтер", "посетитель",
];

const DEPT_WORDS = ["отдел", "служба", "департамент", "бухгалтерия", "дирекция", "управление"];

const SYSTEM_WORDS = [
  "1с", "crm", "erp", "sap", "битрикс", "bitrix", "портал", "почта",
  "excel", "система", "jira", "confluence", "sharepoint", "эдо",
];

const DOC_WORDS = [
  "заявка", "договор", "акт", "счёт", "счет", "накладная", "приказ",
  "протокол", "отчёт", "отчет", "справка", "заявление", "письмо",
  "смета", "спецификация", "техзадание", "реестр", "ведомость", "пропуск",
];

const CONTROL_WORDS = [
  "регламент", "положение", "инструкция", "правило", "норматив", "закон",
  "фз", "стандарт", "политика", "приказ",
];

const PROPOSAL_MARKERS = ["хотелось бы", "нужно бы", "было бы неплохо", "предлага", "лучше бы", "стоило бы", "планиру"];
const PROBLEM_MARKERS = ["проблема", "неудобно", "долго", "теряется", "ошибк", "приходится", "вручную", "путаниц", "затягива"];
const CONDITION_MARKERS = ["если", "в случае", "либо", "иначе", "когда"];
const TRIGGER_MARKERS = ["запускается", "запускает", "запускают", "стартует", "начинается", "триггер", "иницииру", "основание", "поступает", "поступление", "приходит", "после получения", "когда клиент", "когда сотрудник", "когда посетитель"];
const RESULT_MARKERS = ["завершается", "заканчивается", "результат процесса", "результатом", "в результате", "в итоге", "на выходе", "считается завершённым", "считается завершенным"];
const GOAL_MARKERS = ["цель процесса", "целью процесса", "цель —", "цель -", "цель:"];

// Длительность/срок шага (ФТ-М2.1, ФТ-М4.1.3 "сроки") — простой числовой паттерн
// "N дней/часов/недель/минут" в той же фразе, что и глагол действия.
const DURATION_PATTERN = /(\d+(?:[.,]\d+)?)\s*(рабоч(?:их|ий)\s+)?(день|дня|дней|час|часа|часов|недел[юяи]|недель|минут[уы]?|минут)/iu;
function findDuration(text: string): string | null {
  const m = DURATION_PATTERN.exec(text);
  return m ? m[0].trim() : null;
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?;])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 3);
}

function findWord(text: string, dict: string[]): string | null {
  const lower = text.toLowerCase();
  let best: { word: string; index: number } | null = null;
  for (const w of dict) {
    const index = lower.indexOf(w);
    if (index < 0) continue;
    // первое упоминание в предложении важнее порядка словаря: «Охранник проверяет данные сотрудника» — охранник
    if (!best || index < best.index) best = { word: w, index };
  }
  return best?.word ?? null;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Названия систем и должностей: «hr» → «HR», первая буква — заглавная. */
function niceName(s: string): string {
  return capitalize(s.trim().replace(/\bhr\b/giu, "HR"));
}

/** Служебные слова, которые не могут быть частью названия роли («Служба и», «Отдел при»). */
const ROLE_STOP = new Set(["и", "а", "но", "при", "в", "на", "по", "для", "с", "от", "из", "под", "над", "не", "же", "ли", "что", "чтобы", "который", "которая", "которые", "это", "его", "ее", "её", "их", "или", "либо", "так", "как", "у", "о", "об"]);

/**
 * B1: имя шага — инфинитив глагола плюс объект из самой фразы («проверяет комплектность заявки» →
 * «Проверить комплектность заявки»), а не шаблон «проверить данные». Объект обрезается на союзе,
 * запятой или предлоге, чтобы в имя не попала следующая часть предложения.
 */
function actionName(verbHit: { stem: string; inf: string }, sentence: string, idx: number): string {
  const verb = verbHit.inf.split(" ")[0];
  if (idx < 0) return niceName(verbHit.inf);
  let tail = sentence.slice(idx + verbHit.stem.length);
  // окончание спряжения приклеено к основе: «проверя|ет», «оформ|ляет»
  tail = tail.replace(/^[а-яё]{1,6}(?=\s|$)/u, "").trim();
  const obj = tail.split(/[,.;:!?]|\s+(?:и|а|но|затем|потом|после|для|чтобы|при|если|когда|который|которая|которые|со|с|в|на|по|из|от|у|о|об)\s+/iu)[0].trim();
  const words = obj.split(/\s+/).filter(Boolean).slice(0, 6);
  if (words.length === 0) return niceName(verbHit.inf);
  return niceName(`${verb} ${words.join(" ")}`);
}

/** Слово с основой глагола в личной форме или инфинитиве; «проверке» — существительное, не действие. */
function verbForm(sentence: string, stem: string): { index: number; form: string } | null {
  const re = new RegExp(`[а-яё-]*?${stem}[а-яё]*`, "giu");
  for (const m of sentence.matchAll(re)) {
    const word = m[0];
    if (/(?:ет|ют|ит|ат|ят|ует|ает|яет|ть|ться|тся|л|ла|ли|ем|им|ешь|ишь)$/u.test(word)) return { index: (m.index ?? 0) + word.indexOf(stem), form: word };
  }
  return null;
}

/** Этапы офлайн-модели: по ним глубина 2 собирает подпроцессы, а действия — операции внутри них. */
const STAGE_RULES: { name: string; re: RegExp }[] = [
  { name: "Приём и проверка", re: /^(получ|приня|провер|собир|запраш|регистр)/iu },
  { name: "Согласование", re: /^(соглас|утверд|рассмотр|отклон)/iu },
  { name: "Оформление документов", re: /^(оформ|заполн|созда|сформир|подпис|выстав|выда)/iu },
  { name: "Передача и уведомление", re: /^(переда|отправ|направ|уведом|информир)/iu },
  { name: "Завершение", re: /^(оплат|закры|заверш|выполн)/iu },
];

/** «Проверить заявку» → «Проверка заявки»: имя операции — отглагольное существительное, как у блока IDEF0. */
const OP_VERB: Record<string, string> = {
  получить: "Получение",
  принять: "Принятие",
  проверить: "Проверка",
  собрать: "Сбор",
  запросить: "Запрос",
  зарегистрировать: "Регистрация",
  согласовать: "Согласование",
  утвердить: "Утверждение",
  рассмотреть: "Рассмотрение",
  отклонить: "Отклонение",
  оформить: "Оформление",
  заполнить: "Заполнение",
  создать: "Создание",
  сформировать: "Формирование",
  подписать: "Подписание",
  выставить: "Выставление",
  выдать: "Выдача",
  передать: "Передача",
  отправить: "Отправка",
  направить: "Направление",
  уведомить: "Уведомление",
  проинформировать: "Информирование",
  оплатить: "Оплата",
  закрыть: "Закрытие",
  завершить: "Завершение",
  выполнить: "Выполнение",
};

/** Объект операции в родительном падеже: «Получение заявку» → «Получение заявки». */
const OBJECT_GENITIVE: Record<string, string> = {
  заявку: "заявки",
  заявка: "заявки",
  документы: "документов",
  документ: "документа",
  пропуск: "пропуска",
  счёт: "счёта",
  счет: "счета",
  договор: "договора",
  запрос: "запроса",
  письмо: "письма",
  обращение: "обращения",
  звонок: "звонка",
  данные: "данных",
  задачу: "задачи",
  форму: "формы",
  отчёт: "отчёта",
  отчет: "отчета",
};

function operationName(action: string): string {
  const [first, ...rest] = action.split(/\s+/u);
  const noun = OP_VERB[first.toLowerCase()];
  if (!noun) return action;
  if (rest[0]) rest[0] = OBJECT_GENITIVE[rest[0].toLowerCase()] ?? rest[0];
  return [noun, ...rest].join(" ");
}

/**
 * B1: глубина декомпозиции 2+ в офлайн-режиме. Действия раскладываются по этапам; этап становится подпроцессом,
 * а его действия — двумя и более операциями. Без этого 80+ действий висели на A0 одной лестницей.
 */
function structureMockActions(result: ExtractionChunkResult, depth: number): void {
  if (depth < 2) return;
  const actions = result.nodes.filter((n) => n.type !== "event");
  if (actions.length < 4) return;
  const order = new Map(actions.map((n, i) => [n, i] as const));
  const groups = new Map<string, { name: string; nodes: typeof actions }>();
  for (const n of actions) {
    const stage = STAGE_RULES.find((s) => s.re.test(n.name))?.name ?? "Прочие действия";
    const group = groups.get(stage) ?? { name: stage, nodes: [] };
    group.nodes.push(n);
    groups.set(stage, group);
  }
  let list = [...groups.values()].sort((a, b) => (order.get(a.nodes[0]) ?? 0) - (order.get(b.nodes[0]) ?? 0));
  // этап из одного действия не создаёт отдельный подпроцесс: присоединяем его к соседнему
  for (let i = 0; i < list.length && list.length > 1; i++) {
    if (list[i].nodes.length > 1) continue;
    const target = i > 0 ? list[i - 1] : list[i + 1];
    target.nodes.push(...list[i].nodes);
    target.nodes.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
    list.splice(i, 1);
    i = Math.max(-1, i - 1);
  }
  while (list.length > 6) {
    const last = list.pop()!;
    list[list.length - 1].nodes.push(...last.nodes);
    list[list.length - 1].nodes.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  }
  if (list.length === 0) return;

  const operations: NonNullable<ExtractionChunkResult["operations"]> = [];
  const subprocesses: NonNullable<ExtractionChunkResult["subprocesses"]> = [];
  const usedNames = new Set<string>();
  for (const group of list) {
    const parts: typeof actions[] = [];
    if (group.nodes.length <= 4) {
      const half = Math.ceil(group.nodes.length / 2);
      if (half > 0) parts.push(group.nodes.slice(0, half));
      if (group.nodes.length > half) parts.push(group.nodes.slice(half));
    } else {
      for (let i = 0; i < group.nodes.length; i += 4) parts.push(group.nodes.slice(i, i + 4));
    }
    if (parts.length === 0) continue;
    const groupRole = mostCommon(group.nodes.map((n) => n.role_name).filter((r): r is string => !!r));
    for (const part of parts) {
      let name = operationName(part[0].name);
      if (usedNames.has(name.toLowerCase())) {
        let k = 2;
        while (usedNames.has(`${name} (${k})`.toLowerCase())) k++;
        name = `${name} (${k})`;
      }
      usedNames.add(name.toLowerCase());
      for (const n of part) n.operation_name = name;
      const first = part[0];
      operations.push({
        name,
        subprocess_name: group.name,
        role_name: mostCommon(part.map((n) => n.role_name).filter((r): r is string => !!r)) ?? groupRole,
        source_fragment_id: first.source_fragment_id,
        quote: first.quote,
        confidence: Math.min(...part.map((n) => n.confidence)),
      });
    }
    const first = group.nodes[0];
    subprocesses.push({
      name: group.name,
      source_fragment_id: first.source_fragment_id,
      quote: first.quote,
      confidence: Math.min(...group.nodes.map((n) => n.confidence)),
    });
  }
  if (subprocesses.length > 0) {
    result.operations = operations;
    result.subprocesses = subprocesses;
  }
}

function mostCommon(values: string[]): string | null {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: string | null = null;
  let bestCount = 0;
  for (const [v, c] of counts) if (c > bestCount) (best = v), (bestCount = c);
  return best;
}

export function mockExtractChunk(
  fragments: LLMFragmentInput[],
  context: { processName: string; modelType: "AS-IS" | "TO-BE"; decompositionDepth?: number }
): ExtractionChunkResult {
  const result: ExtractionChunkResult = {
    roles: [],
    systems: [],
    data: [],
    controls: [],
    nodes: [],
    flows: [],
    statements: [],
    process_hints: {},
  };

  let orderCounter = 0;
  const seenRoles = new Set<string>();
  const seenSystems = new Set<string>();
  const seenData = new Set<string>();
  const seenControls = new Set<string>();
  const seenActions = new Map<string, ExtractionChunkResult["nodes"][number]>();

  for (const frag of fragments) {
    const isFact = frag.speaker === "owner" || frag.speaker === "participant";

    // роли: сначала составные («финансовый директор», «HR-менеджер»), затем одиночные слова и подразделения
    const lower = frag.text.toLowerCase();
    const addRole = (name: string, confidence: number) => {
      const key = name.trim().toLowerCase();
      if (!key || seenRoles.has(key)) return;
      seenRoles.add(key);
      result.roles.push({ name: niceName(name), kind: "internal", source_fragment_id: frag.id, quote: frag.text.slice(0, 200), confidence });
    };
    const compounds: string[] = [];
    for (const rw of ROLE_WORDS) {
      if (rw === "hr") continue;
      const m = frag.text.match(new RegExp(`([А-ЯЁA-Z][А-ЯЁA-Zа-яёa-z-]*)[-\\s]+${rw}`, "u"));
      if (m && !ROLE_STOP.has(m[1].toLowerCase())) {
        compounds.push(m[0].toLowerCase());
        addRole(m[0], 0.55);
      }
    }
    const coveredByCompound = (rw: string) => compounds.some((c) => c.includes(rw));
    for (const rw of ROLE_WORDS) {
      if (lower.includes(rw) && !coveredByCompound(rw)) addRole(rw, 0.5);
    }
    // «Служба безопасности», «Юридическая служба» — подразделение как роль; «Служба и», «Отдел при» отбрасываем
    for (const dw of DEPT_WORDS) {
      for (const re of [new RegExp(`\\b${dw}\\s+([а-яё][а-яё-]*)`, "iu"), new RegExp(`\\b([А-ЯЁA-Zа-яёa-z-]+)\\s+${dw}\\b`, "iu")]) {
        const m = frag.text.match(re);
        if (!m) continue;
        const words = m[0].replace(/\s+/g, " ").trim().toLowerCase().split(" ");
        if (words.some((w) => ROLE_STOP.has(w))) continue;
        // второе слово — глагол («Служба проверяют»), а не название подразделения
        if (words[1] && /(?:ют|ет|ит|ают|яют|ует|ешь|ишь|ться|тся|ть)$/u.test(words[1])) continue;
        addRole(m[0], 0.45);
      }
    }

    for (const sw of SYSTEM_WORDS) {
      if (lower.includes(sw) && !seenSystems.has(sw)) {
        seenSystems.add(sw);
        result.systems.push({
          name: sw.toUpperCase(),
          source_fragment_id: frag.id,
          quote: frag.text.slice(0, 200),
          confidence: 0.4,
        });
      }
    }

    for (const dw of DOC_WORDS) {
      if (lower.includes(dw) && !seenData.has(dw)) {
        seenData.add(dw);
        result.data.push({
          name: capitalize(dw),
          kind: "document",
          source_fragment_id: frag.id,
          quote: frag.text.slice(0, 200),
          confidence: 0.45,
        });
      }
    }

    for (const cw of CONTROL_WORDS) {
      if (lower.includes(cw) && !seenControls.has(cw)) {
        seenControls.add(cw);
        result.controls.push({
          name: capitalize(cw),
          kind: "regulation",
          source_fragment_id: frag.id,
          quote: frag.text.slice(0, 200),
          confidence: 0.4,
        });
      }
    }

    if (!isFact) continue;

    // роль, названная в начале фрагмента, относится и к следующим фразам без подлежащего: «Охранник проверяет… Выдаёт…»
    let lastRole: string | null = null;
    for (const sentence of splitSentences(frag.text)) {
      const sLower = sentence.toLowerCase().replace(/ё/g, "е");

      const isProposal = PROPOSAL_MARKERS.some((mk) => sLower.includes(mk));
      const isProblem = PROBLEM_MARKERS.some((mk) => sLower.includes(mk));
      if (isProposal || isProblem) {
        result.statements.push({
          kind: isProposal ? "proposal" : "problem",
          text: sentence.slice(0, 300),
          source_fragment_id: frag.id,
          quote: sentence.slice(0, 200),
        });
        continue;
      }

      // триггер/цель/результат нужны и событиям, и паспорту процесса; их фразы не обязаны содержать глагол действия
      const hintText = sentence.replace(/^(обычно|как правило|в итоге|в результате)\s+/iu, "").trim().slice(0, 300);
      if (!result.process_hints.goal && GOAL_MARKERS.some((mk) => sLower.includes(mk))) result.process_hints.goal = hintText;
      if (!result.process_hints.trigger && TRIGGER_MARKERS.some((mk) => sLower.includes(mk))) result.process_hints.trigger = hintText;
      if (!result.process_hints.result && RESULT_MARKERS.some((mk) => sLower.includes(mk))) result.process_hints.result = hintText;

      const verbHit = VERB_STEMS.find((v) => sLower.includes(v.stem));
      if (!verbHit) continue;
      const form = verbForm(sLower, verbHit.stem);
      if (!form) continue;

      const mentionedRole = findWord(sentence, ROLE_WORDS);
      if (mentionedRole) lastRole = mentionedRole;
      const role = mentionedRole ?? lastRole;
      const doc = findWord(sentence, DOC_WORDS);
      const system = findWord(sentence, SYSTEM_WORDS);
      const duration = findDuration(sentence);
      const uncertain = /обычно|иногда|бывает|как правило/iu.test(sentence);
      const isGateway = CONDITION_MARKERS.some((mk) => sLower.includes(mk));

      const name = isGateway ? capitalize(verbHit.inf) : actionName(verbHit, sentence, form.index);
      // то же действие, названное ещё раз, дополняет прежнее (исполнитель, объект, система), а не создаёт дубль
      const known = seenActions.get(name.toLowerCase());
      if (known) {
        // уточнение из следующего ответа важнее прежнего: «Охранник проверяет…» переставляет шаг в его дорожку
        if (role) known.role_name = capitalize(role);
        if (!known.output_names?.length && doc) known.output_names = [capitalize(doc)];
        if (system && !known.system_names?.includes(system.toUpperCase())) known.system_names = [...(known.system_names ?? []), system.toUpperCase()];
        known.confidence = Math.max(known.confidence, uncertain ? 0.4 : 0.6);
        continue;
      }

      orderCounter += 1;
      const node: ExtractionChunkResult["nodes"][number] = {
        type: isGateway ? "gateway" : "task",
        subtype: isGateway ? "exclusive" : "user",
        name,
        role_name: role ? capitalize(role) : null,
        system_names: system ? [system.toUpperCase()] : [],
        input_names: [],
        output_names: doc ? [capitalize(doc)] : [],
        control_names: [],
        duration,
        order_hint: orderCounter,
        source_fragment_id: frag.id,
        quote: sentence.slice(0, 240),
        confidence: uncertain ? 0.4 : 0.6,
      };
      result.nodes.push(node);
      seenActions.set(name.toLowerCase(), node);
    }
  }

  structureMockActions(result, context.decompositionDepth ?? 2);
  return result;
}
