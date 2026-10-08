import Database from "better-sqlite3";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { recordUsage, usageForSession, withLlmContext } from "../src/llm/usage.js";
import { isPrivateAddress, safeWebhookFetch, validateWebhookUrl } from "../src/util/webhook.js";
import { backupNow, backupRepo, verifyBackup } from "../src/util/backup.js";

describe("учёт расхода LLM", () => {
  it("токены записываются на сессию из контекста и суммируются, стоимость — по ценам из окружения", async () => {
    await withLlmContext("s1", async () => {
      recordUsage("anthropic", "m1", 1000, 200);
      await Promise.resolve();
      recordUsage("anthropic", "m1", 500, 100);
    });
    await withLlmContext("s2", async () => recordUsage("anthropic", "m1", 9999, 9999));
    process.env.LLM_PRICE_INPUT_PER_M = "3";
    process.env.LLM_PRICE_OUTPUT_PER_M = "15";
    const u = usageForSession("s1");
    expect(u).toMatchObject({ calls: 2, inputTokens: 1500, outputTokens: 300 });
    expect(u.costUsd).toBeCloseTo((1500 * 3 + 300 * 15) / 1e6, 6);
  });
});

describe("вебхуки", () => {
  it("внутренние адреса отклоняются и до, и после разрешения имени", async () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.0.10", "172.20.0.1", "169.254.169.254", "::1", "fd00::1", "::ffff:10.0.0.1"]) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ["8.8.8.8", "2001:4860:4860::8888"]) expect(isPrivateAddress(ip), ip).toBe(false);
    expect(validateWebhookUrl("ftp://example.com").ok).toBe(false);
    await expect(safeWebhookFetch("http://localhost:8787/api", { method: "POST" })).rejects.toThrow(/внутренний/);
    await expect(safeWebhookFetch("http://[::1]/x", { method: "POST" })).rejects.toThrow(/внутренний/);
  });
});

