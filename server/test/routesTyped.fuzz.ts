import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApp } from "./api.js";
import { REFERENCE_PROCESSES } from "../src/reference/index.js";

delete process.env.AUTH_USERS;

/**
 * Фаззинг API второго уровня: тела запросов строятся по типам из исходников маршрутов (req.body as { поле: тип }), id для путей
 * собираются из ответов (кампании, токены, дорожки, процессы реестра…), поэтому запросы доходят до логики, а не до 404.
 */

type Field = { name: string; type: string };

/** Содержимое сбалансированных фигурных скобок, начиная с позиции открывающей. */
function balanced(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open + 1, i);
  }
  return "";
}
/** Поля литерала типа верхнего уровня: «имя?: тип», разделители ; и перевод строки вне вложенных скобок. */
function parseFields(inner: string): Field[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of inner) {
    if ("{[(<".includes(ch)) depth++;
    if ("}])>".includes(ch)) depth--;
    if ((ch === ";" || ch === "\n" || ch === ",") && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);
  return parts.map((p) => /^\s*(\w+)\??\s*:\s*([\s\S]+?)\s*$/.exec(p)).filter((m): m is RegExpExecArray => !!m).map((m) => ({ name: m[1], type: m[2] }));
}
type RouteSpec = { method: string; path: string; fields: Field[] };

function routeSpecs(): RouteSpec[] {
  const dir = path.resolve(__dirname, "../src/routes");
  const out: RouteSpec[] = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
    const src = fs.readFileSync(path.join(dir, file), "utf8");
    const re = /\w+Router\.(get|post|put|patch|delete)\(\s*"([^"]+)"/g;
    let m: RegExpExecArray | null;
    const starts: { method: string; path: string; at: number }[] = [];
    while ((m = re.exec(src))) starts.push({ method: m[1].toUpperCase(), path: m[2], at: m.index });
    starts.forEach((s, i) => {
      const body = src.slice(s.at, starts[i + 1]?.at ?? src.length);
      const at = body.indexOf("req.body as {");
      const fields: Field[] = at >= 0 ? parseFields(balanced(body, at + "req.body as ".length)) : [];
      out.push({ method: s.method, path: "/api" + s.path, fields });
    });
  }
  return out;
}

let app: Awaited<ReturnType<typeof startApp>>;
const pool = new Map<string, Set<string>>(); // имя поля → значения
const remember = (key: string, v: unknown) => {
  if (typeof v !== "string" && typeof v !== "number") return;
  const s = String(v);
  if (!s || s.length > 200) return;
  if (!pool.has(key)) pool.set(key, new Set());
  pool.get(key)!.add(s);
};
/** Все id-подобные поля из ответа: id, key, token, seq, …Id. */
function harvest(x: unknown, parentKey = "", depth = 0) {
  if (depth > 6 || x === null || typeof x !== "object") return;
  if (Array.isArray(x)) return x.slice(0, 30).forEach((v) => harvest(v, parentKey, depth + 1));
  for (const [k, v] of Object.entries(x as Record<string, unknown>)) {
    if (/^(id|key|token|seq|code)$|Id$|_id$|Key$/.test(k)) remember(`${parentKey}.${k}`, v), remember(k, v);
    if (typeof v === "object") harvest(v, k, depth + 1);
  }
}
// имена сравниваются без регистра, подчёркиваний и точек: campaign_id = campaignId
const normKey = (s: string) => s.toLowerCase().replace(/[_.]/g, "");
const pick = (...keys: string[]): string | undefined => {
  for (const k of keys) for (const [name, vals] of pool) if (normKey(name) === normKey(k) || normKey(name).endsWith(normKey(k))) { const arr = [...vals]; if (arr.length) return arr[arr.length - 1]; }
  return undefined;
};
/** Любое собранное значение с префиксом (proc_, obj_, req_, job_…). */
const pickPrefix = (prefix: string): string | undefined => {
  for (const vals of pool.values()) for (const v of [...vals].reverse()) if (v.startsWith(prefix)) return v;
  return undefined;
};

let demoId = "";
let textId = "";
let otherId = "";
const findings: string[] = [];
const missing = new Map<string, number>();
const notFound = new Map<string, number>();

