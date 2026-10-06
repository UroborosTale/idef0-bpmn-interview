import { Router } from "express";
import { nanoid } from "nanoid";
import { db, logAudit } from "../db.js";
import { getSession, updateSession } from "../repo.js";
import type { SessionRespondent, InterviewTrack } from "../repo.js";
import { startTrackChat, turnTrackChat } from "../pipeline/trackInterview.js";
import { validateWebhookUrl } from "../util/webhook.js";

export const campaignsRouter = Router();

interface CampaignRow {
  id: string;
  session_id: string;
  name: string;
  due_date: string | null;
  reminder_webhook_url: string | null;
  created_at: string;
}
interface CampaignRespondentRow {
  id: string;
  campaign_id: string;
  respondent_id: string;
  track_id: string;
  token: string;
  name: string;
  role_id: string | null;
  status: "pending" | "in_progress" | "completed";
  started_at: string | null;
  completed_at: string | null;
  last_reminded_at: string | null;
}

/** ФТ-М4.2.1: аналитик создаёт кампанию — процесс (сессия), респонденты, срок. Каждому респонденту заводится своя дорожка чата и персональный токен-ссылка. */
campaignsRouter.post("/sessions/:id/campaigns", (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const { name, due_date, respondents } = req.body as {
    name: string;
    due_date?: string | null;
    respondents: { name: string; roleId?: string | null; weight?: number }[];
  };
  if (!name || !respondents?.length) {
    res.status(400).json({ error: "name and respondents[] are required" });
    return;
  }

  const campaignId = `camp_${nanoid(10)}`;
  const newRespondents: SessionRespondent[] = [];
  const newTracks: InterviewTrack[] = [];
  const campaignRespondentRows: { id: string; token: string; name: string; roleId: string | null }[] = [];

  for (const spec of respondents) {
    const respondent: SessionRespondent = { id: `resp_${nanoid(8)}`, name: spec.name, roleId: spec.roleId ?? null, weight: spec.weight ?? 1 };
    const track: InterviewTrack = { id: `track_${nanoid(8)}`, respondentId: respondent.id, mode: "chat", fragments: [], rawText: "", chat: [], status: "pending" };
    newRespondents.push(respondent);
    newTracks.push(track);
    const token = nanoid(24);
    campaignRespondentRows.push({ id: `cr_${nanoid(10)}`, token, name: spec.name, roleId: spec.roleId ?? null });
    db.prepare(
      `INSERT INTO campaign_respondents (id, campaign_id, respondent_id, track_id, token, name, role_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`
    ).run(campaignRespondentRows[campaignRespondentRows.length - 1].id, campaignId, respondent.id, track.id, token, spec.name, spec.roleId ?? null);
  }

  db.prepare(`INSERT INTO campaigns (id, session_id, name, due_date, reminder_webhook_url, created_at) VALUES (?, ?, ?, ?, NULL, ?)`).run(
    campaignId,
    session.id,
    name,
    due_date ?? null,
    new Date().toISOString()
  );

  updateSession(session.id, { respondents: [...session.respondents, ...newRespondents], tracks: [...session.tracks, ...newTracks] });
  logAudit(session.id, "analyst", "campaign_created", { campaignId, respondents: respondents.length });

  res.status(201).json({
    campaign: { id: campaignId, session_id: session.id, name, due_date: due_date ?? null, created_at: new Date().toISOString() },
    respondents: campaignRespondentRows.map((r) => ({ name: r.name, roleId: r.roleId, token: r.token, link: `/campaign/${campaignId}/${r.token}` })),
  });
});

campaignsRouter.get("/sessions/:id/campaigns", (req, res) => {
  const rows = db.prepare(`SELECT * FROM campaigns WHERE session_id = ? ORDER BY created_at DESC`).all(req.params.id) as CampaignRow[];
  res.json(rows);
});

function campaignStatus(campaign: CampaignRow) {
  const respondents = db.prepare(`SELECT * FROM campaign_respondents WHERE campaign_id = ?`).all(campaign.id) as CampaignRespondentRow[];
  const now = Date.now();
  const overdue = campaign.due_date ? new Date(campaign.due_date).getTime() < now : false;
  return {
    campaign,
    respondents: respondents.map((r) => ({
      ...r,
      overdue: overdue && r.status !== "completed",
    })),
    coverage: {
      total: respondents.length,
      completed: respondents.filter((r) => r.status === "completed").length,
      inProgress: respondents.filter((r) => r.status === "in_progress").length,
      notStarted: respondents.filter((r) => r.status === "pending").length,
    },
  };
}

/** ФТ-М4.2.5: статус кампании — кто прошёл, кто не начал, покрытие. */
campaignsRouter.get("/campaigns/:campaignId", (req, res) => {
  const campaign = db.prepare(`SELECT * FROM campaigns WHERE id = ?`).get(req.params.campaignId) as CampaignRow | undefined;
  if (!campaign) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json(campaignStatus(campaign));
});

campaignsRouter.delete("/campaigns/:campaignId", (req, res) => {
  db.prepare(`DELETE FROM campaign_respondents WHERE campaign_id = ?`).run(req.params.campaignId);
  db.prepare(`DELETE FROM campaigns WHERE id = ?`).run(req.params.campaignId);
  res.status(204).end();
});

/** ФТ-М4.2.4: конфигурация напоминаний — вебхук, на который отправляется список просроченных респондентов. */
campaignsRouter.put("/campaigns/:campaignId/reminder-webhook", (req, res) => {
  const { webhook_url } = req.body as { webhook_url: string };
  if (!webhook_url) {
    res.status(400).json({ error: "webhook_url is required" });
    return;
  }
  const check = validateWebhookUrl(webhook_url);
  if (!check.ok) {
    res.status(400).json({ error: check.error });
    return;
  }
  db.prepare(`UPDATE campaigns SET reminder_webhook_url = ? WHERE id = ?`).run(webhook_url, req.params.campaignId);
  res.json({ webhook_url });
});

