/**
 * Базовая защита от SSRF на внутренние/служебные адреса (localhost, private
 * ranges, link-local метаданные облака) для генерических вебхук-коннекторов
 * (М1.5 карточка процесса, М4.2 напоминания кампаний). Не полноценная защита
 * (без резолва DNS/редиректов), но отсекает очевидные случаи.
 */
const BLOCKED_HOSTS = /^(localhost|127\.|0\.0\.0\.0|::1|169\.254\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i;

export function validateWebhookUrl(url: string): { ok: true; parsed: URL } | { ok: false; error: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: "webhook_url is not a valid URL" };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, error: "webhook_url must use http or https" };
  }
  if (BLOCKED_HOSTS.test(parsed.hostname)) {
    return { ok: false, error: "webhook_url указывает на внутренний/служебный адрес — запрещено" };
  }
  return { ok: true, parsed };
}
