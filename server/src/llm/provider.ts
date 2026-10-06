import Anthropic from "@anthropic-ai/sdk";
import type { ExtractionChunkResult, LLMFragmentInput, LLMProvider } from "./types.js";
import { EXTRACTION_SYSTEM_PROMPT, EXTRACTION_TOOL, buildChunkUserPrompt, DIAGRAM_RECOGNITION_SYSTEM_PROMPT, buildDiagramRecognitionUserPrompt } from "./prompts.js";
import { mockExtractChunk } from "./mockProvider.js";

const MODEL_ID = process.env.LLM_MODEL || "claude-sonnet-4-5";

function formatFragments(fragments: LLMFragmentInput[]): string {
  return fragments
    .map((f) => `[${f.id}] (${f.speaker_label ?? f.speaker}): ${f.text}`)
    .join("\n");
}

export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async extractChunk(
    fragments: LLMFragmentInput[],
    context: { processName: string; modelType: "AS-IS" | "TO-BE"; fewShotContext?: string },
    opts?: { model?: string }
  ): Promise<ExtractionChunkResult> {
    const msg = await this.client.messages.create({
      model: opts?.model || MODEL_ID,
      max_tokens: 4096,
      temperature: 0,
      system: EXTRACTION_SYSTEM_PROMPT,
      tools: [EXTRACTION_TOOL as any],
      tool_choice: { type: "tool", name: "extract_process_chunk" },
      messages: [
        {
          role: "user",
          content: buildChunkUserPrompt(context.processName, context.modelType, formatFragments(fragments), context.fewShotContext),
        },
      ],
    });

    const toolUse = msg.content.find((b) => b.type === "tool_use") as
      | Anthropic.ToolUseBlock
      | undefined;
    if (!toolUse) {
      throw new Error("LLM did not return structured tool_use output");
    }
    return toolUse.input as ExtractionChunkResult;
  }

  /** ФТ-М9.5.2: распознавание схемы процесса на изображении мультимодальной моделью. */
  async recognizeDiagramImage(
    imageBase64: string,
    mimeType: string,
    context: { processName: string; modelType: "AS-IS" | "TO-BE" }
  ): Promise<ExtractionChunkResult> {
    const msg = await this.client.messages.create({
      model: MODEL_ID,
      max_tokens: 4096,
      temperature: 0,
      system: DIAGRAM_RECOGNITION_SYSTEM_PROMPT,
      tools: [EXTRACTION_TOOL as any],
      tool_choice: { type: "tool", name: "extract_process_chunk" },
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mimeType as any, data: imageBase64 } },
            { type: "text", text: buildDiagramRecognitionUserPrompt(context.processName, context.modelType) },
          ],
        },
      ],
    });
    const toolUse = msg.content.find((b) => b.type === "tool_use") as Anthropic.ToolUseBlock | undefined;
    if (!toolUse) throw new Error("LLM did not return structured tool_use output");
    return toolUse.input as ExtractionChunkResult;
  }
}

/**
 * ФТ-М9.3.1: локальный инференс (vLLM или аналог, OpenAI-совместимый API) для
 * конфиденциальных процессов (ФТ-М9.3.2) — данные не покидают контур (НФТ-6).
 * Формат вызова — OpenAI chat.completions с tool-calling, т.к. это наиболее
 * распространённый совместимый интерфейс у локальных серверов инференса.
 */
/** URL chat/completions: полный путь — как есть; корень хоста — /v1/chat/completions; иначе (…/v1, …/openai) — /chat/completions. */
function chatCompletionsUrl(baseUrl: string): string {
  const url = baseUrl.replace(/\/+$/, "");
  if (url.endsWith("/chat/completions")) return url;
  const { pathname } = new URL(url);
  return pathname === "/" || pathname === "" ? `${url}/v1/chat/completions` : `${url}/chat/completions`;
}

export class LocalProvider implements LLMProvider {
  readonly name: string = "local";
  /** Модели агентов (db.ts) заданы под Anthropic; облачный провайдер их игнорирует и берёт свою. */
  protected honorModelOverride = true;
  constructor(private baseUrl: string, private defaultModel: string, private apiKey?: string) {}

