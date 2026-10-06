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
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(base + url, {
      method,
      headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) },
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
  return { call, close: () => new Promise<void>((r) => server.close(() => r())), resetCookie: () => (cookie = "") };
}
