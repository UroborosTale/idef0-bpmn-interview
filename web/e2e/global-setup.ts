import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";
import { API, API_PORT, USER, WEB_PORT, login } from "./env";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const serverDir = path.resolve(webDir, "../server");

let server: ChildProcess | undefined;
let vite: ViteDevServer | undefined;
let dataDir = "";

async function waitHealthy(url: string, ms: number) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* ещё не слушает */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`сервер не ответил: ${url}`);
}

/**
 * API-сервер: временная база, вход включён, ключи LLM пустые — работает офлайн-экстрактор
 * (пустые значения не перезаписываются из .env). Vite проксирует /api на этот сервер.
 */
export async function setup() {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-e2e-"));
  const tsxCli = path.resolve(webDir, "../node_modules/tsx/dist/cli.mjs");
  server = spawn(process.execPath, [tsxCli, "src/index.ts"], {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(API_PORT),
      HOST: "127.0.0.1",
      DATA_DIR: dataDir,
      AUTH_USERS: `${USER.login}:${USER.password}`,
      ANTHROPIC_API_KEY: "",
      LLM_BASE_URL: "",
      LOCAL_LLM_BASE_URL: "",
      BACKUP_INTERVAL_HOURS: "0",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  server.stderr?.on("data", (d) => (stderr += d));
  try {
    await waitHealthy(`${API}/health`, 60_000);
  } catch (e) {
    throw new Error(`${(e as Error).message}\n${stderr}`);
  }

  process.env.E2E_COOKIE = await login();

  vite = await createServer({
    configFile: path.join(webDir, "vite.config.ts"),
    root: webDir,
    logLevel: "error",
    server: { port: WEB_PORT, strictPort: true, proxy: { "/api": { target: `http://127.0.0.1:${API_PORT}`, changeOrigin: true } } },
  });
  await vite.listen();
}

export async function teardown() {
  await vite?.close();
  server?.kill();
  await new Promise((r) => setTimeout(r, 500)); // база освобождается после остановки процесса
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* Windows может держать файл базы ещё мгновение — временная папка уберётся системой */
  }
}