  async extractChunk(
    fragments: LLMFragmentInput[],
    context: { processName: string; modelType: "AS-IS" | "TO-BE"; fewShotContext?: string },
    opts?: { model?: string }
  ): Promise<ExtractionChunkResult> {
    const res = await fetch(chatCompletionsUrl(this.baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: (this.honorModelOverride && opts?.model) || this.defaultModel,
        temperature: 0,
        messages: [
          { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
          { role: "user", content: buildChunkUserPrompt(context.processName, context.modelType, formatFragments(fragments), context.fewShotContext) },
        ],
        tools: [{ type: "function", function: { name: EXTRACTION_TOOL.name, description: EXTRACTION_TOOL.description, parameters: (EXTRACTION_TOOL as any).input_schema } }],
        tool_choice: { type: "function", function: { name: EXTRACTION_TOOL.name } },
      }),
    });
    if (!res.ok) {
      throw new Error(`Локальный провайдер вернул ошибку ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as any;
    const toolCall = data.choices?.[0]?.message?.tool_calls?.[0];
    if (!toolCall) {
      throw new Error("Локальный провайдер не вернул структурированный вызов инструмента");
    }
    return JSON.parse(toolCall.function.arguments) as ExtractionChunkResult;
  }
}

/**
 * Внешний облачный OpenAI-совместимый провайдер (Gemini, Groq, OpenRouter и т.п.) —
 * LLM_BASE_URL + LLM_API_KEY + LLM_OPENAI_MODEL. В отличие от LocalProvider данные
 * уходят наружу, поэтому для конфиденциальных процессов он не используется.
 */
export class OpenAICompatProvider extends LocalProvider {
  readonly name: string = "openai-compat";
  protected honorModelOverride = false;
}

/**
 * Детерминированный офлайн-провайдер на правилах и словарях.
 * Используется, когда не настроен внешний LLM (ANTHROPIC_API_KEY),
 * чтобы конвейер работал полностью локально (соответствует НФТ-4 «режим без
 * передачи данных наружу») и был тестируем без сети. Качество извлечения
 * ниже, чем у LLM — это осознанный fallback, а не замена.
 */
export class MockProvider implements LLMProvider {
  readonly name = "mock";
  async extractChunk(
    fragments: LLMFragmentInput[],
    context: { processName: string; modelType: "AS-IS" | "TO-BE" }
  ): Promise<ExtractionChunkResult> {
    return mockExtractChunk(fragments, context);
  }
}

let cachedProvider: LLMProvider | null = null;
let cachedLocalProvider: LocalProvider | null | undefined;

export function getLocalProviderIfConfigured(): LocalProvider | null {
  if (cachedLocalProvider !== undefined) return cachedLocalProvider;
  const baseUrl = process.env.LOCAL_LLM_BASE_URL;
  cachedLocalProvider = baseUrl
    ? new LocalProvider(baseUrl, process.env.LOCAL_LLM_MODEL || "local-model", process.env.LOCAL_LLM_API_KEY)
    : null;
  return cachedLocalProvider;
}

function getOpenAICompatProviderIfConfigured(): OpenAICompatProvider | null {
  const baseUrl = process.env.LLM_BASE_URL;
  if (!baseUrl) return null;
  return new OpenAICompatProvider(baseUrl, process.env.LLM_OPENAI_MODEL || "gemini-2.0-flash", process.env.LLM_API_KEY);
}

export function getLLMProvider(): LLMProvider {
  if (cachedProvider) return cachedProvider;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  cachedProvider = apiKey
    ? new AnthropicProvider(apiKey)
    : getOpenAICompatProviderIfConfigured() ?? new MockProvider();
  return cachedProvider;
}

/**
 * ФТ-М9.3.2: маршрутизация по признаку конфиденциальности — процесс с этим
 * признаком обрабатывается ТОЛЬКО локальным провайдером; если он не
 * настроен, обработка отклоняется явной ошибкой (никогда не уходит наружу).
 */
export function resolveProvider(confidential?: boolean): LLMProvider {
  if (confidential) {
    const local = getLocalProviderIfConfigured();
    if (!local) {
      throw new Error(
        "Процесс помечен как конфиденциальный — обработка допускается только локальным провайдером (LOCAL_LLM_BASE_URL), но он не настроен."
      );
    }
    return local;
  }
  return getLLMProvider();
}

export function providerStatus(): { name: string; live: boolean; localConfigured: boolean } {
  const p = getLLMProvider();
  return { name: p.name, live: p.name !== "mock", localConfigured: !!getLocalProviderIfConfigured() };
}

/** ФТ-М9.1.4/9.3.3: получить провайдер по имени для регрессионной оценки/сравнения (без учёта конфиденциальности). */
export function getProviderByName(name: string): LLMProvider {
  if (name === "mock") return new MockProvider();
  if (name === "anthropic") {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("Anthropic-провайдер не настроен (нет ANTHROPIC_API_KEY).");
    return new AnthropicProvider(apiKey);
  }
  if (name === "openai-compat") {
    const p = getOpenAICompatProviderIfConfigured();
    if (!p) throw new Error("Облачный OpenAI-совместимый провайдер не настроен (нет LLM_BASE_URL).");
    return p;
  }
  if (name === "local") {
    const local = getLocalProviderIfConfigured();
    if (!local) throw new Error("Локальный провайдер не настроен (нет LOCAL_LLM_BASE_URL).");
    return local;
  }
  throw new Error(`Неизвестный провайдер: ${name}`);
}
