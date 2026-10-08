import { useEffect, useRef, useState } from "react";
import type { ChatMessage } from "../types";

export default function ChatPanel({
  chat,
  onSend,
  busy,
  finished,
  onFinish,
  onAsk,
}: {
  chat: ChatMessage[];
  onSend: (text: string) => Promise<void>;
  busy: boolean;
  finished: boolean;
  onFinish: () => void;
  /** Свой вопрос интервьюера: появляется в чате вместо следующего вопроса системы или сверх него. */
  onAsk?: (text: string) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [asking, setAsking] = useState(false);
  const logRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
  }, [chat.length]);

  async function send() {
    if (!text.trim() || busy) return;
    if (asking && text.trim().length < 5) return;
    const t = text.trim();
    setText("");
    if (asking && onAsk) {
      await onAsk(t);
      setAsking(false); // после своего вопроса снова ждём ответ владельца
    } else {
      await onSend(t);
    }
  }

  return (
    <div className="chat-panel">
      <div className="chat-log" ref={logRef}>
        {chat.map((m) => (
          <div key={m.id} className={`chat-msg ${m.role === "owner" ? "owner" : "assistant"}${m.author ? " by-interviewer" : ""}`}>
            {m.author && <div className="chat-author">Вопрос интервьюера{m.author !== "local" ? ` (${m.author})` : ""}</div>}
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
            placeholder={asking ? "Ваш вопрос владельцу процесса…" : "Ответьте на вопрос…"}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          {onAsk && (
            <button
              className={asking ? "active" : ""}
              aria-pressed={asking}
              onClick={() => setAsking(!asking)}
              disabled={busy}
              title="Задать владельцу свой вопрос вместо следующего вопроса системы"
            >
              Свой вопрос
            </button>
          )}
          <button className="primary" onClick={send} disabled={busy || !text.trim() || (asking && text.trim().length < 5)}>
            {asking ? "Задать вопрос" : "Отправить"}
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
