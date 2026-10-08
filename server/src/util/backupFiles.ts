import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Работа с файлами копий без открытия рабочей базы: восстановление запускают при остановленном сервере, и сам скрипт не
 * должен создавать рядом с базой файлы журнала (-wal, -shm), которые потом пришлось бы удалять из-под открытого соединения.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
export const dataPath = (): string => (process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.resolve(here, "../../data"));
const stampNow = () => new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);

/** Проверка копии: файл открывается как база и проходит integrity_check. */
export function verifyBackup(file: string): { ok: boolean; detail: string } {
  try {
    const copy = new Database(file, { readonly: true, fileMustExist: true });
    try {
      const rows = copy.pragma("integrity_check") as { integrity_check: string }[];
      const detail = rows.map((r) => r.integrity_check).join("; ");
      const sessions = (copy.prepare(`SELECT COUNT(*) AS n FROM sessions`).get() as { n: number }).n;
      return { ok: detail === "ok", detail: detail === "ok" ? `целостность в порядке, сессий: ${sessions}` : detail };
    } finally {
      copy.close();
    }
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}
/**
 * Возврат базы из копии. Сервер на это время должен быть остановлен: файл подменяется под ним. Текущая база сначала
 * сохраняется рядом (app-before-restore-<время>.sqlite), так что восстановление само ничего не теряет.
 */
export function restoreBackup(file: string): { restored: string; previous: string } {
  const check = verifyBackup(file);
  if (!check.ok) throw new Error(`копия не годится для восстановления: ${check.detail}`);
  const dataDir = dataPath();
  const dir = path.join(dataDir, "backups");
  const live = path.join(dataDir, "app.sqlite");
  const previous = path.join(dir, `app-before-restore-${stampNow()}.sqlite`);
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(live)) fs.copyFileSync(live, previous);
  for (const ext of ["-wal", "-shm"]) fs.rmSync(`${live}${ext}`, { force: true });
  fs.copyFileSync(file, live);
  return { restored: live, previous };
}