beforeAll(async () => {
  app = await startApp();
  const mk = async (name: string) => (await app.call("POST", "/sessions/blank", { meta: { processName: name } })).body;
  const s = await mk("Демо");
  const put = await app.call("PUT", `/sessions/${s.id}/model`, REFERENCE_PROCESSES.demo.build(), { "X-Base-Updated-At": s.updatedAt });
  expect(put.status).toBe(200);
  await app.call("POST", `/sessions/${s.id}/rebuild-diagrams`);
  demoId = s.id;
  harvest(put.body);
  otherId = (await mk("Вторая")).id;
  // начальные объекты, без которых вложенные маршруты отвечают 404
  for (const [m, u, b] of [
    ["POST", "/repository", { class: "role", name: "Роль из репозитория" }],
    ["POST", "/requirements", { code: "R-1", title: "Требование" }],
    ["POST", "/registry", { name: "Процесс реестра", session_id: s.id }],
    ["PUT", "/glossary/роль", { kind: "role", value: "Роль" }],
    ["POST", `/sessions/${s.id}/tasks`, { text: "Проверь названия", agent: "нормоконтролёр" }],
    ["POST", `/sessions/${s.id}/campaigns`, { name: "Кампания", respondents: [{ name: "Иван", roleId: null }] }],
  ] as [string, string, unknown][]) harvest((await app.call(m, u, b)).body);
  const t = (await app.call("POST", "/sessions", { mode: "A", meta: { processName: "Закупка", modelType: "AS-IS", decompositionDepth: 2, notations: ["IDEF0", "BPMN"] } })).body;
  textId = t.id;
  await app.call("POST", `/sessions/${t.id}/ingest-text`, { text: "Менеджер получает заявку. Бухгалтер проверяет счёт в 1С. Если сумма больше 100 тысяч, директор согласует. Юрист подписывает договор." });
  const run = await app.call("POST", `/sessions/${t.id}/run`, {});
  const jobId = run.body?.jobId ?? run.body?.id;
  for (let i = 0; jobId && i < 80; i++) {
    const j = await app.call("GET", `/jobs/${jobId}`);
    if (j.body?.status !== "running") break;
    await new Promise((r) => setTimeout(r, 200));
  }
}, 180_000);
afterAll(() => app?.close());

