import path from "node:path";
import { restoreBackup } from "../util/backupFiles.js";

/**
 * Возврат базы из копии: `npm run restore -w server -- <файл копии> --yes`. Остановите сервер перед запуском: файл базы
 * подменяется. Текущая база сохраняется рядом (app-before-restore-…), так что восстановление можно отменить.
 */
const file = process.argv.slice(2).find((a) => !a.startsWith("--"));
if (!file) {
  console.error("Укажите файл копии: npm run restore -w server -- data/backups/app-20261008-120000.sqlite --yes");
  process.exit(1);
}
if (!process.argv.includes("--yes")) {
  console.error(`Будет заменена текущая база копией ${path.resolve(file)}. Остановите сервер и повторите с --yes.`);
  process.exit(1);
}
try {
  const r = restoreBackup(path.resolve(file));
  console.log(`✓ база восстановлена: ${r.restored}\n  прежняя база сохранена: ${r.previous}`);
  process.exit(0);
} catch (e) {
  console.error(`✗ ${(e as Error).message}`);
  process.exit(1);
}