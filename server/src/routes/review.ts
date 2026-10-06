import { Router } from "express";
import { nanoid } from "nanoid";
import { getSession, updateSession, addVersion, editBlockReason } from "../repo.js";
import type { ReviewRoute, ReviewStep } from "../repo.js";
import { db, logAudit } from "../db.js";
import { analyzeImpact, type AdjacentProcessImpact } from "../pipeline/impactAnalysis.js";
import { diffModels } from "../pipeline/diff.js";
import { resolveRecipients, buildNotificationMessage } from "../pipeline/notifications.js";

export const reviewRouter = Router();

const DEFAULT_STEPS: { role: string; label: string; assignee?: string | null }[] = [
  { role: "analyst", label: "Аналитик" },
  { role: "owner", label: "Владелец процесса" },
  { role: "normcontrol", label: "Нормоконтролёр" },
];

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

function findAdjacentProcesses(sessionId: string, before: any, after: any): AdjacentProcessImpact[] {
  const registryRows = db.prepare(`SELECT id FROM processes WHERE session_id = ?`).all(sessionId) as { id: string }[];
  if (registryRows.length === 0) return [];
  const registryIds = registryRows.map((r) => r.id);
  const d = diffModels(before, after);
  const changedDataNames = new Set([...d.data.added, ...d.data.removed, ...d.data.changed.map((c) => c.after)].map((x: any) => norm(x.name)));
  if (changedDataNames.size === 0) return [];
  const placeholders = registryIds.map(() => "?").join(",");
  const links = db
    .prepare(`SELECT * FROM process_links WHERE confirmed = 1 AND (from_process_id IN (${placeholders}) OR to_process_id IN (${placeholders}))`)
    .all(...registryIds, ...registryIds) as { from_process_id: string; to_process_id: string; data_label: string }[];
  const out: AdjacentProcessImpact[] = [];
  for (const link of links) {
    if (!changedDataNames.has(norm(link.data_label))) continue;
    const otherId = registryIds.includes(link.from_process_id) ? link.to_process_id : link.from_process_id;
    const other = db.prepare(`SELECT * FROM processes WHERE id = ?`).get(otherId) as { id: string; name: string; owner: string | null } | undefined;
    if (!other) continue;
    out.push({ processId: other.id, name: other.name, owner: other.owner, reason: `изменился общий объект данных «${link.data_label}»` });
  }
  return out;
}

function findBaselineVersion(session: NonNullable<ReturnType<typeof getSession>>) {
  const lastApproved = [...session.versions].reverse().find((v) => v.major);
  return lastApproved ?? session.versions[0];
}

/** ФТ-М7.2.1: запуск маршрута согласования (по умолчанию: аналитик → владелец → нормоконтролёр). Сразу считает анализ влияния (ФТ-М7.3.1). */
reviewRouter.post("/sessions/:id/review/start", (req, res) => {
  const session = getSession(req.params.id);
  if (!session || !session.model) {
    res.status(400).json({ error: "модель ещё не построена" });
    return;
  }
  const block = editBlockReason(session);
  if (block) {
    res.status(409).json({ error: block });
    return;
  }
  const { steps: customSteps } = req.body as { steps?: { role: string; label: string; assignee?: string | null }[] };
  const stepDefs = customSteps && customSteps.length > 0 ? customSteps : DEFAULT_STEPS;
  const steps: ReviewStep[] = stepDefs.map((s) => ({ id: `rs_${nanoid(8)}`, role: s.role, label: s.label, assignee: s.assignee ?? null, status: "pending", comment: null, ts: null }));

  const baseline = findBaselineVersion(session);
  const adjacent = baseline ? findAdjacentProcesses(session.id, baseline.model, session.model) : [];
  const impactReport = baseline ? analyzeImpact(baseline.model, session.model, adjacent) : null;

  const route: ReviewRoute = {
    id: `rr_${nanoid(8)}`,
    steps,
    currentStepIndex: 0,
    status: "review",
    baselineSeq: baseline?.seq ?? 0,
    impactReport,
    startedAt: new Date().toISOString(),
    completedAt: null,
  };

  const model = { ...session.model, process: { ...session.model.process, status: "review" as const } };
  updateSession(req.params.id, { model, reviewRoute: route });
  logAudit(req.params.id, "analyst", "review_started", { steps: steps.length });
  const updated = addVersion(req.params.id, "Отправлено на согласование");
  res.json({ session: updated, impactReport });
});

reviewRouter.get("/sessions/:id/review", (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json(session.reviewRoute);
});

