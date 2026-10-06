import { AsyncLocalStorage } from "node:async_hooks";

/** Контекст текущего HTTP-запроса (кто его выполняет) — доступен в любом месте обработки, например в журнале аудита. */
const store = new AsyncLocalStorage<{ login: string }>();

export const runWithUser = <T>(login: string, fn: () => T): T => store.run({ login }, fn);
export const currentLogin = (): string | undefined => store.getStore()?.login;
