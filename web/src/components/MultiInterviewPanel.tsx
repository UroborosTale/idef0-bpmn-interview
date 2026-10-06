import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { SessionRecord, InterviewTrack, SessionRespondent, Discrepancy } from "../types";

const STATUS_LABEL: Record<string, string> = { pending: "не начата", in_progress: "в процессе", completed: "завершена" };
const DISC_KIND_LABEL: Record<string, string> = { step_presence: "наличие шага", executor: "исполнитель", timing: "сроки", step_order: "порядок шагов" };

type RespondentRow = SessionRespondent & { track: InterviewTrack | null };

/** ФТ-М4.1: мультиинтервью — респонденты, их дорожки, слияние в единую модель, расхождения. */
export default function MultiInterviewPanel({ session, onChanged }: { session: SessionRecord; onChanged: () => void }) {
  const [rows, setRows] = useState<RespondentRow[]>([]);
  const [discrepancies, setDiscrepancies] = useState<Discrepancy[]>([]);
  const [busy, setBusy] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [tab, setTab] = useState<"respondents" | "campaigns">("respondents");

  async function reload() {
    setRows(await api.listRespondents(session.id));
    if (session.model) {
      try {
        setDiscrepancies(await api.listDiscrepancies(session.id));
      } catch {
        setDiscrepancies([]);
      }
    }
  }

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id]);

  async function withBusy(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  }

  const nodeById = new Map((session.model?.nodes ?? []).map((n) => [n.id, n] as const));

  return (
    <div>
      <div className="toolbar">
        <h4 style={{ margin: 0 }}>Мультиинтервью</h4>
        <div className="spacer" />
        <button className={tab === "respondents" ? "active" : ""} onClick={() => setTab("respondents")}>Респонденты</button>
        <button className={tab === "campaigns" ? "active" : ""} onClick={() => setTab("campaigns")}>Асинхронный сбор</button>
      </div>

      {tab === "respondents" && (
        <>
          <div className="toolbar" style={{ marginTop: 10 }}>
            <button onClick={() => setShowAdd(true)}>+ Добавить респондента</button>
            <button
              className="primary"
              disabled={busy || !rows.some((r) => (r.track?.fragments.length ?? 0) > 0)}
              onClick={() => withBusy(async () => { await api.mergeTracks(session.id); onChanged(); await reload(); })}
            >
              Свести дорожки в модель
            </button>
          </div>

          {showAdd && <AddRespondentForm onCancel={() => setShowAdd(false)} onCreate={async (input) => { await api.addRespondent(session.id, input.name, input.mode, input.roleId, input.weight); setShowAdd(false); await reload(); }} />}

          <table className="mono" style={{ width: "100%", fontSize: 13, marginTop: 12, borderCollapse: "collapse" }}>
            <thead><tr style={{ textAlign: "left" }}><th>Респондент</th><th>Роль</th><th>Вес</th><th>Дорожка</th><th>Статус</th><th></th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <RespondentRowView key={r.id} sessionId={session.id} row={r} busy={busy} onChanged={async () => { onChanged(); await reload(); }} />
              ))}
              {rows.length === 0 && <tr><td colSpan={6} className="muted" style={{ padding: 12 }}>Респондентов пока нет.</td></tr>}
            </tbody>
          </table>

          {discrepancies.length > 0 && (
            <div style={{ marginTop: 20 }}>
              <h4>Расхождения между респондентами</h4>
              {discrepancies.map((d) => (
                <div key={d.id} className={`validation-item ${d.status === "resolved" ? "" : "warning"}`} style={{ marginBottom: 8 }}>
                  <div><strong>[{DISC_KIND_LABEL[d.kind] ?? d.kind}]</strong> {nodeById.get(d.element_id)?.name ?? d.element_id}</div>
                  <div style={{ fontSize: 12, margin: "4px 0" }}>{d.question}</div>
                  {d.status === "resolved" ? (
                    <div className="muted" style={{ fontSize: 12 }}>Разрешено: {d.resolved_value}</div>
                  ) : (
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {[...new Set(d.variants.map((v) => v.value))].map((v) => (
                        <button
                          key={v}
                          disabled={busy}
                          onClick={() => withBusy(async () => { await api.resolveDiscrepancy(session.id, d.id, v); onChanged(); await reload(); })}
                        >
                          {v}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {tab === "campaigns" && <CampaignsSection session={session} />}
    </div>
  );
}

function RespondentRowView({
  sessionId,
  row,
  busy,
  onChanged,
}: {
  sessionId: string;
  row: RespondentRow;
  busy: boolean;
  onChanged: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [chatText, setChatText] = useState("");
  const track = row.track;

  return (
    <>
      <tr style={{ borderTop: "1px solid #e5e7eb" }}>
        <td>{row.name}</td>
        <td>{row.roleId ?? "—"}</td>
        <td>{row.weight}</td>
        <td>{track?.mode === "chat" ? "чат" : "текст"}</td>
        <td>{track ? STATUS_LABEL[track.status] : "—"}</td>
        <td>
          <button onClick={() => setOpen(!open)}>{open ? "Свернуть" : "Открыть"}</button>{" "}
          <button onClick={async () => { await api.removeRespondent(sessionId, row.id); await onChanged(); }}>✕</button>
        </td>
      </tr>
      {open && track && (
        <tr>
          <td colSpan={6} style={{ background: "#f8fafc", padding: 10 }}>
            {track.mode === "text" ? (
              <div>
                <textarea style={{ width: "100%", height: 80 }} placeholder="Текст интервью этого респондента…" value={text} onChange={(e) => setText(e.target.value)} />
                <div className="toolbar" style={{ marginTop: 6 }}>
                  <button disabled={busy || !text.trim()} onClick={async () => { await api.trackIngestText(sessionId, track.id, text); setText(""); await onChanged(); }}>
                    Загрузить текст
                  </button>
                </div>
                {track.fragments.length > 0 && <div className="muted" style={{ fontSize: 12 }}>Загружено фрагментов: {track.fragments.length}</div>}
              </div>
            ) : (
              <div>
                {track.chat.length === 0 ? (
                  <button disabled={busy} onClick={async () => { await api.trackInterviewStart(sessionId, track.id); await onChanged(); }}>Начать интервью</button>
                ) : (
                  <>
                    <div style={{ maxHeight: 200, overflow: "auto", marginBottom: 6 }}>
                      {track.chat.map((m) => (
                        <div key={m.id} className={`msg ${m.role === "owner" ? "owner" : "assistant"}`} style={{ fontSize: 13 }}>{m.text}</div>
                      ))}
                    </div>
                    {track.status !== "completed" && (
                      <div className="chat-input-row">
                        <input value={chatText} onChange={(e) => setChatText(e.target.value)} placeholder="Ответ респондента…" />
                        <button disabled={busy || !chatText.trim()} onClick={async () => { await api.trackInterviewTurn(sessionId, track.id, chatText); setChatText(""); await onChanged(); }}>
                          Отправить
                        </button>
                        <button disabled={busy} onClick={async () => { await api.trackFinish(sessionId, track.id); await onChanged(); }}>Завершить</button>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function AddRespondentForm({
  onCancel,
  onCreate,
}: {
  onCancel: () => void;
  onCreate: (input: { name: string; mode: "text" | "chat"; roleId?: string | null; weight: number }) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [mode, setMode] = useState<"text" | "chat">("text");
  const [roleId, setRoleId] = useState("");
  const [weight, setWeight] = useState(1);
  return (
    <div className="card" style={{ marginTop: 10, background: "#f8fafc" }}>
      <div className="form-grid">
        <label className="field"><span>Имя*</span><input value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="field"><span>Роль (подсказка)</span><input value={roleId} onChange={(e) => setRoleId(e.target.value)} placeholder="напр. руководитель" /></label>
        <label className="field"><span>Способ сбора</span>
          <select value={mode} onChange={(e) => setMode(e.target.value as any)}>
            <option value="text">Готовый текст</option>
            <option value="chat">Интерактивный чат</option>
          </select>
        </label>
        <label className="field"><span>Вес (ФТ-М4.1.5)</span><input type="number" min={0} step={0.5} value={weight} onChange={(e) => setWeight(Number(e.target.value) || 1)} /></label>
      </div>
      <div className="toolbar" style={{ marginTop: 10 }}>
        <button className="primary" disabled={!name.trim()} onClick={() => onCreate({ name, mode, roleId: roleId || null, weight })}>Добавить</button>
        <button onClick={onCancel}>Отмена</button>
      </div>
    </div>
  );
}

function CampaignsSection({ session }: { session: SessionRecord }) {
  const [campaigns, setCampaigns] = useState<Awaited<ReturnType<typeof api.listCampaigns>>>([]);
  const [showNew, setShowNew] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  async function reload() {
    setCampaigns(await api.listCampaigns(session.id));
  }
  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id]);

  return (
    <div style={{ marginTop: 10 }}>
      <div className="toolbar">
        <button onClick={() => setShowNew(true)}>+ Новая кампания</button>
      </div>
      {showNew && <NewCampaignForm onCancel={() => setShowNew(false)} onCreated={async () => { setShowNew(false); await reload(); }} sessionId={session.id} />}
      <ul style={{ fontSize: 13, marginTop: 10 }}>
        {campaigns.map((c) => (
          <li key={c.id} style={{ marginBottom: 4 }}>
            <button onClick={() => setSelected(c.id === selected ? null : c.id)}>{c.name}</button>
            {c.due_date && <span className="muted"> — срок: {new Date(c.due_date).toLocaleDateString("ru-RU")}</span>}
          </li>
        ))}
        {campaigns.length === 0 && <p className="muted">Кампаний пока нет.</p>}
      </ul>
      {selected && <CampaignDetail campaignId={selected} onDeleted={async () => { setSelected(null); await reload(); }} />}
    </div>
  );
}

function NewCampaignForm({ sessionId, onCancel, onCreated }: { sessionId: string; onCancel: () => void; onCreated: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [respondents, setRespondents] = useState<{ name: string; roleId: string; weight: number }[]>([{ name: "", roleId: "", weight: 1 }]);
  const [busy, setBusy] = useState(false);
  const [links, setLinks] = useState<{ name: string; link: string }[] | null>(null);

  return (
    <div className="card" style={{ marginTop: 10, background: "#f8fafc" }}>
      {!links ? (
        <>
          <label className="field"><span>Название кампании*</span><input value={name} onChange={(e) => setName(e.target.value)} /></label>
          <label className="field" style={{ marginTop: 6 }}><span>Срок</span><input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></label>
          <h5 style={{ marginTop: 10 }}>Респонденты</h5>
          {respondents.map((r, i) => (
            <div key={i} className="form-grid" style={{ marginBottom: 6 }}>
              <input placeholder="Имя" value={r.name} onChange={(e) => setRespondents(respondents.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
              <input placeholder="Роль" value={r.roleId} onChange={(e) => setRespondents(respondents.map((x, j) => (j === i ? { ...x, roleId: e.target.value } : x)))} />
              <input type="number" min={0} step={0.5} value={r.weight} onChange={(e) => setRespondents(respondents.map((x, j) => (j === i ? { ...x, weight: Number(e.target.value) || 1 } : x)))} />
            </div>
          ))}
          <button onClick={() => setRespondents([...respondents, { name: "", roleId: "", weight: 1 }])}>+ Ещё респондент</button>
          <div className="toolbar" style={{ marginTop: 10 }}>
            <button
              className="primary"
              disabled={busy || !name.trim() || !respondents.some((r) => r.name.trim())}
              onClick={async () => {
                setBusy(true);
                try {
                  const valid = respondents.filter((r) => r.name.trim());
                  const created = await api.createCampaign(sessionId, name, dueDate ? new Date(dueDate).toISOString() : null, valid.map((r) => ({ name: r.name, roleId: r.roleId || null, weight: r.weight })));
                  setLinks(created.respondents.map((r) => ({ name: r.name, link: window.location.origin + r.link })));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Создать кампанию
            </button>
            <button onClick={onCancel}>Отмена</button>
          </div>
        </>
      ) : (
        <div>
          <p>Кампания создана. Персональные ссылки для респондентов:</p>
          <ul style={{ fontSize: 13 }}>
            {links.map((l) => (
              <li key={l.link}>
                {l.name}: <code>{l.link}</code>{" "}
                <button onClick={() => navigator.clipboard?.writeText(l.link)}>Копировать</button>
              </li>
            ))}
          </ul>
          <button className="primary" onClick={onCreated}>Готово</button>
        </div>
      )}
    </div>
  );
}

function CampaignDetail({ campaignId, onDeleted }: { campaignId: string; onDeleted: () => Promise<void> }) {
  const [status, setStatus] = useState<Awaited<ReturnType<typeof api.getCampaignStatus>> | null>(null);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [remindResult, setRemindResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function reload() {
    setStatus(await api.getCampaignStatus(campaignId));
  }
  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId]);

  if (!status) return <p className="muted">Загрузка…</p>;

  return (
    <div className="card" style={{ marginTop: 10 }}>
      <div className="toolbar">
        <h5 style={{ margin: 0 }}>{status.campaign.name}</h5>
        <div className="spacer" />
        <span className="muted" style={{ fontSize: 12 }}>
          Прошли: {status.coverage.completed} / В процессе: {status.coverage.inProgress} / Не начали: {status.coverage.notStarted}
        </span>
        <button onClick={async () => { if (confirm("Удалить кампанию?")) { await api.deleteCampaign(campaignId); await onDeleted(); } }}>Удалить</button>
      </div>
      <table className="mono" style={{ width: "100%", fontSize: 12, marginTop: 8 }}>
        <thead><tr style={{ textAlign: "left" }}><th>Респондент</th><th>Статус</th><th>Просрочено</th><th>Ссылка</th></tr></thead>
        <tbody>
          {status.respondents.map((r) => (
            <tr key={r.id} style={{ borderTop: "1px solid #e5e7eb" }}>
              <td>{r.name}</td>
              <td>{STATUS_LABEL[r.status]}</td>
              <td>{r.overdue ? "да" : "нет"}</td>
              <td><button onClick={() => navigator.clipboard?.writeText(window.location.origin + `/campaign/${campaignId}/${r.token}`)}>Копировать ссылку</button></td>
            </tr>
          ))}
        </tbody>
      </table>

      <h5 style={{ marginTop: 14 }}>Напоминания (ФТ-М4.2.4)</h5>
      <div className="chat-input-row">
        <input placeholder="Webhook для отправки напоминаний (необязательно)" value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} />
        <button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              if (webhookUrl.trim()) await api.setCampaignReminderWebhook(campaignId, webhookUrl.trim());
              const r = await api.sendCampaignReminders(campaignId);
              setRemindResult(r.note ?? `Отправлено напоминаний: ${r.sent} из ${r.overdue.length} просроченных.`);
              await reload();
            } catch (e) {
              setRemindResult("Ошибка: " + (e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          Проверить и отправить напоминания
        </button>
      </div>
      {remindResult && <div className="validation-item" style={{ marginTop: 6 }}>{remindResult}</div>}
    </div>
  );
}
