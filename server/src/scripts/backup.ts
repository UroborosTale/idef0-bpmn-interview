import { backupNow, backupRepo, verifyBackup } from "../util/backup.js";

/**
 * Резервная копия вручную: `npm run backup -w server` — база; `-- --repo` — ещё и git-репозиторий одним файлом (bundle).
 * Если задана BACKUP_COPY_DIR, копии ложатся и туда (для репозитория — только туда). Каждая копия проверяется.
 */
const withRepo = process.argv.includes("--repo");
try {
  const file = await backupNow();
  console.log(`✓ база: ${file}\n    ${verifyBackup(file).detail}`);
  if (process.env.BACKUP_COPY_DIR) console.log(`✓ копия вне диска данных: ${process.env.BACKUP_COPY_DIR}`);
  else console.log("  Копия лежит на том же диске, что и база: задайте BACKUP_COPY_DIR (сетевая папка, облачный каталог), чтобы пережить потерю диска.");
  if (withRepo) console.log(`✓ репозиторий: ${backupRepo()}\n    восстановление: git clone <файл> <папка>`);
  else console.log("  Репозиторий (код приложения) не сохранён: добавьте --repo.");
  process.exit(0);
} catch (e) {
  console.error(`✗ ${(e as Error).message}`);
  process.exit(1);
}