/** ФТ-М7.2.3: замечание к текущему шагу — привязано к элементу модели или абзацу документа. */
reviewRouter.post("/sessions/:id/review/steps/current/approve", (req, res) => {
  const session = getSession(req.params.id);
  if (!session || !session.reviewRoute) {
    res.status(400).json({ error: "маршрут согласования не запущен" });
    return;
  }
  const route = session.reviewRoute;
  if (route.status !== "review") {
    res.status(409).json({ error: "маршрут уже завершён или на доработке" });
    return;
  }
  const { comment } = req.body as { comment?: string };
  const steps = route.steps.map((s, i) => (i === route.currentStepIndex ? { ...s, status: "approved" as const, comment: comment ?? null, ts: new Date().toISOString() } : s));
  const isLast = route.currentStepIndex === steps.length - 1;

  if (!isLast) {
    const updatedRoute: ReviewRoute = { ...route, steps, currentStepIndex: route.currentStepIndex + 1 };
    updateSession(req.params.id, { reviewRoute: updatedRoute });
    logAudit(req.params.id, "reviewer", "review_step_approved", { step: route.currentStepIndex });
    res.json({ session: getSession(req.params.id), finalized: false });
    return;
  }

  // последний шаг — финальное утверждение (ФТ-М7.1.1/М7.2.2)
  const baseline = session.versions.find((v) => v.seq === route.baselineSeq) ?? session.versions[0];
  const adjacent = baseline ? findAdjacentProcesses(session.id, baseline.model, session.model!) : [];
  const finalReport = baseline ? analyzeImpact(baseline.model, session.model!, adjacent) : route.impactReport;

  const completedRoute: ReviewRoute = { ...route, steps, status: "approved", completedAt: new Date().toISOString(), impactReport: finalReport };
  updateSession(req.params.id, { reviewRoute: completedRoute });
  logAudit(req.params.id, "reviewer", "review_step_approved", { step: route.currentStepIndex, final: true });

  const updated = addVersion(req.params.id, "Утверждено маршрутом согласования", { major: true, author: session.reviewRoute.steps[session.reviewRoute.steps.length - 1]?.label ?? "Нормоконтролёр" });

  // синхронизация статуса связанной карточки реестра (М1.5/М3.1)
  db.prepare(`UPDATE processes SET status = 'approved', version = ? WHERE session_id = ?`).run(updated.model?.process.version ?? "1.0", session.id);

  // ФТ-М7.4: уведомления по итоговому анализу влияния
  let notificationsSent = 0;
  if (finalReport) {
    const recipients = resolveRecipients(finalReport);
    const diffLink = `/sessions/${session.id}?tab=versions&since=${route.baselineSeq}`;
    const webhookRow = db.prepare(`SELECT webhook_url FROM notification_webhooks WHERE session_id = ?`).get(session.id) as { webhook_url: string } | undefined;
    for (const r of recipients) {
      const message = buildNotificationMessage(r, session.meta.processName, finalReport, diffLink);
      const id = `notif_${nanoid(10)}`;
      db.prepare(
        `INSERT INTO notifications (id, session_id, recipient_kind, recipient_label, recipient_contact, channel, message, diff_link, is_read, created_at) VALUES (?, ?, ?, ?, ?, 'system', ?, ?, 0, ?)`
      ).run(id, session.id, r.kind, r.label, r.contact, message, diffLink, new Date().toISOString());
      notificationsSent += 1;
      if (webhookRow?.webhook_url) {
        fetch(webhookRow.webhook_url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session: session.meta.processName, recipient: r.label, message, diff_link: diffLink }),
          signal: AbortSignal.timeout(10_000),
        }).catch(() => {
          // доставка по вебхуку — лучшая попытка, системное уведомление уже сохранено
        });
      }
    }
  }

  res.json({ session: getSession(req.params.id), finalized: true, impactReport: finalReport, notificationsSent });
});

reviewRouter.post("/sessions/:id/review/steps/current/reject", (req, res) => {
  const session = getSession(req.params.id);
  if (!session || !session.reviewRoute) {
    res.status(400).json({ error: "маршрут согласования не запущен" });
    return;
  }
  const route = session.reviewRoute;
  if (route.status !== "review") {
    res.status(409).json({ error: "маршрут уже завершён или на доработке" });
    return;
  }
  const { comment } = req.body as { comment: string };
  if (!comment || !comment.trim()) {
    res.status(400).json({ error: "comment is required for rejection" });
    return;
  }
  const steps = route.steps.map((s, i) => (i === route.currentStepIndex ? { ...s, status: "rejected" as const, comment, ts: new Date().toISOString() } : s));
  const updatedRoute: ReviewRoute = { ...route, steps, status: "needs_rework" };
  const model = { ...session.model!, process: { ...session.model!.process, status: "needs_rework" as const } };
  updateSession(req.params.id, { model, reviewRoute: updatedRoute });
  logAudit(req.params.id, "reviewer", "review_step_rejected", { step: route.currentStepIndex, comment });
  const updated = addVersion(req.params.id, `Отправлено на доработку: ${comment.slice(0, 60)}`);
  res.json({ session: updated, finalized: false });
});

/** ФТ-М7.2.4: возврат утверждённой (или отправленной на доработку) версии в черновик — иначе правки заблокированы. */
reviewRouter.post("/sessions/:id/reopen", (req, res) => {
  const session = getSession(req.params.id);
  if (!session || !session.model) {
    res.status(400).json({ error: "модель ещё не построена" });
    return;
  }
  if (session.model.process.status === "draft") {
    res.status(409).json({ error: "уже в черновике" });
    return;
  }
  const model = { ...session.model, process: { ...session.model.process, status: "draft" as const } };
  updateSession(req.params.id, { model, reviewRoute: null });
  logAudit(req.params.id, "analyst", "review_reopened");
  const updated = addVersion(req.params.id, "Открыт новый цикл правок");
  res.json(updated);
});
