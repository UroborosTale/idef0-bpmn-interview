import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";

// Загрузка .env (из server/ или из корня репозитория). Импортируется первым в index.ts,
// чтобы переменные были доступны модулям, читающим process.env при инициализации.
// Читаем вручную, а не через process.loadEnvFile: файл, сохранённый в Windows с BOM,
// иначе теряет первую переменную. Уже заданные в окружении переменные не перезаписываются.
for (const file of [path.resolve(process.cwd(), ".env"), path.resolve(process.cwd(), "..", ".env")]) {
  if (fs.existsSync(file)) {
    const parsed = parseEnv(fs.readFileSync(file, "utf-8").replace(/^﻿/, ""));
    for (const [key, value] of Object.entries(parsed)) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
    break;
  }
}
