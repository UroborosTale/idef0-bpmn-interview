import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../src/util/password.js";
import { startApp } from "./api.js";

process.env.AUTH_USERS = `analyst:${hashPassword("secret")},owner:plain`;

let app: Awaited<ReturnType<typeof startApp>>;
beforeAll(async () => {
  app = await startApp();
});
afterAll(() => app.close());

describe("вход", () => {
  it("служебные ручки открыты, остальные требуют входа", async () => {
    expect((await app.call("GET", "/health")).status).toBe(200);
    expect((await app.call("GET", "/auth/me")).body).toEqual({ authRequired: true, user: null });
    expect((await app.call("GET", "/sessions")).status).toBe(401);
    expect((await app.call("GET", "/export/x")).status).toBe(401);
  });

  it("ответы респондентов по ссылке кампании не требуют входа", async () => {
    const r = await app.call("GET", "/campaigns/c1/respond/unknown-token");
    expect(r.status).not.toBe(401);
  });

  it("неверный пароль отклоняется, верный открывает доступ", async () => {
    expect((await app.call("POST", "/auth/login", { login: "analyst", password: "wrong" })).status).toBe(401);
    expect((await app.call("POST", "/auth/login", { login: "nobody", password: "secret" })).status).toBe(401);
    const ok = await app.call("POST", "/auth/login", { login: "analyst", password: "secret" });
    expect(ok.status).toBe(200);
    expect((await app.call("GET", "/sessions")).status).toBe(200);
    expect((await app.call("GET", "/auth/me")).body.user).toEqual({ login: "analyst" });
  });

  it("выход закрывает доступ", async () => {
    await app.call("POST", "/auth/logout", {});
    app.resetCookie();
    expect((await app.call("GET", "/sessions")).status).toBe(401);
  });

  it("пользователя убрали из AUTH_USERS — его вход сразу перестаёт действовать", async () => {
    app.resetCookie();
    expect((await app.call("POST", "/auth/login", { login: "owner", password: "plain" })).status).toBe(200);
    expect((await app.call("GET", "/sessions")).status).toBe(200);
    const before = process.env.AUTH_USERS;
    process.env.AUTH_USERS = `analyst:${hashPassword("secret")}`;
    try {
      expect((await app.call("GET", "/sessions")).status).toBe(401);
    } finally {
      process.env.AUTH_USERS = before;
    }
    app.resetCookie();
  });

  it("заголовки безопасности: встраивание в iframe только со своего источника (предпросмотр регламента), sniffing запрещён", async () => {
    const r = await fetch(`${app.url}/api/health`);
    expect(r.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("перебор паролей ограничен", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await app.call("POST", "/auth/login", { login: "owner", password: "x" })).status);
    expect(statuses).toContain(429);
  });
});
