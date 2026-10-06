import { useState } from "react";
import type { Comment } from "../types";

export default function CommentsPanel({
  comments,
  selectedId,
  onAdd,
}: {
  comments: Comment[];
  selectedId: string | null;
  onAdd: (elementId: string | null, text: string) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const relevant = selectedId ? comments.filter((c) => c.element_id === selectedId) : comments;

  return (
    <div>
      <h4>{selectedId ? "Комментарии к элементу" : "Все комментарии"}</h4>
      {relevant.length === 0 && <p className="muted">Комментариев нет.</p>}
      {relevant.map((c) => (
        <div key={c.id} className="comment-item">
          <div className="meta">{c.author} · {new Date(c.ts).toLocaleString("ru-RU")}</div>
          {c.text}
        </div>
      ))}
      <div className="chat-input-row" style={{ marginTop: 8 }}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder={selectedId ? "Комментарий к выбранному элементу…" : "Общий комментарий…"} />
        <button
          disabled={!text.trim()}
          onClick={async () => {
            await onAdd(selectedId, text.trim());
            setText("");
          }}
        >
          Добавить
        </button>
      </div>
    </div>
  );
}
