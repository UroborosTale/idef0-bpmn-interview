import type { Browser } from "playwright";

/**
 * Браузер для PDF (альбом, лист IDEF0). Порядок: заданный PLAYWRIGHT_CHROMIUM_PATH или /opt/pw-browsers/chromium (образ Docker),
 * Chromium из Playwright, затем установленные в системе Edge и Chrome (на рабочем месте Windows Chromium Playwright обычно нет).
 */
export async function launchPdfBrowser(): Promise<Browser> {
  const { chromium } = await import("playwright");
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || "/opt/pw-browsers/chromium";
  const attempts: (() => Promise<Browser>)[] = [
    () => chromium.launch({ executablePath, args: ["--no-sandbox"] }),
    () => chromium.launch(),
    () => chromium.launch({ channel: "msedge" }),
    () => chromium.launch({ channel: "chrome" }),
  ];
  let last: unknown;
  for (const attempt of attempts) {
    try {
      return await attempt();
    } catch (e) {
      last = e;
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}