/** Правдоподобное значение поля по имени и типу из исходника. */
function value(f: Field): unknown {
  const t = f.type;
  const n = f.name;
  if (/meta/i.test(n)) return { processName: "Фаззинг", modelType: "AS-IS", decompositionDepth: 2, notations: ["IDEF0", "BPMN"] };
  if (n === "model") return REFERENCE_PROCESSES.demo.build();
  if (/^(xml)$/.test(n)) return "<bpmn:definitions><bpmn:task id=\"t\" name=\"Шаг\"/></bpmn:definitions>";
  if (n === "csv") return "case_id,activity,timestamp\n1,Шаг,2026-01-01T10:00:00Z\n1,Шаг 2,2026-01-01T11:00:00Z";
  if (/url/i.test(n)) return "https://example.invalid/hook";
  if (/^(sessionId|asIsId|toBeId)$/.test(n)) return otherId;
  if (/(node|element)_?id$/i.test(n)) return pick("nodes.id") ?? "n1";
  if (/role_?id$/i.test(n)) return pick("roles.id") ?? "r1";
  if (n === "name") return "Иван Петров";
  // массив объектов или объект: значения полей по тем же правилам
  const arrOfObj = /^\{([\s\S]*)\}\[\]$/.exec(t.trim());
  if (arrOfObj) return [Object.fromEntries(parseFields(arrOfObj[1]).map((f2) => [f2.name, value(f2)]))];
  const obj = /^\{([\s\S]*)\}$/.exec(t.trim());
  if (obj) return Object.fromEntries(parseFields(obj[1]).map((f2) => [f2.name, value(f2)]));
  if (/Ids$|_ids$/.test(n)) return [];
  if (/Id$|_id$/.test(n)) return pick(n) ?? "x";
  if (/boolean/.test(t)) return true;
  if (/number/.test(t)) return 1;
  if (/\[\]|Array</.test(t)) return [];
  if (/Record</.test(t)) return {};
  if (/"([^"]+)"/.test(t)) return /"([^"]+)"/.exec(t)![1]; // первый вариант строкового перечисления
  return "Тестовое значение";
}

function fill(p: string, sid: string): string | null {
  const map: Record<string, () => string | undefined> = {
    id: () => (/^\/registry\//.test(p) ? pickPrefix("proc_") : /^\/repository\//.test(p) ? pickPrefix("obj_") : /^\/requirements\//.test(p) ? pickPrefix("req_") : /^\/jobs\//.test(p) ? pickPrefix("job_") ?? pick("jobId") : sid),
    sessionId: () => sid,
    campaignId: () => pick("campaignId", "campaigns.id") ?? pick("id"),
    token: () => pick("token"),
    trackId: () => pick("trackId", "tracks.id"),
    respondentId: () => pick("respondentId", "respondents.id"),
    rid: () => (/report/.test(p) ? pickPrefix("rep") : pickPrefix("resp_")) ?? pick("rid"),
    tid: () => pickPrefix("task_") ?? pick("tasks.id", "tid"),
    qid: () => pickPrefix("q_") ?? pickPrefix("aq_") ?? pick("qid"),
    pid: () => pickPrefix("prop") ?? pick("pid"),
    hypId: () => pickPrefix("hyp") ?? pick("hypId"),
    reqId: () => pickPrefix("req_") ?? pick("requirementId"),
    discId: () => pickPrefix("disc") ?? pick("discrepancies.id"),
    paragraphId: () => pick("paragraphs.id", "paragraphId"),
    roleId: () => pick("roles.id"),
    entryId: () => pick("roles.id"),
    roleKey: () => pick("role_key", "roleKey") ?? "роль",
    agentKey: () => "extractor",
    key: () => pick("key") ?? "ключ",
    kind: () => "roles",
    seq: () => "1",
    diagram: () => "decomposition",
    asIsId: () => demoId,
    toBeId: () => otherId,
    activity: () => "Шаг",
    a: () => demoId,
    b: () => otherId,
  };
  let ok = true;
  const out = p.replace(/:(\w+)/g, (_, name: string) => {
    const v = map[name]?.();
    if (!v) (ok = false, missing.set(name, (missing.get(name) ?? 0) + 1));
    return encodeURIComponent(v ?? "x");
  });
  return ok ? out : null;
}

async function hit(method: string, url: string, body: unknown, label: string) {
  try {
    const res = await Promise.race([app.call(method, url, body), new Promise<never>((_, rej) => setTimeout(() => rej(new Error("ЗАВИС > 15 с")), 15_000))]);
    if (res.status < 300) harvest(res.body);
    // 501 — PDF без Chromium, 502 — вебхук на несуществующий адрес: так задумано
    if (res.status >= 500 && res.status !== 501 && res.status !== 502) findings.push(`${method} ${url} [${label}] → ${res.status}: ${String(typeof res.body === "object" ? res.body?.error : res.body).slice(0, 160)}`);
    return res;
  } catch (e) {
    findings.push(`${method} ${url} [${label}] → ${(e as Error).message}`);
    return null;
  }
}

describe("фаззинг API по типам из исходников и с настоящими id", () => {
  it("три прохода: правдоподобные тела, затем перепутанные типы и null по настоящим id", async () => {
    const specs = routeSpecs();
    expect(specs.length).toBeGreaterThan(150);
    const skip = [/\/auth\//, /\/backup/, /\/restore/, /\/run$/, /\/diagram-import\/new/];
    const ordered = [...specs.filter((r) => r.method !== "DELETE"), ...specs.filter((r) => r.method === "DELETE")];
    let calls = 0;
    let reached = 0;
    for (let pass = 0; pass < 3; pass++) {
      for (const r of ordered) {
        if (skip.some((re) => re.test(r.path))) continue;
        if (pass < 2 && r.method === "DELETE") continue; // удаляем только в последнем проходе
        for (const sid of [demoId, textId]) {
          const url = fill(r.path.replace(/^\/api/, ""), sid);
          if (!url) continue;
          const good = r.fields.length ? Object.fromEntries(r.fields.map((f) => [f.name, value(f)])) : r.method === "GET" || r.method === "DELETE" ? undefined : {};
          calls++;
          const res = await hit(r.method, url, good, `правдоподобно, проход ${pass + 1}`);
          if (res && res.status !== 404) reached++;
          else if (res) notFound.set(`${r.method} ${r.path}`, (notFound.get(`${r.method} ${r.path}`) ?? 0) + 1);
          if (pass === 2 && r.fields.length && r.method !== "GET") {
            // по настоящим id: каждое поле по очереди — неверного типа и null
            for (const f of r.fields) {
              for (const bad of [{ v: { x: [1] }, l: "объект" }, { v: null, l: "null" }, { v: 12345, l: "число" }, { v: "", l: "пустая строка" }]) {
                calls++;
                await hit(r.method, url, { ...good, [f.name]: bad.v }, `${f.name} = ${bad.l}`);
              }
            }
          }
        }
      }
    }
    expect((await app.call("GET", "/health")).status).toBe(200);
    const uniq = new Map<string, string>();
    for (const f of findings) {
      const key = f.replace(/\[[^\]]*\]/, "").replace(/→.*$/, "").replace(/sess_[\w-]+/g, ":id");
      if (!uniq.has(key)) uniq.set(key, f);
    }
    console.log(`вызовов: ${calls}, дошло до логики (не 404): ${reached}, находок: ${findings.length}, уникальных: ${uniq.size}`);
    console.log([...uniq.values()].join("\n"));
    console.log("не хватило id для параметров:", JSON.stringify([...missing]));
    console.log("ответили 404 (до логики не дошли):\n" + [...notFound.keys()].join("\n"));
    console.log("ключи пула:", [...pool.keys()].filter((k) => !k.includes(".")).join(", "));
    expect(findings).toEqual([]);
  }, 1_500_000);
});
