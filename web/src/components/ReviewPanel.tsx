import { useEffect, useState } from "react";
import { api, type ReviewRoute, type ImpactReport } from "../api/client";
import type { SessionRecord } from "../types";

const SIGNIFICANCE_LABEL: Record<string, string> = { cosmetic: "Косметическое", structural: "Структурное", affects_others: "Затрагивает других" };
const SIGNIFICANCE_COLOR: Record<string, string> = { cosmetic: "#2C7A57", structural: "#B87317", affects_others: "#AD4130" };
const STATUS_LABEL: Record<string, string> = { draft: "Черновик", review: "На согласовании", needs_rework: "На доработке", approved: "Утверждено", archived: "Архив" };

/** ФТ-М7.2 (маршрут согласования) + ФТ-М7.3 (анализ влияния) + ФТ-М7.4 (уведомления, конфигурация вебхука). */
export default function ReviewPanel({ session, onChanged }: { session: SessionRecord; onChanged: () => void }) {
  const [route, setRoute] = useState<ReviewRoute | null>(null);
  const [preStartImpact, setPreStartImpact] = useState<ImpactReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [rejectComment, setRejectComment] = useState("");
  const [showReject, setShowReject] = useState(false);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [lastResult, setLastResult] = useState<string | null>(null);

  const processStatus = session.model?.process.status ?? "draft";

  async function reload() {
    const r = await api.getReview(session.id);
    setRoute(r);
    if (!r && session.model) {
      try {
        setPreStartImpact(await api.getImpact(session.id));
      } catch {
        setPreStartImpact(null);
      }
    }
    const wh = await api.getNotificationWebhook(session.id);
    setWebhookUrl(wh.webhook_url ?? "");
  }

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id, session.updatedAt]);

  async function withBusy(fn: () => Promise<void>) {
    setBusy(true);
    setLastResult(null);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  }

  if (!session.model) return <p className="muted">Модель ещё не построена.</p>;

  return (
    <div>
      <div className="toolbar">
        <h4 style={{ margin: 0 }}>Согласование</h4>
        <div className="spacer" />
        <span className={`pill status-${processStatus}`}>{STATUS_LABEL[processStatus] ?? processStatus}</span>
      </div>

      {processStatus === "approved" && (
        <div className="validation-item" style={{ marginTop: 10 }}>
          Версия утверждена и заблокирована от изменений.{" "}
          <button
            disabled={busy}
            onClick={() => withBusy(async () => { await api.reopenSession(session.id); onChanged(); await reload(); })}
          >
            Открыть новый цикл правок
          </button>
        </div>
      )}

      {!route && processStatus !== "approved" && (
        <div style={{ marginTop: 10 }}>
          <p className="muted" style={{ fontSize: 12 }}>
            Маршрут по умолчанию: Аналитик → Владелец процесса → Нормоконтролёр. Перед отправкой — анализ влияния изменений (ФТ-М7.3).
          </p>
          {preStartImpact && <ImpactView report={preStartImpact} />}
          <button
            className="primary"
            disabled={busy}
            onClick={() => withBusy(async () => { await api.startReview(session.id); onChanged(); await reload(); })}
          >
            Отправить на согласование
          </button>
        </div>
      )}

      {route && (
        <div style={{ marginTop: 10 }}>
          <ol style={{ paddingLeft: 20 }}>
            {route.steps.map((s, i) => (
              <li key={s.id} style={{ marginBottom: 8, opacity: i > route.currentStepIndex && route.status === "review" ? 0.5 : 1 }}>
                <strong>{s.label}</strong>{" "}
                {s.status === "pending" && i === route.currentStepIndex && route.status === "review" && <span className="badge-hyp">текущий шаг</span>}
                {s.status === "approved" && <span style={{ color: "#2C7A57" }}> ✓ согласовано</span>}
                {s.status === "rejected" && <span style={{ color: "#AD4130" }}> ✕ на доработку</span>}
                {s.comment && <div className="muted" style={{ fontSize: 12 }}>«{s.comment}»</div>}
              </li>
            ))}
          </ol>

          {route.status === "review" && (
            <div className="toolbar">
              <button
                className="primary"
                disabled={busy}
                onClick={() =>
                  withBusy(async () => {
                    const r = await api.approveReviewStep(session.id, "Согласовано");
                    setLastResult(r.finalized ? `Финальное утверждение. Уведомлений отправлено: ${r.notificationsSent ?? 0}.` : "Шаг согласован, переход к следующему.");
                    onChanged();
                    await reload();
                  })
                }
              >
                Согласовать текущий шаг
              </button>
              <button onClick={() => setShowReject(!showReject)}>Отправить на доработку</button>
            </div>
          )}

          {showReject && (
            <div className="chat-input-row" style={{ marginTop: 8 }}>
              <input placeholder="Причина возврата на доработку (обязательно)" value={rejectComment} onChange={(e) => setRejectComment(e.target.value)} />
              <button
                disabled={busy || !rejectComment.trim()}
                onClick={() =>
                  withBusy(async () => {
                    await api.rejectReviewStep(session.id, rejectComment);
                    setRejectComment("");
                    setShowReject(false);
                    onChanged();
                    await reload();
                  })
                }
              >
                Отправить
              </button>
            </div>
          )}

          {route.status === "needs_rework" && (
            <div className="validation-item warning">
              Отправлено на доработку. После правок нажмите «Отправить на согласование» ещё раз, чтобы перезапустить маршрут.
              <div className="toolbar" style={{ marginTop: 6 }}>
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() => withBusy(async () => { await api.startReview(session.id); onChanged(); await reload(); })}
                >
                  Отправить на согласование заново
                </button>
              </div>
            </div>
          )}

          {lastResult && <div className="validation-item" style={{ marginTop: 8 }}>{lastResult}</div>}
          {route.impactReport && <ImpactView report={route.impactReport} />}
        </div>
      )}

      <h5 style={{ marginTop: 20 }}>Уведомления (ФТ-М7.4.2)</h5>
      <p className="muted" style={{ fontSize: 12 }}>
        При финальном утверждении система создаёт уведомления владельцам смежных процессов и по затронутым ролям.
        Канал "в системе" работает всегда; вебхук (мессенджер/внешняя интеграция) — опционально.
      </p>
      <div className="chat-input-row">
        <input placeholder="Webhook для уведомлений (необязательно)" value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} />
        <button disabled={busy || !webhookUrl.trim()} onClick={() => withBusy(async () => { await api.setNotificationWebhook(session.id, webhookUrl.trim()); })}>
          Сохранить
        </button>
      </div>
    </div>
  );
}

