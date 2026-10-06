import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Защита от SSRF для генерических вебхук-коннекторов (М1.5 карточка процесса, М4.2 напоминания кампаний,
 * М7.4 уведомления): запросы не должны уходить на внутренние и служебные адреса (localhost, частные сети,
 * метаданные облака). validateWebhookUrl — быстрая проверка при сохранении настройки; safeWebhookFetch —
 * проверка при отправке: имя хоста разрешается в IP, каждый адрес проверяется, перенаправления не выполняются.
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
  if (BLOCKED_HOSTS.test(parsed.hostname.replace(/^\[|\]$/g, ""))) {
    return { ok: false, error: "webhook_url указывает на внутренний/служебный адрес — запрещено" };
  }
  return { ok: true, parsed };
}

/** Адрес из частной, локальной или служебной сети (IPv4 и IPv6, включая IPv4-mapped). */
export function isPrivateAddress(ip: string): boolean {
  const v4 = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  if (isIP(v4) === 4) {
    const [a, b] = v4.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  return v6 === "::" || v6 === "::1" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe8") || v6.startsWith("fe9") || v6.startsWith("fea") || v6.startsWith("feb");
}

/** Отправка вебхука: только на публичные адреса, без перенаправлений, с таймаутом. */
export async function safeWebhookFetch(url: string, init: RequestInit): Promise<Response> {
  const check = validateWebhookUrl(url);
  if (!check.ok) throw new Error(check.error);
  const host = check.parsed.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new Error("webhook_url разрешается во внутренний/служебный адрес — запрещено");
  }
  return fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(10_000) });
}
