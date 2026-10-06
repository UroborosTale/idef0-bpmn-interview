import type { SessionRecord } from "../types";
import type { Job, JobProgress } from "./types";

/** Транспорт API: запросы, ошибки, ожидание фоновых задач. */
export const BASE = "/api";

export async function waitJob(job: Job, sessionId: string, onProgress?: (p: JobProgress) => void): Promise<SessionRecord> {
  let cur = job;
  while (cur.status === "running") {
    if (cur.progress) onProgress?.(cur.progress);
    await new Promise((r) => setTimeout(r, 1000));
    cur = await req<Job>("GET", `/jobs/${job.id}`);
  }
  if (cur.status === "failed") throw new Error(cur.error ?? "обработка завершилась ошибкой");
  return req<SessionRecord>("GET", `/sessions/${sessionId}`);
}

/** Сервер ответил «требуется вход» — приложение показывает страницу входа (App.tsx). */
export const AUTH_REQUIRED_EVENT = "pm:auth-required";

export async function req<T>(method: string, url: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<T> {
  const res = await fetch(BASE + url, {
    method,
    headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...extraHeaders },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && !url.startsWith("/auth/")) window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
  if (!res.ok) {
    let message = res.statusText;
    try {
      const j = await res.json();
      message = j.error || message;
    } catch {
      // ignore
    }
    throw new Error(message);
  }
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return (await res.json()) as T;
  return (await res.text()) as unknown as T;
}

