import { REFERENCE_PROCESSES } from "../reference/index.js";

/**
 * Загрузить эталонный или демонстрационный процесс в приложение новой сессией:
 *   npm run seed:process -w server -- c025      (процесс C025 «Организация обучения и аттестации персонала» по документу «ДПО от 05.10»)
 *   npm run seed:process -w server -- b002      (эталон B002 из документов организации)
 *   npm run seed:process -w server -- demo      (демонстрационный процесс C090: все возможности редактора на одном процессе)
 *   npm run seed:process -w server -- b002 --replace sess_oW_DKJapR8
 *       (D5: заменить модель существующей сессии эталоном — так убираются ручные правки вроде шлюза «фывфвфы»)
 * Откройте сессию в студии. Создание сессии — действие аналитика, поэтому при включённом AUTH_USERS нужны PM_LOGIN и PM_PASSWORD.
 */
const name = (process.argv[2] ?? "").toLowerCase();
const replaceIdx = process.argv.indexOf("--replace");
const replaceId = replaceIdx >= 0 ? process.argv[replaceIdx + 1] : undefined;
if (replaceIdx >= 0 && !replaceId) {
  console.error("После --replace укажите id сессии, например: npm run seed:process -w server -- b002 --replace sess_oW_DKJapR8");
  process.exit(1);
}
const entry = REFERENCE_PROCESSES[name];
if (!entry) {
  console.error(`Укажите процесс: ${Object.keys(REFERENCE_PROCESSES).join(" | ")}`);
  process.exit(1);
}

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

const model = entry.build();
if (replaceId) {
  // D5: заменить модель существующей сессии эталоном (ручные правки сессии при этом теряются — это и нужно)
  const cur = await call("GET", `/sessions/${replaceId}`);
  if (cur.status !== 200) {
    console.error("Сессия не найдена:", cur.body?.error ?? cur.status);
    process.exit(1);
  }
  const saved = await call("PUT", `/sessions/${replaceId}/model`, model, { "X-Base-Updated-At": cur.body.updatedAt });
  if (saved.status !== 200) {
    console.error("Не удалось записать модель:", saved.body?.error ?? saved.status);
    process.exit(1);
  }
  const rebuilt = await call("POST", `/sessions/${replaceId}/rebuild-diagrams`);
  if (rebuilt.status !== 200 || rebuilt.body?.diagramsStale !== false) {
    console.error("Не удалось пересобрать диаграммы:", rebuilt.body?.error ?? rebuilt.status);
    process.exit(1);
  }
  console.log(`Заменено эталоном (${entry.title}): сессия ${replaceId}.\nОткройте в студии: /s/${replaceId}`);
  process.exit(0);
}

const created = await call("POST", "/sessions/blank", { meta: { processName: model.process.name, department: model.process.department, owner: model.process.owner } });
if (created.status !== 201) {
  console.error("Не удалось создать сессию:", created.body?.error ?? created.status);
  process.exit(1);
}
const saved = await call("PUT", `/sessions/${created.body.id}/model`, model, { "X-Base-Updated-At": created.body.updatedAt });
if (saved.status !== 200) {
  console.error("Не удалось записать модель:", saved.body?.error ?? saved.status);
  process.exit(1);
}
// PUT модели помечает диаграммы устаревшими (они были собраны из пустой модели) — собираем их из эталона,
// иначе сессия открывается с «Пересобрать диаграммы (модель изменена)» и пустыми схемами
const rebuilt = await call("POST", `/sessions/${created.body.id}/rebuild-diagrams`);
if (rebuilt.status !== 200 || rebuilt.body?.diagramsStale !== false) {
  console.error("Не удалось пересобрать диаграммы:", rebuilt.body?.error ?? rebuilt.status);
  process.exit(1);
}
console.log(`Загружено (${entry.title}): сессия ${created.body.id}.\nОткройте в студии: /s/${created.body.id}`);