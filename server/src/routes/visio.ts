import express, { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { getSession } from "../repo.js";
import { dataDir } from "../db.js";
import { isLocalRequest } from "../auth.js";
import { buildVsdx } from "../export/vsdx.js";
import { applyVisio, readVsdx } from "../export/vsdx-import.js";

/**
 * Microsoft Visio как среда редактирования: сервер собирает .vsdx, открывает его в установленном Visio
 * (приложение и сервер работают на одной машине), следит за сохранением файла и по запросу читает правки
 * обратно в модель. Состояние сессии лежит рядом с файлом (state.json), поэтому переживает перезапуск сервера.
 */
export const visioRouter = Router();

const root = path.join(dataDir, "visio");

interface State {
  file: string;
  /** updatedAt сессии на момент выгрузки. */
  base: string;
  /** mtime файла, с которым модель считается синхронной (выгрузка или последнее применение). */
  syncedMtime: number;
  /** Из каких фигур файла уже созданы элементы модели («страница|id фигуры» → id элемента): открытый в Visio файл хранит те же фигуры. */
  known?: Record<string, string>;
  /** Созданное последним разбором; переходит в known, когда правки применены. */
  pendingCreated?: Record<string, string>;
}

const dirOf = (id: string) => path.join(root, id.replace(/[^\w-]/g, "_"));

/** Удаляет рабочие файлы Visio сессии (при удалении сессии). */
export const removeVisioFiles = (id: string) => fs.rmSync(dirOf(id), { recursive: true, force: true });
const stateFile = (id: string) => path.join(dirOf(id), "state.json");

function readState(id: string): State | null {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(id), "utf8")) as State;
    return fs.existsSync(s.file) ? s : null;
  } catch {
    return null;
  }
}
const writeState = (id: string, s: State) => fs.writeFileSync(stateFile(id), JSON.stringify(s), "utf8");

let availableCache: boolean | null = null;
/** Visio доступен, если в Windows есть сопоставление .vsdx. */
function visioAvailable(): Promise<boolean> {
  if (process.platform !== "win32") return Promise.resolve(false);
  if (availableCache !== null) return Promise.resolve(availableCache);
  return new Promise((resolve) => {
    execFile("cmd.exe", ["/c", "assoc", ".vsdx"], { windowsHide: true }, (err, stdout) => {
      availableCache = !err && /\.vsdx=/i.test(stdout);
      resolve(availableCache);
    });
  });
}

