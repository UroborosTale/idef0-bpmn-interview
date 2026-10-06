import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// каждый тестовый файл работает со своей временной базой, рабочие данные приложения не трогаются
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pm-test-"));
// внешние LLM в тестах не вызываются
for (const k of ["ANTHROPIC_API_KEY", "LLM_BASE_URL", "LOCAL_LLM_BASE_URL"]) delete process.env[k];
