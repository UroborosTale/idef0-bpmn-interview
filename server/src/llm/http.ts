/**
 * Вызовы LLM по HTTP с таймаутом и повторами: 429 и 5xx, обрыв сети и таймаут повторяются с растущей
 * паузой (с учётом Retry-After), остальные ошибки (400, 401, 403) — сразу, повтор их не исправит.
 */

export const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS) || 120_000;
export const LLM_RETRIES = Number.isFinite(Number(process.env.LLM_RETRIES)) && process.env.LLM_RETRIES !== undefined ? Number(process.env.LLM_RETRIES) : 3;

export class LLMHttpError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfterMs?: number) {
    super(message);
  }
  get retryable() {
    return this.status === 429 || this.status >= 500;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const isTransient = (e: unknown) =>
  e instanceof LLMHttpError ? e.retryable : e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError" || /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i.test(e.message + String((e as any).cause ?? "")));

/** Выполняет fn с повторами при временных ошибках. delays — для тестов. */
export async function withRetry<T>(fn: () => Promise<T>, opts: { retries?: number; baseDelayMs?: number } = {}): Promise<T> {
  const retries = opts.retries ?? LLM_RETRIES;
  const base = opts.baseDelayMs ?? 1500;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= retries || !isTransient(e)) throw e;
      const hinted = e instanceof LLMHttpError ? e.retryAfterMs : undefined;
      await sleep(Math.min(60_000, hinted ?? base * 2 ** attempt + Math.random() * 300));
    }
  }
}

/** POST JSON с таймаутом; ответ не 2xx превращается в LLMHttpError. */
export async function postJson(url: string, body: unknown, headers: Record<string, string>, label: string): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  });
  if (!res.ok) {
    const ra = Number(res.headers.get("retry-after"));
    const text = (await res.text()).slice(0, 500);
    throw new LLMHttpError(`${label} вернул ошибку ${res.status}: ${text}`, res.status, Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined);
  }
  return res.json();
}
