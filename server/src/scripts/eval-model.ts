import fs from "node:fs";
import { compareModels, formatEval } from "../eval/compare.js";
import { b002Model } from "../reference/b002.js";
import { ProcessLogicModel } from "../types/model.js";
import { httpApi } from "../mcp/server.js";

/**
 * Сравнение модели с эталоном B002: `npm run eval:b002 -w server -- <id сессии | файл.json>`.
 * Сессия читается через API агента (PM_API_URL, PM_AGENT_TOKEN), файл — это JSON модели (например, выгрузка «Модель (JSON)»).
 * Так измеряется качество агентов и сравниваются модели LLM на одном и том же эталоне.
 */
const arg = process.argv[2];
if (!arg) {
  console.error("Укажите id сессии или файл модели: npm run eval:b002 -w server -- <id | model.json>");
  process.exit(1);
}

let raw: unknown;
if (fs.existsSync(arg)) {
  raw = JSON.parse(fs.readFileSync(arg, "utf-8"));
} else {
  const api = httpApi(process.env.PM_API_URL ?? "http://127.0.0.1:8787", process.env.PM_AGENT_TOKEN ?? "");
  const r = await api.get(`/agent/sessions/${encodeURIComponent(arg)}/model`);
  if (r.status !== 200) {
    console.error(`Не удалось прочитать модель сессии «${arg}»: ${r.status} ${typeof r.body === "string" ? r.body : r.body?.error ?? ""}`);
    process.exit(1);
  }
  raw = r.body.model;
}
const parsed = ProcessLogicModel.safeParse(raw);
if (!parsed.success) {
  console.error("Файл не похож на модель процесса:", parsed.error.issues[0]?.message);
  process.exit(1);
}
console.log(formatEval(compareModels(b002Model(), parsed.data)));
