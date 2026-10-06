import fs from "node:fs";
import path from "node:path";
import { db, dataDir } from "../db.js";

/**
 * Резервные копии базы: раз в BACKUP_INTERVAL_HOURS (по умолчанию 24, 0 — выключено) в data/backups
 * пишется копия SQLite (онлайн-бэкап, без остановки сервера); хранятся последние BACKUP_KEEP (по умолчанию 7).
 * При запуске копия делается, только если последняя старше интервала — частые перезапуски не вытесняют старые копии.
 */
const dir = path.join(dataDir, "backups");
const HOURS = Number.isFinite(Number(process.env.BACKUP_INTERVAL_HOURS)) && process.env.BACKUP_INTERVAL_HOURS !== undefined ? Number(process.env.BACKUP_INTERVAL_HOURS) : 24;
const KEEP = Math.max(1, Number(process.env.BACKUP_KEEP) || 7);

const list = () =>
  fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((f) => /^app-\d{8}-\d{6}\.sqlite$/.test(f))
        .sort()
    : [];

export async function backupNow(): Promise<string> {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const file = path.join(dir, `app-${stamp}.sqlite`);
  await db.backup(file);
  for (const old of list().slice(0, -KEEP)) fs.rmSync(path.join(dir, old), { force: true });
  return file;
}

export function scheduleBackups(): void {
  if (HOURS <= 0) return;
  const intervalMs = HOURS * 3600_000;
  const last = list().at(-1);
  const lastTime = last ? fs.statSync(path.join(dir, last)).mtimeMs : 0;
  const run = () => backupNow().then((f) => console.log(`резервная копия базы: ${f}`)).catch((e) => console.error("резервная копия не создана", e));
  setTimeout(() => {
    run();
    setInterval(run, intervalMs).unref();
  }, Math.max(5_000, lastTime + intervalMs - Date.now())).unref();
}
