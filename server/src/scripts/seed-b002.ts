import { b002Model } from "../reference/b002.js";

/**
 * Загрузить эталон B002 в приложение как новую сессию: `npm run seed:b002 -w server`.
 * Откройте её в студии и сверьте с диаграммами Visio; она же нужна для репетиции работы с агентами.
 * Создание сессии — действие аналитика, поэтому нужен вход: при включённом AUTH_USERS задайте PM_LOGIN и PM_PASSWORD.
 */
const base = (process.env.PM_API_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
let cookie = "";
const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(`${base}/api${path}`, { method, headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json: any = text;
  try {
    json = JSON.parse(text);
  } catch {
    /* не JSON */
  }
  return { status: res.status, body: json, setCookie: res.headers.get("set-cookie") };
};

const me = await call("GET", "/auth/me");
if (me.status === 200 && me.body.authRequired) {
  const { PM_LOGIN, PM_PASSWORD } = process.env;
  if (!PM_LOGIN || !PM_PASSWORD) {
    console.error("В приложении включён вход: задайте PM_LOGIN и PM_PASSWORD (логин и пароль аналитика).");
    process.exit(1);
  }
  const login = await call("POST", "/auth/login", { login: PM_LOGIN, password: PM_PASSWORD });
  if (login.status !== 200) {
    console.error("Вход не удался: неверный логин или пароль.");
    process.exit(1);
  }
  cookie = (login.setCookie ?? "").split(";")[0];
}

const model = b002Model();
const created = await call("POST", "/sessions/blank", { meta: { processName: `${model.process.name} (эталон B002)`, department: model.process.department, owner: model.process.owner } });
if (created.status !== 201) {
  console.error("Не удалось создать сессию:", created.body?.error ?? created.status);
  process.exit(1);
}
const saved = await call("PUT", `/sessions/${created.body.id}/model`, model, { "X-Base-Updated-At": created.body.updatedAt });
if (saved.status !== 200) {
  console.error("Не удалось записать модель:", saved.body?.error ?? saved.status);
  process.exit(1);
}
console.log(`Эталон B002 загружен: сессия ${created.body.id}.\nОткройте её в студии: /s/${created.body.id}\nСравнить с моделью агента: npm run eval:b002 -w server -- <id сессии>`);
