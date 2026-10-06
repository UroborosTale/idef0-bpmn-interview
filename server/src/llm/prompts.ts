export const EXTRACTION_SYSTEM_PROMPT = `Ты — модуль извлечения структуры бизнес-процесса из текста интервью для системы построения моделей IDEF0 и BPMN.

Правила:
1. Используй ТОЛЬКО факты из предоставленных фрагментов. Ничего не придумывай.
2. Каждый извлечённый элемент обязан ссылаться на fragment_id и содержать дословную цитату (quote) из этого фрагмента, подтверждающую элемент.
3. Реплики интервьюера (speaker=interviewer) — это только контекст для понимания вопроса. Не создавай из них факты о процессе, но можно на них ссылаться, если ответ на них короткий ("да", "верно").
4. Действия называй в формате "глагол в инфинитиве + объект" (например: "согласовать заявку", "передать документ в бухгалтерию").
5. События называй в формате "состояние объекта" (например: "заявка одобрена", "договор подписан").
6. Разделяй факты AS-IS от пожеланий (proposal, TO-BE) и проблем/болей (problem) — они уходят в statements, а не в nodes.
7. Если формулировка содержит маркеры неопределённости ("обычно", "иногда", "бывает", "как правило") — всё равно извлеки как node/flow, но confidence должен быть ниже (0.3-0.6).
8. order_hint — целое число, отражающее порядок действия по смыслу текста (для последующей сборки потока).
9. Отвечай строго вызовом инструмента extract_process_chunk, без свободного текста.`;

/** ФТ-М9.5.2: распознавание схемы процесса (фото/скан) в ту же структуру PLM, что и извлечение из текста. */
export const DIAGRAM_RECOGNITION_SYSTEM_PROMPT = `Ты — модуль распознавания схем бизнес-процессов (IDEF0/BPMN/блок-схема) по изображению для системы построения моделей.

Правила:
1. Извлекай только то, что действительно видно на изображении — не додумывай шаги, которых нет на схеме.
2. Для каждого извлечённого элемента (роль, действие, связь) в поле quote укажи подпись/текст элемента, как она видна на изображении (это заменяет цитату из текста при обычном извлечении).
3. Используй fragment_id = "diagram_image" для всех элементов (единый источник — изображение целиком).
4. Действия называй в формате "глагол в инфинитиве + объект".
5. Если подпись элемента нечитаема или не до конца ясна — извлеки его с confidence не выше 0.4 (такие элементы будут помечены как гипотезы).
6. Отвечай строго вызовом инструмента extract_process_chunk, без свободного текста.`;

export function buildDiagramRecognitionUserPrompt(processName: string, modelType: string): string {
  return `Процесс: "${processName}". Тип модели: ${modelType}.

На изображении — схема процесса (фото, скан или экспорт из редактора диаграмм). Распознай роли, системы, документы/данные, действия/события/ветвления и связи между ними. Вызови инструмент extract_process_chunk.`;
}

/** ФТ-М9.1.2: краткие похожие утверждённые примеры из корпуса — как few-shot подсказка LLM (не используется офлайн-провайдером). */
export function buildChunkUserPrompt(
  processName: string,
  modelType: string,
  fragmentsText: string,
  fewShotContext?: string
): string {
  return `Процесс: "${processName}". Тип модели: ${modelType}.
${fewShotContext ? `\n${fewShotContext}\n` : ""}
Фрагменты интервью (speaker=owner/participant — факты процесса, speaker=interviewer — вопросы для контекста):

${fragmentsText}

Извлеки роли, системы, документы/данные, регламенты, действия/события/ветвления (nodes), связи между ними (flows, по order_hint), и отдельно проблемы/пожелания (statements). Вызови инструмент extract_process_chunk.`;
}

export const EXTRACTION_TOOL = {
  name: "extract_process_chunk",
  description:
    "Структурированное извлечение элементов бизнес-процесса из фрагмента текста интервью.",
  input_schema: {
    type: "object" as const,
    required: ["roles", "systems", "data", "controls", "nodes", "flows", "statements", "process_hints"],
    properties: {
      roles: {
        type: "array",
        items: {
          type: "object",
          required: ["name", "kind", "source_fragment_id", "quote", "confidence"],
          properties: {
            name: { type: "string" },
            kind: { enum: ["internal", "external"] },
            source_fragment_id: { type: "string" },
            quote: { type: "string" },
            confidence: { type: "number" },
          },
        },
      },
      systems: {
        type: "array",
        items: {
          type: "object",
          required: ["name", "source_fragment_id", "quote", "confidence"],
          properties: {
            name: { type: "string" },
            source_fragment_id: { type: "string" },
            quote: { type: "string" },
            confidence: { type: "number" },
          },
        },
      },
      data: {
        type: "array",
        items: {
          type: "object",
          required: ["name", "kind", "source_fragment_id", "quote", "confidence"],
          properties: {
            name: { type: "string" },
            kind: { enum: ["document", "data"] },
            source_fragment_id: { type: "string" },
            quote: { type: "string" },
            confidence: { type: "number" },
          },
        },
      },
      controls: {
        type: "array",
        items: {
          type: "object",
          required: ["name", "kind", "source_fragment_id", "quote", "confidence"],
          properties: {
            name: { type: "string" },
            kind: { enum: ["regulation", "rule", "norm"] },
            source_fragment_id: { type: "string" },
            quote: { type: "string" },
            confidence: { type: "number" },
          },
        },
      },
      nodes: {
        type: "array",
        items: {
          type: "object",
          required: ["type", "name", "order_hint", "source_fragment_id", "quote", "confidence"],
          properties: {
            type: { enum: ["task", "event", "gateway", "subprocess"] },
            subtype: { type: "string" },
            name: { type: "string" },
            role_name: { type: ["string", "null"] },
            system_names: { type: "array", items: { type: "string" } },
            input_names: { type: "array", items: { type: "string" } },
            output_names: { type: "array", items: { type: "string" } },
            control_names: { type: "array", items: { type: "string" } },
            duration: { type: ["string", "null"] },
            frequency: { type: ["string", "null"] },
            condition_branches: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  condition: { type: "string" },
                  next_hint: { type: "string" },
                },
              },
            },
            order_hint: { type: "number" },
            source_fragment_id: { type: "string" },
            quote: { type: "string" },
            confidence: { type: "number" },
          },
        },
      },
      flows: {
        type: "array",
        items: {
          type: "object",
          required: ["from_order_hint", "to_order_hint", "source_fragment_id", "quote"],
          properties: {
            from_order_hint: { type: "number" },
            to_order_hint: { type: "number" },
            condition: { type: ["string", "null"] },
            source_fragment_id: { type: "string" },
            quote: { type: "string" },
          },
        },
      },
      statements: {
        type: "array",
        items: {
          type: "object",
          required: ["kind", "text", "source_fragment_id", "quote"],
          properties: {
            kind: { enum: ["problem", "proposal"] },
            text: { type: "string" },
            source_fragment_id: { type: "string" },
            quote: { type: "string" },
          },
        },
      },
      process_hints: {
        type: "object",
        properties: {
          goal: { type: ["string", "null"] },
          trigger: { type: ["string", "null"] },
          result: { type: ["string", "null"] },
        },
      },
    },
  },
};