const safeName = (s: string) => s.replace(/[\\/:*?"<>|]/g, "_").trim() || "process";

function snapshot(id: string) {
  const st = readState(id);
  if (!st) return { exists: false as const };
  const mtime = fs.statSync(st.file).mtimeMs;
  return { exists: true as const, file: st.file, mtime, modified: mtime > st.syncedMtime + 1 };
}

visioRouter.get("/sessions/:id/visio/status", async (req, res) => {
  if (!getSession(req.params.id)) return void res.status(404).json({ error: "not found" });
  res.json({ available: await visioAvailable(), ...snapshot(req.params.id) });
});

/** Выгружает модель в .vsdx и открывает в Visio. Несохранённые в модель правки прежнего файла не затираются. */
visioRouter.post("/sessions/:id/visio/open", async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return void res.status(404).json({ error: "not found" });
  if (!session.model) return void res.status(400).json({ error: "модель ещё не построена — выполните запуск обработки" });
  // открытие файла запускает программу на машине сервера — только для запросов с неё же
  if (!isLocalRequest(req)) return void res.status(403).json({ error: "открыть Visio можно только на машине, где запущен сервер; скачайте .vsdx и загрузите его обратно" });
  const id = req.params.id;
  const fresh = Boolean((req.body as { fresh?: boolean } | undefined)?.fresh);
  try {
    fs.mkdirSync(dirOf(id), { recursive: true });
    let st = readState(id);
    const pending = st && snapshot(id).exists && (snapshot(id) as { modified?: boolean }).modified;
    if (!st || fresh || !pending) {
      const buf = await buildVsdx(session.model, { pm_session: id, pm_base: session.updatedAt });
      const base = safeName(session.meta.processName);
      // файл может быть открыт в Visio (заблокирован) — тогда пишем под новым именем
      let file = path.join(dirOf(id), `${base}.vsdx`);
      for (let i = 2; ; i++) {
        try {
          fs.writeFileSync(file, buf);
          break;
        } catch (e) {
          if (i > 20) throw e;
          file = path.join(dirOf(id), `${base} (${i}).vsdx`);
        }
      }
      st = { file, base: session.updatedAt, syncedMtime: fs.statSync(file).mtimeMs };
      writeState(id, st);
    }
    let launched = false;
    if (await visioAvailable()) {
      // explorer открывает файл программой по умолчанию; windowsHide нельзя — Visio унаследовал бы скрытое окно
      spawn("explorer.exe", [st.file], { detached: true, stdio: "ignore" }).unref();
      launched = true;
    }
    res.json({ file: st.file, launched, resumed: Boolean(pending && !fresh) });
  } catch (e) {
    res.status(500).json({ error: `не удалось подготовить файл для Visio: ${(e as Error).message}` });
  }
});

async function computePull(id: string, buf: Buffer, known: Record<string, string> = {}, base?: string) {
  const session = getSession(id)!;
  const doc = await readVsdx(buf);
  const result = applyVisio(session.model!, doc, id, known);
  const from = base ?? doc.meta.pm_base;
  const stale = Boolean(from) && from !== session.updatedAt;
  return { ...result, stale };
}

/** Читает сохранённый в Visio файл и возвращает модель с правками (без сохранения). */
visioRouter.post("/sessions/:id/visio/pull", async (req, res) => {
  const session = getSession(req.params.id);
  if (!session?.model) return void res.status(404).json({ error: "модель не найдена" });
  const st = readState(req.params.id);
  if (!st) return void res.status(400).json({ error: "файл Visio ещё не выгружался" });
  try {
    const mtime = fs.statSync(st.file).mtimeMs;
    const pulled = await computePull(req.params.id, fs.readFileSync(st.file), st.known, st.base);
    writeState(req.params.id, { ...st, pendingCreated: pulled.created });
    res.json({ model: pulled.model, changes: pulled.changes, warnings: pulled.warnings, stale: pulled.stale, mtime });
  } catch (e) {
    res.status(422).json({ error: `не удалось прочитать файл Visio: ${(e as Error).message}` });
  }
});

/** Правки применены в модель: файл с этого момента считается синхронным. */
visioRouter.post("/sessions/:id/visio/applied", (req, res) => {
  const st = readState(req.params.id);
  if (!st) return void res.status(400).json({ error: "файл Visio ещё не выгружался" });
  const session = getSession(req.params.id);
  const mtime = Number((req.body as { mtime?: number }).mtime);
  const applied = Boolean((req.body as { applied?: boolean }).applied);
  writeState(req.params.id, {
    ...st,
    base: session?.updatedAt ?? st.base,
    syncedMtime: Number.isFinite(mtime) ? mtime : fs.statSync(st.file).mtimeMs,
    known: applied ? { ...st.known, ...st.pendingCreated } : st.known,
    pendingCreated: undefined,
  });
  res.json({ ok: true });
});

/** Загрузка .vsdx вручную (файл правили на другой машине): тот же разбор, что и для файла Visio. */
visioRouter.post("/sessions/:id/visio/import", express.raw({ type: () => true, limit: "50mb" }), async (req, res) => {
  const session = getSession(req.params.id);
  if (!session?.model) return void res.status(404).json({ error: "модель не найдена" });
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) return void res.status(400).json({ error: "пустой файл" });
  try {
    const pulled = await computePull(req.params.id, req.body);
    res.json({ model: pulled.model, changes: pulled.changes, warnings: pulled.warnings, stale: pulled.stale });
  } catch (e) {
    res.status(422).json({ error: `не удалось прочитать файл: ${(e as Error).message}` });
  }
});
