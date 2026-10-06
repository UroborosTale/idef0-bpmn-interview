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
  { stem: "начина", inf: "начать процесс" },
  { stem: "заверша", inf: "завершить процесс" },
  { stem: "заверш", inf: "завершить процесс" },
  { stem: "проверк", inf: "проверить данные" },
  { stem: "звон", inf: "позвонить клиенту" },
  { stem: "информир", inf: "проинформировать участника" },
];

const ROLE_WORDS = [
  "менеджер", "клиент", "бухгалтер", "директор", "руководитель", "юрист",
  "специалист", "оператор", "кассир", "курьер", "исполнитель", "заказчик",
  "поставщик", "секретарь", "инженер", "аналитик", "кадровик", "hr",
  "администратор", "консультант", "инспектор", "координатор", "владелец",
  "сотрудник", "начальник", "экономист", "снабженец", "логист",
];

const DEPT_WORDS = ["отдел", "служба", "департамент", "бухгалтерия", "дирекция", "управление"];

const SYSTEM_WORDS = [
  "1с", "crm", "erp", "sap", "битрикс", "bitrix", "портал", "почта",
  "excel", "система", "jira", "confluence", "sharepoint", "эдо",
];

const DOC_WORDS = [
  "заявка", "договор", "акт", "счёт", "счет", "накладная", "приказ",
  "протокол", "отчёт", "отчет", "справка", "заявление", "письмо",
  "смета", "спецификация", "техзадание", "реестр", "ведомость",
];

const CONTROL_WORDS = [
  "регламент", "положение", "инструкция", "правило", "норматив", "закон",
  "фз", "стандарт", "политика", "приказ",
];

const PROPOSAL_MARKERS = ["хотелось бы", "нужно бы", "было бы неплохо", "предлага", "лучше бы", "стоило бы", "планиру"];
const PROBLEM_MARKERS = ["проблема", "неудобно", "долго", "теряется", "ошибк", "приходится", "вручную", "путаниц", "затягива"];
const CONDITION_MARKERS = ["если", "в случае", "либо", "иначе", "когда"];

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
  for (const w of dict) {
    if (lower.includes(w)) return w;
  }
  return null;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function mockExtractChunk(
  fragments: LLMFragmentInput[],
  _context: { processName: string; modelType: "AS-IS" | "TO-BE" }
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

  for (const frag of fragments) {
    const isFact = frag.speaker === "owner" || frag.speaker === "participant";

    // роли (по словарю должностей и "отдел/служба X")
    const lower = frag.text.toLowerCase();
    for (const rw of ROLE_WORDS) {
      if (lower.includes(rw) && !seenRoles.has(rw)) {
        seenRoles.add(rw);
        result.roles.push({
          name: capitalize(rw),
          kind: "internal",
          source_fragment_id: frag.id,
          quote: frag.text.slice(0, 200),
          confidence: 0.5,
        });
      }
    }
    for (const dw of DEPT_WORDS) {
      const re = new RegExp(`${dw}\\s+[а-яё]+`, "iu");
      const m = frag.text.match(re);
      if (m && !seenRoles.has(m[0].toLowerCase())) {
        seenRoles.add(m[0].toLowerCase());
        result.roles.push({
          name: capitalize(m[0]),
          kind: "internal",
          source_fragment_id: frag.id,
          quote: frag.text.slice(0, 200),
          confidence: 0.45,
        });
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

    for (const sentence of splitSentences(frag.text)) {
      const sLower = sentence.toLowerCase();

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

      const verbHit = VERB_STEMS.find((v) => sLower.includes(v.stem));
      if (!verbHit) continue;

      const role = findWord(sentence, ROLE_WORDS);
      const doc = findWord(sentence, DOC_WORDS);
      const system = findWord(sentence, SYSTEM_WORDS);
      const duration = findDuration(sentence);
      const uncertain = /обычно|иногда|бывает|как правило/iu.test(sentence);
      const isGateway = CONDITION_MARKERS.some((mk) => sLower.includes(mk));

      orderCounter += 1;
      result.nodes.push({
        type: isGateway ? "gateway" : "task",
        subtype: isGateway ? "exclusive" : "user",
        name: verbHit.inf,
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
      });
    }
  }

  return result;
}