function ImpactView({ report }: { report: ImpactReport }) {
  return (
    <div className="card" style={{ marginTop: 10, background: "#f8fafc" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <strong>Значимость изменения:</strong>
        <span style={{ color: SIGNIFICANCE_COLOR[report.significance], fontWeight: 600 }}>{SIGNIFICANCE_LABEL[report.significance]}</span>
      </div>
      {report.changedNodeNames.length > 0 && (
        <div style={{ fontSize: 13, marginBottom: 4 }}>Изменённые шаги: {report.changedNodeNames.join(", ")}</div>
      )}
      {report.adjacentProcesses.length > 0 && (
        <div style={{ fontSize: 13, marginBottom: 4 }}>
          Смежные процессы:{" "}
          {report.adjacentProcesses.map((p, i) => (
            <span key={p.processId}>
              {i > 0 && "; "}
              «{p.name}» ({p.owner ?? "владелец не указан"}) — {p.reason}
            </span>
          ))}
        </div>
      )}
      {report.affectedDocuments.length > 0 && <div style={{ fontSize: 13, marginBottom: 4 }}>Устареет абзацев в регламенте: {report.affectedDocuments.length}</div>}
      {report.affectedRequirements.length > 0 && <div style={{ fontSize: 13, marginBottom: 4 }}>Затронуто требований: {report.affectedRequirements.length}</div>}
      {report.affectedRoles.length > 0 && <div style={{ fontSize: 13, marginBottom: 4 }}>Затронутые роли: {report.affectedRoles.map((r) => r.name).join(", ")}</div>}
      {report.kpiChanged && <div style={{ fontSize: 13, color: "#B87317" }}>Изменились показатели (KPI) процесса</div>}
      {report.adjacentProcesses.length === 0 &&
        report.affectedDocuments.length === 0 &&
        report.affectedRequirements.length === 0 &&
        !report.kpiChanged &&
        report.changedNodeNames.length === 0 && <div className="muted" style={{ fontSize: 13 }}>Существенных изменений с базовой версии не обнаружено.</div>}
    </div>
  );
}
