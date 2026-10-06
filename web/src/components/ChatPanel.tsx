import { useEffect, useRef, useState } from "react";
import type { ChatMessage } from "../types";

export default function ChatPanel({
  chat,
  onSend,
  busy,
  finished,
  onFinish,
}: {
  chat: ChatMessage[];
  onSend: (text: string) => Promise<void>;
  busy: boolean;
  finished: boolean;
  onFinish: () => void;
}) {
  const [text, setText] = useState("");
  const logRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
  }, [chat.length]);

  async function send() {
    if (!text.trim() || busy) return;
    const t = text.trim();
    setText("");
    await onSend(t);
  }

  return (
    <div className="chat-panel">
      <div className="chat-log" ref={logRef}>
        {chat.map((m) => (
          <div key={m.id} className={`chat-msg ${m.role === "owner" ? "owner" : "assistant"}`}>
            {m.text}
          </div>
        ))}
        {busy && <div className="chat-msg assistant muted">печатает…</div>}
      </div>
      {!finished ? (
        <div className="chat-input-row">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Ответьте на вопрос…"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <button className="primary" onClick={send} disabled={busy || !text.trim()}>
            Отправить
          </button>
          <button onClick={onFinish} disabled={busy}>
            Завершить интервью
          </button>
        </div>
      ) : (
        <p className="muted" style={{ marginTop: 10 }}>
          Интервью завершено. Протокол и черновик моделей доступны аналитику во вкладке «Экспорт».
        </p>
      )}
    </div>
  );
}
