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
/** props — Ctrl+E в окне Visio: открыть свойства выбранного объекта. */
export type ShellMessage = { t: "visio-select"; kind: "node" | "flow"; id: string } | { t: "session"; session: unknown } | { t: "props" } | { t: "menu-pick"; id: string; item: string } | { t: "menu-closed"; id: string } | { t: "shape-menu"; kind: string | null; id: string | null };

/** Подписка на сообщения оболочки; возвращает отписку. Вне настольного приложения ничего не делает. */
export function onShellMessage(handler: (m: ShellMessage) => void): () => void {
  const sh = shell();
  if (!sh?.addEventListener) return () => undefined;
  const listener = (e: { data: unknown }) => {
    const d = e.data as { t?: string } | null;
    if (d && (d.t === "visio-select" || d.t === "session" || d.t === "props" || d.t === "menu-pick" || d.t === "menu-closed" || d.t === "shape-menu")) handler(d as ShellMessage);
  };
  sh.addEventListener("message", listener);
  return () => sh.removeEventListener?.("message", listener);
}

/** Пункт меню оболочки: id возвращается при выборе; group — заголовок группы (в меню Windows — разделитель). */
export type ShellMenuItem = { id: string; label: string; kbd?: string; checked?: boolean; disabled?: boolean } | { group: string } | { label: string; items: ShellMenuItem[]; disabled?: boolean };

/** Оболочка умеет показывать меню Windows (поверх окна Visio, куда HTML-меню не достаёт). */
export const shellHasMenus = (): boolean => !!shell()?.addEventListener;

/** Последняя позиция указателя — для меню «по курсору» в браузере. */
let lastPointer = { x: 12, y: 12 };
if (typeof document !== "undefined") {
  document.addEventListener("pointerdown", (e) => (lastPointer = { x: (e as PointerEvent).clientX, y: (e as PointerEvent).clientY }), true);
}

/**
 * HTML-фолбэк меню для браузера: оболочки нет — рисуем своё меню с теми же пунктами (группы, вложенные списки,
 * отметки и горячие клавиши). Нужен там, где раньше меню пропадало: контекстное меню фигур, палитра
 * существующих объектов, меню листа и масштаба.
 */
function showHtmlMenu(anchor: Element | "cursor", items: ShellMenuItem[]): Promise<string | null> {
  return new Promise((resolve) => {
    const menu = document.createElement("div");
    menu.className = "shell-menu-fallback";
    menu.setAttribute("role", "menu");
    const r = anchor === "cursor" ? null : anchor.getBoundingClientRect();
    const x = r ? r.left : lastPointer.x;
    const y = r ? r.bottom + 2 : lastPointer.y;
    menu.style.cssText = [
      "position:fixed",
      "z-index:10000",
      "min-width:220px",
      "max-height:80vh",
      "overflow:auto",
      "background:#fff",
      "border:1px solid #cbd5e1",
      "border-radius:6px",
      "box-shadow:0 8px 24px rgba(15,23,42,.18)",
      "padding:4px",
      "font:13px/1.35 system-ui,-apple-system,Segoe UI,sans-serif",
      "color:#0f172a",
      `left:${Math.max(4, Math.min(x, window.innerWidth - 244))}px`,
      `top:${Math.max(4, Math.min(y, window.innerHeight - 80))}px`,
    ].join(";");

    let done = false;
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", close);
      menu.remove();
      resolve(v);
    };
    const close = () => finish(null);
    const outside = (e: Event) => {
      if (!menu.contains(e.target as Node)) finish(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish(null);
    };
    const row = (text: string): HTMLButtonElement => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = text;
      b.style.cssText =
        "display:block;width:100%;text-align:left;padding:6px 10px;border:0;border-radius:4px;background:transparent;color:inherit;font:inherit;cursor:pointer";
      b.onmouseenter = () => (b.style.background = "#f1f5f9");
      b.onmouseleave = () => (b.style.background = "transparent");
      return b;
    };
    const render = (list: ShellMenuItem[], host: HTMLElement) => {
      for (const it of list) {
        if ("group" in it) {
          const g = document.createElement("div");
          g.textContent = it.group ?? "";
          g.style.cssText = "padding:6px 10px 2px;font-size:11px;color:#64748b;text-transform:uppercase";
          host.append(g);
          continue;
        }
        if ("items" in it) {
          const b = row(`${it.label} ▸`);
          b.disabled = !!it.disabled;
          const sub = document.createElement("div");
          sub.hidden = true;
          sub.style.cssText = "padding-left:12px";
          b.onclick = (e) => {
            e.stopPropagation();
            sub.hidden = !sub.hidden;
          };
          host.append(b, sub);
          render(it.items, sub);
          continue;
        }
        const b = row(`${it.checked ? "✓ " : ""}${it.label}${it.kbd ? `   ${it.kbd}` : ""}`);
        b.disabled = !!it.disabled;
        if (it.disabled) b.style.opacity = "0.5";
        b.onclick = () => finish(it.id);
        host.append(b);
      }
    };
    render(items, menu);
    document.body.append(menu);
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", close);
  });
}


let menuSeq = 0;
/**
 * Показать меню Windows под элементом anchor: обещание отдаёт id выбранного пункта или null, если меню закрыли без выбора.
 * Нужно в настольном приложении: выпадающее HTML-меню над холстом закрыто окном Visio.
 */
export function showShellMenu(anchor: Element | "cursor", items: ShellMenuItem[], opts: { mini?: boolean } = {}): Promise<string | null> {
  // Браузер: оболочки нет — рисуем HTML-меню сами (иначе меню молча не появлялось: контекст фигур,
  // палитра существующих объектов, меню листа и масштаба).
  if (!shellHasMenus()) return showHtmlMenu(anchor, items);
  const id = `m${++menuSeq}`;
  const r = anchor === "cursor" ? null : anchor.getBoundingClientRect();
  return new Promise((resolve) => {
    const off = onShellMessage((m) => {
      if ((m.t === "menu-pick" || m.t === "menu-closed") && m.id === id) {
        off();
        resolve(m.t === "menu-pick" ? m.item : null);
      }
    });
    postToShell({ t: "menu", id, rect: r ? { x: r.left, y: r.top, w: r.width, h: r.height } : { cursor: true }, items, ...(opts.mini ? { mini: true } : {}) });
  });
}
