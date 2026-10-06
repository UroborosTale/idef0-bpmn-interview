import { useCallback, useEffect, useState } from "react";

/**
 * Адреса страниц приложения (History API, без внешних зависимостей): перезагрузка страницы
 * сохраняет место, ссылкой на сессию и вкладку можно поделиться. Сервер (nginx, Vite) на любой
 * путь отдаёт index.html.
 */
export type Route =
  | { name: "list" }
  | { name: "new" }
  | { name: "workspace"; id: string; tab?: string }
  | { name: "registry" }
  | { name: "glossary" }
  | { name: "notifications" }
  | { name: "requirements" }
  | { name: "checklistRules" }
  | { name: "auditLog" }
  | { name: "technology" }
  | { name: "campaign"; campaignId: string; token: string };

const STATIC: Record<string, Route["name"]> = {
  "/new": "new",
  "/registry": "registry",
  "/glossary": "glossary",
  "/notifications": "notifications",
  "/requirements": "requirements",
  "/checklist-rules": "checklistRules",
  "/audit": "auditLog",
  "/technology": "technology",
};

export function parseRoute(path: string, search = ""): Route {
  const p = path.replace(/\/+$/, "") || "/";
  const campaign = p.match(/^\/campaign\/([^/]+)\/([^/]+)$/);
  if (campaign) return { name: "campaign", campaignId: decodeURIComponent(campaign[1]), token: decodeURIComponent(campaign[2]) };
  const ws = p.match(/^\/s\/([^/]+)$/);
  if (ws) return { name: "workspace", id: decodeURIComponent(ws[1]), tab: new URLSearchParams(search).get("tab") ?? undefined };
  const name = STATIC[p];
  return name ? ({ name } as Route) : { name: "list" };
}

export function routePath(r: Route): string {
  switch (r.name) {
    case "list":
      return "/";
    case "workspace":
      return `/s/${encodeURIComponent(r.id)}${r.tab ? `?tab=${encodeURIComponent(r.tab)}` : ""}`;
    case "campaign":
      return `/campaign/${encodeURIComponent(r.campaignId)}/${encodeURIComponent(r.token)}`;
    default:
      return Object.entries(STATIC).find(([, n]) => n === r.name)?.[0] ?? "/";
  }
}

const current = () => parseRoute(window.location.pathname, window.location.search);

/** Текущий адрес и переход: replace — без новой записи в истории (например, смена вкладки). */
export function useRoute(): [Route, (r: Route, opts?: { replace?: boolean }) => void] {
  const [route, setRoute] = useState<Route>(current);
  useEffect(() => {
    const onPop = () => setRoute(current());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const navigate = useCallback((r: Route, opts?: { replace?: boolean }) => {
    const path = routePath(r);
    if (path !== window.location.pathname + window.location.search) {
      if (opts?.replace) window.history.replaceState(null, "", path);
      else window.history.pushState(null, "", path);
    }
    setRoute(r);
  }, []);
  return [route, navigate];
}
