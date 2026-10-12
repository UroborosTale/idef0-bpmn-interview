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
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (BLOCKED_HOSTS.test(host) || (isIP(host) !== 0 && isPrivateAddress(host))) {
    return { ok: false, error: "webhook_url указывает на внутренний/служебный адрес — запрещено" };
  }
  return { ok: true, parsed };
}

function privateV4(a: number, b: number): boolean {
  return (
    a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)) || (a === 192 && b === 0) || a >= 224
  );
}

/** Восемь 16-битных групп IPv6 (с раскрытием «::» и записью с IPv4 в конце); null — не IPv6. */
function v6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase().split("%")[0];
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) {
    const p = dotted[1].split(".").map(Number);
    s = s.slice(0, -dotted[1].length) + `${((p[0] << 8) | p[1]).toString(16)}:${((p[2] << 8) | p[3]).toString(16)}`;
  }
  const [head, tail] = s.includes("::") ? s.split("::") : [s, null];
  const h = head ? head.split(":") : [];
  const t = tail === null ? [] : tail ? tail.split(":") : [];
  const fill = tail === null ? 0 : 8 - h.length - t.length;
  if (fill < 0) return null;
  const groups = [...h, ...Array(fill).fill("0"), ...t].map((g) => parseInt(g || "0", 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/**
 * Адрес из частной, локальной или служебной сети. IPv6 разбирается полностью: URL записывает [::ffff:127.0.0.1] как ::ffff:7f00:1,
 * поэтому вложенный IPv4 (IPv4-mapped, IPv4-compatible, NAT64 64:ff9b::/96) извлекается из групп и проверяется по правилам IPv4.
 * Нераспознанный адрес считается запрещённым.
 */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return privateV4(a, b);
  }
  const g = v6Groups(ip);
  if (!g) return true;
  const embedded = (hi: number, lo: number) => privateV4(hi >> 8, hi & 0xff) || (hi === 0 && lo === 0);
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return g[5] === 0 && g[6] === 0 ? g[7] <= 1 || embedded(g[6], g[7]) : embedded(g[6], g[7]); // ::, ::1, mapped, compatible
  if (g[0] === 0x64 && g[1] === 0xff9b) return true; // NAT64: внутри может быть что угодно, наружу такие адреса не нужны
  return (g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0 || (g[0] & 0xff00) === 0xff00; // ULA, link-/site-local, multicast
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