/**
 * ФТ-М4.2.4: напоминания по сроку. Если вебхук не настроен — просто
 * возвращает список просроченных респондентов (аналитик решает сам, как
 * их уведомить); если настроен — отправляет POST на каждого просроченного.
 */
campaignsRouter.post("/campaigns/:campaignId/remind", async (req, res) => {
  const campaign = db.prepare(`SELECT * FROM campaigns WHERE id = ?`).get(req.params.campaignId) as CampaignRow | undefined;
  if (!campaign) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const { respondents } = campaignStatus(campaign);
  const overdue = respondents.filter((r) => r.overdue);
  if (overdue.length === 0) {
    res.json({ overdue: [], sent: 0 });
    return;
  }
  if (!campaign.reminder_webhook_url) {
    res.json({ overdue: overdue.map((r) => ({ name: r.name, status: r.status })), sent: 0, note: "вебхук напоминаний не настроен — уведомите вручную" });
    return;
  }
  let sent = 0;
  for (const r of overdue) {
    try {
      await fetch(campaign.reminder_webhook_url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campaign: campaign.name, respondent: r.name, due_date: campaign.due_date, status: r.status, link: `/campaign/${campaign.id}/${r.token}` }),
        signal: AbortSignal.timeout(10_000),
      });
      db.prepare(`UPDATE campaign_respondents SET last_reminded_at = ? WHERE id = ?`).run(new Date().toISOString(), r.id);
      sent += 1;
    } catch {
      // продолжаем с остальными респондентами при сбое одного вебхука
    }
  }
  logAudit(campaign.session_id, "system", "campaign_reminders_sent", { campaignId: campaign.id, sent, overdue: overdue.length });
  res.json({ overdue: overdue.map((r) => ({ name: r.name, status: r.status })), sent });
});

// --- Публичные маршруты по персональному токену (без доступа к остальной системе) ---

function findByToken(token: string): { session: NonNullable<ReturnType<typeof getSession>>; track: InterviewTrack; cr: CampaignRespondentRow } | null {
  const cr = db.prepare(`SELECT * FROM campaign_respondents WHERE token = ?`).get(token) as CampaignRespondentRow | undefined;
  if (!cr) return null;
  const campaign = db.prepare(`SELECT * FROM campaigns WHERE id = ?`).get(cr.campaign_id) as CampaignRow | undefined;
  if (!campaign) return null;
  const session = getSession(campaign.session_id);
  if (!session) return null;
  const track = session.tracks.find((t) => t.id === cr.track_id);
  if (!track) return null;
  return { session, track, cr };
}

/** ФТ-М4.2.2: персональная ссылка респондента — без доступа аналитика к остальной системе, только своя дорожка. */
campaignsRouter.get("/campaigns/:campaignId/respond/:token", (req, res) => {
  const found = findByToken(req.params.token);
  if (!found || found.cr.campaign_id !== req.params.campaignId) {
    res.status(404).json({ error: "ссылка недействительна" });
    return;
  }
  const { session, track, cr } = found;
  const respondent = session.respondents.find((r) => r.id === track.respondentId);
  let currentTrack = track;
  if (track.chat.length === 0) {
    currentTrack = startTrackChat(track, respondent, session.meta.processName);
    const tracks = session.tracks.map((t) => (t.id === track.id ? currentTrack : t));
    updateSession(session.id, { tracks });
    if (cr.status === "pending") {
      db.prepare(`UPDATE campaign_respondents SET status = 'in_progress', started_at = ? WHERE id = ?`).run(new Date().toISOString(), cr.id);
    }
  }
  res.json({ processName: session.meta.processName, respondentName: cr.name, roleId: cr.role_id, chat: currentTrack.chat, status: currentTrack.status });
});

campaignsRouter.post("/campaigns/:campaignId/respond/:token/turn", async (req, res) => {
  const found = findByToken(req.params.token);
  if (!found || found.cr.campaign_id !== req.params.campaignId) {
    res.status(404).json({ error: "ссылка недействительна" });
    return;
  }
  const { text } = req.body as { text: string };
  if (!text || !text.trim()) {
    res.status(400).json({ error: "text is required" });
    return;
  }
  const { session, track, cr } = found;
  try {
    const updatedTrack = await turnTrackChat(session.id, session.meta, track, text);
    const tracks = session.tracks.map((t) => (t.id === track.id ? updatedTrack : t));
    updateSession(session.id, { tracks });
    if (cr.status === "pending") {
      db.prepare(`UPDATE campaign_respondents SET status = 'in_progress', started_at = ? WHERE id = ?`).run(new Date().toISOString(), cr.id);
    }
    res.json({ chat: updatedTrack.chat, status: updatedTrack.status });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

campaignsRouter.post("/campaigns/:campaignId/respond/:token/finish", (req, res) => {
  const found = findByToken(req.params.token);
  if (!found || found.cr.campaign_id !== req.params.campaignId) {
    res.status(404).json({ error: "ссылка недействительна" });
    return;
  }
  const { session, track, cr } = found;
  const tracks = session.tracks.map((t) => (t.id === track.id ? { ...t, status: "completed" as const } : t));
  updateSession(session.id, { tracks });
  db.prepare(`UPDATE campaign_respondents SET status = 'completed', completed_at = ? WHERE id = ?`).run(new Date().toISOString(), cr.id);
  res.json({ status: "completed" });
});
