import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

/** Поднимает приложение на свободном порту и возвращает клиент с хранением cookie. */
export async function startApp() {
  const { app } = await import("../src/app.js");
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  let cookie = "";
  /** method "PUT_BASE" и url «путь|updatedAt» — PUT с заголовком X-Base-Updated-At. */
  const call = async (method: string, url: string, body?: unknown, extraHeaders: Record<string, string> = {}) => {
    let baseHeader: Record<string, string> = {};
    if (method === "PUT_BASE") {
      const [path, b] = url.split("|");
      method = "PUT";
      url = path;
      baseHeader = { "X-Base-Updated-At": b };
    }
    const res = await fetch(base + url, {
      method,
      headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}), ...baseHeader, ...extraHeaders },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, body: json };
  };
  /** Тело ответа как есть (архивы и другие бинарные выгрузки). */
  const raw = async (url: string) => {
    const res = await fetch(base + url, { headers: cookie ? { Cookie: cookie } : {} });
    return { status: res.status, body: Buffer.from(await res.arrayBuffer()) };
  };
  /** Запрос без cookie входа (проверка доступа по токену агента). */
  const withoutCookie = async (method: string, url: string, headers: Record<string, string>, body?: unknown) => {
    const res = await fetch(base + url, { method, headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, body: json };
  };
  return { call, raw, withoutCookie, close: () => new Promise<void>((r) => server.close(() => r())), resetCookie: () => (cookie = "") };
}
