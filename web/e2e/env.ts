import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

/** Порты не пересекаются с dev-серверами (8787, 5173), поэтому тесты можно гонять при запущенной разработке. */
export const API_PORT = Number(process.env.E2E_API_PORT) || 18787;
export const WEB_PORT = Number(process.env.E2E_WEB_PORT) || 15173;
export const API = `http://127.0.0.1:${API_PORT}/api`;
export const WEB = `http://localhost:${WEB_PORT}`;
export const USER = { login: "e2e", password: "e2e-pass" };

export const INTERVIEW =
  "Юрист получает заявку от менеджера. Затем юрист проверяет договор на соответствие шаблону. Если есть замечания, юрист возвращает договор менеджеру на доработку. " +
  "Если замечаний нет, юрист отправляет договор на согласование финансовому директору. Финансовый директор согласует договор в течение 2 дней. " +
  "После этого менеджер подписывает договор с клиентом и передаёт копию в бухгалтерию. Бухгалтер регистрирует договор в 1С.";

/** Браузер: локально на Windows — установленный Edge, в CI — Chromium из Playwright. */
export function launch(): Promise<Browser> {
  const channel = process.env.E2E_BROWSER_CHANNEL ?? (process.platform === "win32" ? "msedge" : undefined);
  return chromium.launch({ channel, headless: process.env.E2E_HEADED ? false : true });
}

let cookie = "";
async function login(): Promise<string> {
  if (cookie) return cookie;
  const r = await fetch(`${API}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(USER) });
  if (!r.ok) throw new Error(`вход не удался: ${r.status}`);
  cookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
  return cookie;
}

/** Запрос к API от имени тестового пользователя (подготовка данных и проверка результата на сервере). */
export async function api<T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T }> {
  const r = await fetch(API + path, {
    method,
    headers: { Cookie: await login(), ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, body: (text ? JSON.parse(text) : null) as T };
}

/** Сессия с моделью, построенной офлайн-экстрактором по тексту интервью. */
export async function seedSession(name = "Согласование договора"): Promise<string> {
  const s = await api<{ id: string }>("POST", "/sessions", { meta: { processName: name } });
  await api("POST", `/sessions/${s.body.id}/ingest-text`, { text: INTERVIEW });
  const job = await api<{ id: string }>("POST", `/sessions/${s.body.id}/run`, {});
  for (let i = 0; i < 120; i++) {
    const j = await api<{ status: string; error?: string }>("GET", `/jobs/${job.body.id}`);
    if (j.body.status === "done") return s.body.id;
    if (j.body.status === "failed") throw new Error(j.body.error);
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("обработка не завершилась");
}

/** Новый контекст браузера (чистое хранилище) с уже выполненным входом; ошибки страницы собираются. */
export async function openContext(browser: Browser): Promise<{ ctx: BrowserContext; page: Page; errors: string[] }> {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 }, locale: "ru-RU" });
  // сессия входа общая на весь прогон: у сервера лимит попыток входа (10 за 10 минут), а контекстов в тестах больше
  const [name, ...value] = (await login()).split("=");
  await ctx.addCookies([{ name, value: value.join("="), url: WEB }]);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
  return { ctx, page, errors };
}

/** Дождаться заголовка панели «Свойства» (панель перерисовывается после действия, не мгновенно). */
export const expectPanel = (page: Page, title: string | RegExp) =>
  page.locator(".props-head b", { hasText: typeof title === "string" ? new RegExp(`^${title}$`) : title }).waitFor({ timeout: 5000 });
export const field = (page: Page, label: string) => page.locator(".props-body .bpe-field").filter({ has: page.locator(`> label:text-is("${label}")`) }).locator("input, textarea, select").first();
export const statusText = (page: Page) => page.locator(".statusbar > span").last().innerText();
