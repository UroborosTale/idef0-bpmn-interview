import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startApp } from "./api.js";

delete process.env.AUTH_USERS;

const pdfMocks = vi.hoisted(() => {
  const page = {
    setContent: vi.fn(async () => undefined),
    pdf: vi.fn(async () => Buffer.from("%PDF-1.4 test")),
  };
  const browser = {
    newPage: vi.fn(async () => page),
    close: vi.fn(async () => undefined),
  };
  return { page, browser };
});

vi.mock("../src/export/pdfBrowser.js", () => ({ launchPdfBrowser: vi.fn(async () => pdfMocks.browser) }));

let app: Awaited<ReturnType<typeof startApp>>;
beforeAll(async () => {
  app = await startApp();
});
afterAll(() => app.close());

/** D3 из отчёта 20.10: пакет к аудиту и сравнение гипотез должны использовать общий запуск PDF с запасным Edge. */
describe("PDF пакета к аудиту", () => {
  it("собирается через общий launchPdfBrowser, а не прямым chromium.launch", async () => {
    const s = await app.call("POST", "/sessions/blank", { meta: { processName: "Проверка PDF" } });
    const r = await app.raw(`/sessions/${s.body.id}/audit-package/export.pdf`);
    expect(r.status).toBe(200);
    expect(r.body.subarray(0, 4).toString()).toBe("%PDF");
    expect(pdfMocks.page.pdf).toHaveBeenCalled();
    expect(pdfMocks.browser.close).toHaveBeenCalled();
  });
});
