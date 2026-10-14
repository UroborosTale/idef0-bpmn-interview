/**
 * Связь с настольной оболочкой (desktop/ProcessStudio): в её окне студия работает внутри WebView2, а на месте холста
 * диаграммы показывается Visio. В обычном браузере оболочки нет, и всё работает как прежде.
 */
type Shell = { postMessage(message: unknown): void; addEventListener?(type: "message", handler: (e: { data: unknown }) => void): void; removeEventListener?(type: "message", handler: (e: { data: unknown }) => void): void };

const shell = (): Shell | null => (typeof window === "undefined" ? null : (window as unknown as { chrome?: { webview?: Shell } }).chrome?.webview ?? null);

export const inDesktopShell = (): boolean => shell() !== null;

export const postToShell = (message: object): void => shell()?.postMessage(message);

/** Что показывает Visio на месте холста: диаграмму BPMN операции (scope) или IDEF0 функции (parent). */
export type VisioDiagram = { kind: "bpmn"; scope: string | null } | { kind: "idef0"; parent: string | null };

/** Состояние вкладок студии сохраняется на время работы окна: после «Принять из Visio» студия перезагружается. */
export function rememberTabs<T>(sessionId: string, value: T): void {
  try {
    sessionStorage.setItem(`studio-tabs:${sessionId}`, JSON.stringify(value));
  } catch {
    /* хранилище недоступно — вкладки просто не запомнятся */
  }
}

export function recalledTabs<T>(sessionId: string): T | null {
  try {
    const raw = sessionStorage.getItem(`studio-tabs:${sessionId}`);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

/** Сообщение от оболочки: выделение в Visio (visio-select) или обновлённая сессия после приёма правок (session). */
export type ShellMessage = { t: "visio-select"; kind: "node" | "flow"; id: string } | { t: "session"; session: unknown };

/** Подписка на сообщения оболочки; возвращает отписку. Вне настольного приложения ничего не делает. */
export function onShellMessage(handler: (m: ShellMessage) => void): () => void {
  const sh = shell();
  if (!sh?.addEventListener) return () => undefined;
  const listener = (e: { data: unknown }) => {
    const d = e.data as { t?: string } | null;
    if (d && (d.t === "visio-select" || d.t === "session")) handler(d as ShellMessage);
  };
  sh.addEventListener("message", listener);
  return () => sh.removeEventListener?.("message", listener);
}
