import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTH_REQUIRED_EVENT, req, waitJob } from "./http";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("транспорт API", () => {
  it("JSON-запрос: метод, заголовки, тело", async () => {
    const fetch = vi.fn().mockResolvedValue(json(200, { ok: 1 }));
    vi.stubGlobal("fetch", fetch);
    expect(await req("PUT", "/sessions/1/model", { a: 1 }, { "X-Base-Updated-At": "t" })).toEqual({ ok: 1 });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("/api/sessions/1/model");
    expect(init).toMatchObject({ method: "PUT", body: '{"a":1}', headers: { "Content-Type": "application/json", "X-Base-Updated-At": "t" } });
  });

  it("ошибка сервера: сообщение из тела ответа, иначе статус", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(409, { error: "модель изменилась" })));
    await expect(req("PUT", "/x", {})).rejects.toThrow("модель изменилась");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("oops", { status: 500, statusText: "Server Error" })));
    await expect(req("GET", "/x")).rejects.toThrow("Server Error");
  });

  it("401 вне /auth/ сообщает приложению о необходимости входа", async () => {
    const seen = vi.fn();
    window.addEventListener(AUTH_REQUIRED_EVENT, seen);
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(json(401, { error: "auth" }))));
    await expect(req("GET", "/sessions")).rejects.toThrow();
    await expect(req("POST", "/auth/login", {})).rejects.toThrow();
    expect(seen).toHaveBeenCalledTimes(1);
    window.removeEventListener(AUTH_REQUIRED_EVENT, seen);
  });

  it("текстовый ответ возвращается строкой", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<xml/>", { status: 200, headers: { "content-type": "application/xml" } })));
    expect(await req("GET", "/x")).toBe("<xml/>");
  });

  it("ожидание фоновой задачи: опрос до завершения, затем сессия; ошибка задачи — исключение", async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json(200, { id: "j", status: "running", progress: { done: 2, total: 3 } }))
      .mockResolvedValueOnce(json(200, { id: "j", status: "done" }))
      .mockResolvedValueOnce(json(200, { id: "s1", status: "ready" }));
    vi.stubGlobal("fetch", fetch);
    const progress = vi.fn();
    const p = waitJob({ id: "j", status: "running", progress: { done: 1, total: 3 } } as never, "s1", progress);
    await vi.runAllTimersAsync();
    expect(await p).toEqual({ id: "s1", status: "ready" });
    expect(progress).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.map((c) => c[0])).toEqual(["/api/jobs/j", "/api/jobs/j", "/api/sessions/s1"]);

    vi.stubGlobal("fetch", vi.fn());
    await expect(waitJob({ id: "j", status: "failed", error: "LLM недоступна" } as never, "s1")).rejects.toThrow("LLM недоступна");
  });
});
