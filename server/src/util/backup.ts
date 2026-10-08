import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { repoRoot } from "../agent/prompts.js";
import { db, dataDir } from "../db.js";
import { verifyBackup } from "./backupFiles.js";

export { verifyBackup, restoreBackup } from "./backupFiles.js";

/**
 * Резервные копии: раз в BACKUP_INTERVAL_HOURS (по умолчанию 24, 0 — выключено) в data/backups пишется копия SQLite
 * (онлайн-бэкап, без остановки сервера); хранятся последние BACKUP_KEEP (по умолчанию 7). При запуске копия делается, только
 * если последняя старше интервала — частые перезапуски не вытесняют старые копии.
 *
 * Копия на том же диске не спасает от потери диска, поэтому BACKUP_COPY_DIR (например, сетевая папка или облачный каталог)
 * получает такие же копии; сбой этой папки не отменяет локальную копию. Каждая копия проверяется (integrity_check) сразу после
 * записи. Код приложения хранится в git без удалённого репозитория — для него `npm run backup -w server -- --repo` пишет
 * git bundle (весь репозиторий одним файлом), который восстанавливается командой `git clone <файл>`.
 */
const dir = path.join(dataDir, "backups");
const HOURS = Number.isFinite(Number(process.env.BACKUP_INTERVAL_HOURS)) && process.env.BACKUP_INTERVAL_HOURS !== undefined ? Number(process.env.BACKUP_INTERVAL_HOURS) : 24;
const KEEP = Math.max(1, Number(process.env.BACKUP_KEEP) || 7);

/** Папка для копий вне диска с данными (задаётся при каждом обращении — тесты и скрипты могут менять окружение). */
const copyDir = () => (process.env.BACKUP_COPY_DIR ? path.resolve(process.env.BACKUP_COPY_DIR) : null);

const DB_RE = /^app-\d{8}-\d{6}\.sqlite$/;
const REPO_RE = /^repo-\d{8}-\d{6}\.bundle$/;

const list = (where: string, re: RegExp) => (fs.existsSync(where) ? fs.readdirSync(where).filter((f) => re.test(f)).sort() : []);
const stampNow = () => new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
const prune = (where: string, re: RegExp) => {
  for (const old of list(where, re).slice(0, -KEEP)) fs.rmSync(path.join(where, old), { force: true });
};

export async function backupNow(): Promise<string> {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `app-${stampNow()}.sqlite`);
  await db.backup(file);
  const check = verifyBackup(file);
  if (!check.ok) {
    fs.rmSync(file, { force: true });
    throw new Error(`копия базы не прошла проверку: ${check.detail}`);
  }
  prune(dir, DB_RE);
  const outside = copyDir();
  if (outside) {
    try {
      fs.mkdirSync(outside, { recursive: true });
      fs.copyFileSync(file, path.join(outside, path.basename(file)));
      prune(outside, DB_RE);
    } catch (e) {
      console.error(`копия вне диска данных не создана (${outside}):`, (e as Error).message);
    }
  }
  return file;
}

/** Весь git-репозиторий одним файлом (все ветки и история). Кладётся в BACKUP_COPY_DIR, а без неё — в data/backups. */
export function backupRepo(): string {
  const target = copyDir() ?? dir;
  fs.mkdirSync(target, { recursive: true });
  const file = path.join(target, `repo-${stampNow()}.bundle`);
  execFileSync("git", ["-C", repoRoot, "bundle", "create", file, "--all"], { stdio: "pipe" });
  execFileSync("git", ["bundle", "verify", file], { cwd: repoRoot, stdio: "pipe" });
  prune(target, REPO_RE);
  return file;
}

export function scheduleBackups(): void {
  if (HOURS <= 0) return;
  const intervalMs = HOURS * 3600_000;
  const last = list(dir, DB_RE).at(-1);
  const lastTime = last ? fs.statSync(path.join(dir, last)).mtimeMs : 0;
  const run = () => backupNow().then((f) => console.log(`резервная копия базы: ${f}`)).catch((e) => console.error("резервная копия не создана", e));
  setTimeout(() => {
    run();
    setInterval(run, intervalMs).unref();
  }, Math.max(5_000, lastTime + intervalMs - Date.now())).unref();
}