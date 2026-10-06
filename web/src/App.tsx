import { useEffect, useState } from "react";
import { api, AUTH_REQUIRED_EVENT } from "./api/client";
import { routePath, useRoute, type Route } from "./router";
import ErrorBoundary from "./components/ErrorBoundary";
import LoginPage from "./pages/LoginPage";
import SessionsListPage from "./pages/SessionsListPage";
import NewSessionPage from "./pages/NewSessionPage";
import WorkspacePage from "./pages/WorkspacePage";
import RegistryPage from "./pages/RegistryPage";
import GlossaryPage from "./pages/GlossaryPage";
import RespondentInterviewPage from "./pages/RespondentInterviewPage";
import NotificationsPage from "./pages/NotificationsPage";
import RequirementsPage from "./pages/RequirementsPage";
import ChecklistRulesPage from "./pages/ChecklistRulesPage";
import AuditLogPage from "./pages/AuditLogPage";
import TechnologyPage from "./pages/TechnologyPage";

/** Разделы, которые нужны реже, — в меню «Ещё». */
const MORE: { route: Route; label: string }[] = [
  { route: { name: "glossary" }, label: "Справочники" },
  { route: { name: "requirements" }, label: "Реестр требований" },
  { route: { name: "checklistRules" }, label: "Чек-лист: правила" },
  { route: { name: "auditLog" }, label: "Журнал аудита" },
  { route: { name: "technology" }, label: "Технологии" },
];

export default function App() {
  const [route, navigate] = useRoute();
  const [provider, setProvider] = useState<{ name: string; live: boolean } | null>(null);
  const [unreadCount, setUnreadCount] = useState(0);
  // undefined — ещё не знаем; null — нужен вход
  const [user, setUser] = useState<{ login: string; authRequired: boolean } | null | undefined>(undefined);
  const isCampaign = route.name === "campaign";

  useEffect(() => {
    if (isCampaign) return;
    api
      .authMe()
      .then((r) => setUser(r.user ? { login: r.user.login, authRequired: r.authRequired } : null))
      .catch(() => setUser(null));
    const onAuth = () => setUser(null);
    window.addEventListener(AUTH_REQUIRED_EVENT, onAuth);
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, onAuth);
  }, [isCampaign]);

  useEffect(() => {
    if (!user) return;
    api.providerStatus().then(setProvider).catch(() => setProvider(null));
  }, [user]);

  useEffect(() => {
    if (!user) return;
    api.listNotifications({ unread: true }).then((rows) => setUnreadCount(rows.length)).catch(() => {});
  }, [route.name, user]);

  useEffect(() => {
    document.title = route.name === "workspace" ? "Сессия — IDEF0 / BPMN" : "IDEF0 / BPMN — модели по интервью";
  }, [route.name]);

  // ФТ-М4.2.2: персональная ссылка респондента — отдельная публичная страница без навигации и входа
  if (route.name === "campaign") return <RespondentInterviewPage campaignId={route.campaignId} token={route.token} />;
  if (user === undefined) return null;
  if (user === null) return <LoginPage onLoggedIn={(login) => setUser({ login, authRequired: true })} />;

  /** Ссылка-кнопка: обычный клик — переход внутри приложения, средний/Ctrl — новая вкладка. */
  const link = (r: Route, label: React.ReactNode, className?: string) => (
    <a
      href={routePath(r)}
      className={`nav-link ${className ?? ""} ${route.name === r.name ? "active" : ""}`}
      onClick={(e) => {
        if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(r);
      }}
    >
      {label}
    </a>
  );

  return (
    <div className="app-shell">
      <div className="topbar">
        {link({ name: "list" }, "IDEF0 / BPMN — модели по интервью", "brand")}
        <div className="topbar-nav">
          {provider && (
            <span className={`provider-badge ${provider.live ? "live" : ""}`} title="LLM-провайдер для извлечения структуры">
              {provider.live ? `LLM: ${provider.name}` : "офлайн-режим (без внешней LLM)"}
            </span>
          )}
          {link({ name: "list" }, "Сессии")}
          {link({ name: "registry" }, "Реестр процессов")}
          {link({ name: "notifications" }, `Уведомления${unreadCount > 0 ? ` (${unreadCount})` : ""}`)}
          <details className="nav-more">
            <summary>Ещё</summary>
            <div className="nav-more-menu" onClick={(e) => (e.currentTarget.parentElement as HTMLDetailsElement).removeAttribute("open")}>
              {MORE.map((m) => (
                <span key={m.route.name}>{link(m.route, m.label)}</span>
              ))}
            </div>
          </details>
          {link({ name: "new" }, "+ Новая сессия", "primary")}
          {user.authRequired && (
            <button title={`Вы вошли как ${user.login}`} onClick={() => api.logout().finally(() => setUser(null))}>
              Выйти ({user.login})
            </button>
          )}
        </div>
      </div>
      <div className="main-area">
        <ErrorBoundary resetKey={routePath(route)}>
          {route.name === "list" && <SessionsListPage onOpen={(id) => navigate({ name: "workspace", id })} onCreateNew={() => navigate({ name: "new" })} />}
          {route.name === "new" && <NewSessionPage onCreated={(id) => navigate({ name: "workspace", id })} />}
          {route.name === "workspace" && (
            <WorkspacePage
              key={route.id}
              sessionId={route.id}
              initialTab={route.tab}
              onTabChange={(tab) => navigate({ name: "workspace", id: route.id, tab }, { replace: true })}
              onBack={() => navigate({ name: "list" })}
            />
          )}
          {route.name === "registry" && <RegistryPage />}
          {route.name === "glossary" && <GlossaryPage />}
          {route.name === "notifications" && <NotificationsPage />}
          {route.name === "requirements" && <RequirementsPage />}
          {route.name === "checklistRules" && <ChecklistRulesPage />}
          {route.name === "auditLog" && <AuditLogPage />}
          {route.name === "technology" && <TechnologyPage />}
        </ErrorBoundary>
      </div>
    </div>
  );
}
