import crypto from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import { db } from "./db.js";
import { verifyPassword } from "./util/password.js";
import { runWithUser } from "./util/requestContext.js";

/**
 * Вход для аналитиков. Пользователи задаются переменной AUTH_USERS: «логин:пароль» через запятую;
 * пароль можно хранить хэшем scrypt (`npm run hash-password -w server -- <пароль>`). Если AUTH_USERS
 * не задана, вход отключён — режим локальной разработки (сервер слушает только 127.0.0.1).
 *
 * Без входа открыты только служебные ручки и ответы респондентов по персональной ссылке кампании.
 */

const COOKIE = "pm_auth";
const TTL_MS = 12 * 60 * 60 * 1000;

db.exec(`CREATE TABLE IF NOT EXISTS auth_sessions (
  token TEXT PRIMARY KEY,
  login TEXT NOT NULL,
  expires_at INTEGER NOT NULL
)`);

export interface AuthUser {
  login: string;
}

declare module "express-serve-static-core" {
  interface Request {
    user?: AuthUser;
  }
}

function users(): Map<string, string> {
  const out = new Map<string, string>();
  for (const pair of (process.env.AUTH_USERS ?? "").split(",")) {
    const i = pair.indexOf(":");
    if (i > 0) out.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
  return out;
}

export const authEnabled = () => users().size > 0;

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

function userOf(req: Request): AuthUser | null {
  const token = readCookie(req, COOKIE);
  if (!token) return null;
  const row = db.prepare(`SELECT login, expires_at FROM auth_sessions WHERE token = ?`).get(token) as { login: string; expires_at: number } | undefined;
  if (!row || row.expires_at < Date.now()) return null;
  // пользователя убрали из AUTH_USERS — его вход больше не действует (раньше сессия жила до истечения, 12 ч)
  if (!users().has(row.login)) return null;
  return { login: row.login };
}

/**
 * Агент (Cline через MCP-сервер) входит по токену AGENT_API_TOKEN в заголовке Authorization: Bearer — и только в ручки
 * /agent/*: чтение модели и отправка предложений. Применять предложения агент не может, это решает человек.
 */
function agentOf(req: Request): AuthUser | null {
  const expected = process.env.AGENT_API_TOKEN;
  if (!expected || !/^\/agent\//.test(req.path)) return null;
  const given = /^Bearer (.+)$/i.exec(req.headers.authorization ?? "")?.[1];
  if (!given) return null;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? { login: "agent" } : null;
}

/** Простое ограничение частоты по ключу (IP, токен): не больше limit запросов за windowMs. */
export function rateLimit(limit: number, windowMs: number, keyOf: (req: Request) => string) {
  const hits = new Map<string, number[]>();
  return (req: Request, res: Response, next: NextFunction) => {
    const key = keyOf(req);
    const now = Date.now();
    const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= limit) {
      res.status(429).json({ error: "слишком много запросов, повторите позже" });
      return;
    }
    recent.push(now);
    hits.set(key, recent);
    if (hits.size > 10_000) hits.clear(); // защита памяти от перебора ключей
    next();
  };
}

const ipOf = (req: Request) => req.ip ?? req.socket.remoteAddress ?? "?";

/** Ручки, доступные без входа. */
const PUBLIC = [/^\/health$/, /^\/auth\//, /^\/schema\//, /^\/campaigns\/[^/]+\/respond\/[^/]+(\/(turn|finish))?$/];

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!authEnabled()) {
    req.user = { login: "local" };
    return next();
  }
  if (PUBLIC.some((re) => re.test(req.path))) return next();
  const user = userOf(req) ?? agentOf(req);
  if (!user) {
    res.status(401).json({ error: "требуется вход" });
    return;
  }
  req.user = user;
  runWithUser(user.login, next);
}

/** Запрос пришёл с этой же машины (для действий, которые запускают программы на сервере). */
export const isLocalRequest = (req: Request) => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "");

export const authRouter = Router();

authRouter.get("/auth/me", (req, res) => {
  res.json({ authRequired: authEnabled(), user: authEnabled() ? userOf(req) : { login: "local" } });
});

authRouter.post(
  "/auth/login",
  rateLimit(10, 10 * 60 * 1000, ipOf),
  (req, res) => {
    const { login, password } = (req.body ?? {}) as { login?: string; password?: string };
    const stored = login ? users().get(login) : undefined;
    if (!login || !password || !stored || !verifyPassword(password, stored)) {
      res.status(401).json({ error: "неверный логин или пароль" });
      return;
    }
    const token = crypto.randomBytes(32).toString("base64url");
    db.prepare(`DELETE FROM auth_sessions WHERE expires_at < ?`).run(Date.now());
    db.prepare(`INSERT INTO auth_sessions (token, login, expires_at) VALUES (?, ?, ?)`).run(token, login, Date.now() + TTL_MS);
    const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
    res.setHeader("Set-Cookie", `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${TTL_MS / 1000}${secure ? "; Secure" : ""}`);
    res.json({ user: { login } });
  }
);

authRouter.post("/auth/logout", (req, res) => {
  const token = readCookie(req, COOKIE);
  if (token) db.prepare(`DELETE FROM auth_sessions WHERE token = ?`).run(token);
  res.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  res.json({ ok: true });
});

/** Базовые заголовки безопасности для ответов API. */
export function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  // SAMEORIGIN: предпросмотр регламента встроен в страницу приложения через iframe (тот же источник); чужим сайтам встраивание по-прежнему закрыто
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "same-origin");
  next();
}
