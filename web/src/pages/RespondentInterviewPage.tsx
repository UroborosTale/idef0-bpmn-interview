import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { ChatMessage } from "../types";

/** ФТ-М4.2.2: персональная ссылка респондента — отдельная страница без доступа к остальной системе. */
export default function RespondentInterviewPage({ campaignId, token }: { campaignId: string; token: string }) {
  const [processName, setProcessName] = useState("");
  const [respondentName, setRespondentName] = useState("");
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<string>("pending");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    api
      .respondentView(campaignId, token)
      .then((v) => {
        setProcessName(v.processName);
        setRespondentName(v.respondentName);
        setChat(v.chat);
        setStatus(v.status);
        setLoaded(true);
      })
      .catch((e) => setError(e.message));
  }, [campaignId, token]);

  if (error) {
    return (
      <div style={{ maxWidth: 560, margin: "80px auto", textAlign: "center" }}>
        <h2>Ссылка недействительна</h2>
        <p className="muted">{error}</p>
      </div>
    );
  }
  if (!loaded) return <p className="muted" style={{ margin: 40, textAlign: "center" }}>Загрузка…</p>;

  async function send() {
    if (!text.trim()) return;
    setBusy(true);
    try {
      const r = await api.respondentTurn(campaignId, token, text);
      setChat(r.chat);
      setStatus(r.status);
      setText("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function finish() {
    setBusy(true);
    try {
      await api.respondentFinish(campaignId, token);
      setStatus("completed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ maxWidth: 640, margin: "0 auto", padding: "24px 16px" }}>
      <h2 style={{ marginBottom: 4 }}>Интервью: {processName}</h2>
      <p className="muted">Здравствуйте, {respondentName}! Расскажите, пожалуйста, о своей части процесса.</p>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="chat-log" style={{ maxHeight: "50vh", overflow: "auto" }}>
          {chat.map((m) => (
            <div key={m.id} className={`msg ${m.role === "owner" ? "owner" : "assistant"}`}>{m.text}</div>
          ))}
        </div>
        {status !== "completed" ? (
          <>
            <div className="chat-input-row" style={{ marginTop: 10 }}>
              <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Ваш ответ…" />
              <button className="primary" disabled={busy || !text.trim()} onClick={send}>Отправить</button>
            </div>
            <div className="toolbar" style={{ marginTop: 8 }}>
              <button disabled={busy} onClick={finish}>Завершить интервью</button>
            </div>
          </>
        ) : (
          <p style={{ marginTop: 10 }}>Спасибо! Интервью завершено — можно закрыть эту страницу.</p>
        )}
      </div>
    </div>
  );
}