describe("резервные копии", () => {
  it("копия базы создаётся в data/backups и открывается", async () => {
    const file = await backupNow();
    expect(fs.existsSync(file)).toBe(true);
    expect(path.dirname(file)).toBe(path.join(process.env.DATA_DIR!, "backups"));
    expect(fs.statSync(file).size).toBeGreaterThan(0);
  });

  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "pm-backup-"));
  const makeDb = (file: string, sessions: number) => {
    const d = new Database(file);
    d.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY)`);
    for (let i = 0; i < sessions; i++) d.prepare(`INSERT INTO sessions VALUES (?)`).run(`s${i}`);
    d.close();
  };

  it("копия проверяется; битый файл не принимается", () => {
    const dir = tmp();
    makeDb(path.join(dir, "ok.sqlite"), 3);
    expect(verifyBackup(path.join(dir, "ok.sqlite"))).toEqual({ ok: true, detail: "целостность в порядке, сессий: 3" });
    fs.writeFileSync(path.join(dir, "bad.sqlite"), "это не база данных");
    expect(verifyBackup(path.join(dir, "bad.sqlite")).ok).toBe(false);
    expect(verifyBackup(path.join(dir, "нет.sqlite")).ok).toBe(false);
  });

  it("BACKUP_COPY_DIR получает такую же копию и сам чистит старые; недоступная папка не отменяет локальную копию", async () => {
    const outside = tmp();
    for (let i = 1; i <= 8; i++) fs.writeFileSync(path.join(outside, `app-2020010${i}-000000.sqlite`), "старая");
    process.env.BACKUP_COPY_DIR = outside;
    try {
      const file = await backupNow();
      const copies = fs.readdirSync(outside).filter((f) => f.startsWith("app-")).sort();
      expect(copies).toContain(path.basename(file));
      expect(copies).toHaveLength(7); // хранится не больше BACKUP_KEEP
      expect(copies).not.toContain("app-20200101-000000.sqlite");
      expect(fs.statSync(path.join(outside, path.basename(file))).size).toBe(fs.statSync(file).size);
      // вместо папки — файл: создать каталог нельзя
      const blocker = path.join(tmp(), "файл");
      fs.writeFileSync(blocker, "x");
      process.env.BACKUP_COPY_DIR = path.join(blocker, "вложенная");
      const local = await backupNow();
      expect(fs.existsSync(local)).toBe(true);
    } finally {
      delete process.env.BACKUP_COPY_DIR;
    }
  });

  it("репозиторий сохраняется одним файлом bundle, из которого можно клонировать", () => {
    const outside = tmp();
    process.env.BACKUP_COPY_DIR = outside;
    try {
      const file = backupRepo();
      expect(path.dirname(file)).toBe(outside);
      expect(file).toMatch(/repo-\d{8}-\d{6}\.bundle$/);
      const clone = path.join(tmp(), "клон");
      execFileSync("git", ["clone", "--quiet", file, clone], { stdio: "pipe" });
      expect(fs.existsSync(path.join(clone, "package.json"))).toBe(true);
    } finally {
      delete process.env.BACKUP_COPY_DIR;
    }
  }, 60_000);

  it("восстановление после аварийной остановки: записи, оставшиеся только в журнале WAL, попадают в сохранённую прежнюю базу", () => {
    // «живая» база с несброшенным журналом: автоматический сброс выключен, файлы копируются при открытом соединении
    const src = tmp();
    const open = new Database(path.join(src, "app.sqlite"));
    open.pragma("journal_mode = WAL");
    open.pragma("wal_autocheckpoint = 0");
    open.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY)`);
    open.checkpoint?.();
    for (let i = 0; i < 4; i++) open.prepare(`INSERT INTO sessions VALUES (?)`).run(`w${i}`);
    const data = tmp();
    fs.copyFileSync(path.join(src, "app.sqlite"), path.join(data, "app.sqlite"));
    fs.copyFileSync(path.join(src, "app.sqlite-wal"), path.join(data, "app.sqlite-wal"));
    open.close();
    expect(fs.statSync(path.join(data, "app.sqlite-wal")).size).toBeGreaterThan(0);
    const copy = path.join(tmp(), "app-20260101-000000.sqlite");
    makeDb(copy, 7);
    const r = spawnSync(process.execPath, ["--import", "tsx", "src/scripts/restore.ts", copy, "--yes"], { cwd: path.resolve(__dirname, ".."), env: { ...process.env, DATA_DIR: data }, encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    const saved = fs.readdirSync(path.join(data, "backups")).find((f) => /^app-before-restore-.*\.sqlite$/.test(f))!;
    const before = new Database(path.join(data, "backups", saved), { readonly: true });
    expect(before.prepare(`SELECT COUNT(*) AS n FROM sessions`).get()).toEqual({ n: 4 }); // записи из журнала не потеряны
    before.close();
    const live = new Database(path.join(data, "app.sqlite"), { readonly: true });
    expect(live.prepare(`SELECT COUNT(*) AS n FROM sessions`).get()).toEqual({ n: 7 });
    live.close();
  }, 60_000);

  it("восстановление: нужна отметка --yes, битая копия отклоняется, прежняя база сохраняется рядом", () => {
    const data = tmp();
    makeDb(path.join(data, "app.sqlite"), 1);
    const copy = path.join(tmp(), "app-20260101-000000.sqlite");
    makeDb(copy, 5);
    const run = (...args: string[]) =>
      spawnSync(process.execPath, ["--import", "tsx", "src/scripts/restore.ts", ...args], { cwd: path.resolve(__dirname, ".."), env: { ...process.env, DATA_DIR: data }, encoding: "utf8" });
    expect(run(copy).status).toBe(1); // без подтверждения ничего не меняется
    expect(new Database(path.join(data, "app.sqlite"), { readonly: true }).prepare(`SELECT COUNT(*) AS n FROM sessions`).get()).toEqual({ n: 1 });

    const bad = path.join(tmp(), "bad.sqlite");
    fs.writeFileSync(bad, "мусор");
    const refused = run(bad, "--yes");
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("не годится");

    const done = run(copy, "--yes");
    expect(done.status, done.stderr).toBe(0);
    const live = new Database(path.join(data, "app.sqlite"), { readonly: true });
    expect(live.prepare(`SELECT COUNT(*) AS n FROM sessions`).get()).toEqual({ n: 5 });
    live.close();
    const saved = fs.readdirSync(path.join(data, "backups")).filter((f) => f.startsWith("app-before-restore-"));
    expect(saved).toHaveLength(1);
    const before = new Database(path.join(data, "backups", saved[0]), { readonly: true });
    expect(before.prepare(`SELECT COUNT(*) AS n FROM sessions`).get()).toEqual({ n: 1 });
    before.close();
  }, 60_000);
});
