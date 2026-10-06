import { useEffect, useState } from "react";
import { api, type VerificationParagraph } from "../api/client";
import type { SessionRecord } from "../types";

/** ФТ-М4.4: верификация текстом — пересказ процесса обычным языком, подтверждение абзацев, правки с diff перед применением. */
export default function VerificationPanel({ session, onChanged }: { session: SessionRecord; onChanged: () => void }) {
  const [paragraphs, setParagraphs] = useState<VerificationParagraph[]>([]);
  const [confirmed, setConfirmed] = useState<string[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [proposal, setProposal] = useState<{ diff: any; proposedModel: unknown; proposedFragments: unknown; proposedRawText: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function reload() {
    const p = await api.verificationPreview(session.id);
    setParagraphs(p.paragraphs);
    setConfirmed(p.confirmed);
  }

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id, session.updatedAt]);

  async function withBusy(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h4>Пересказ процесса обычным языком</h4>
      <p className="muted" style={{ fontSize: 12 }}>
        Владелец процесса читает пересказ (без терминов IDEF0/BPMN), подтверждает верные абзацы или правит неточные —
        правки превращаются в изменения модели, но применяются только после проверки аналитиком.
      </p>

      <div style={{ marginTop: 12 }}>
        {paragraphs.map((p) => (
          <div key={p.id} className="card" style={{ marginBottom: 8, padding: 12 }}>
            {editingId === p.id ? (
              <div>
                <textarea style={{ width: "100%", height: 70 }} value={editText} onChange={(e) => setEditText(e.target.value)} />
                <div className="toolbar" style={{ marginTop: 6 }}>
                  <button
                    className="primary"
                    disabled={busy || !editText.trim()}
                    onClick={() =>
                      withBusy(async () => {
                        const result = await api.proposeVerificationEdit(session.id, editText);
                        setProposal(result);
                      })
                    }
                  >
                    Показать изменения
                  </button>
                  <button onClick={() => setEditingId(null)}>Отмена</button>
                </div>
              </div>
            ) : (
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                <div>{p.text}</div>
                <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                  {confirmed.includes(p.id) ? (
                    <span className="pill status-approved">подтверждено</span>
                  ) : (
                    <button disabled={busy} onClick={() => withBusy(async () => { await api.confirmParagraph(session.id, p.id); await reload(); })}>
                      Подтвердить
                    </button>
                  )}
                  <button onClick={() => { setEditingId(p.id); setEditText(p.text); }}>Править</button>
                </div>
              </div>
            )}
          </div>
        ))}
        {paragraphs.length === 0 && <p className="muted">Не удалось построить пересказ.</p>}
      </div>

      {proposal && (
        <div className="card" style={{ marginTop: 16, background: "#fffbeb" }}>
          <h5 style={{ marginTop: 0 }}>Предлагаемые изменения модели (ФТ-М4.4.3)</h5>
          <DiffSummary diff={proposal.diff} />
          <div className="toolbar" style={{ marginTop: 10 }}>
            <button
              className="primary"
              disabled={busy}
              onClick={() =>
                withBusy(async () => {
                  await api.applyVerificationEdit(session.id, proposal as any);
                  setProposal(null);
                  setEditingId(null);
                  onChanged();
                  await reload();
                })
              }
            >
              Применить
            </button>
            <button onClick={() => setProposal(null)}>Отклонить</button>
          </div>
        </div>
      )}
    </div>
  );
}

function DiffSummary({ diff }: { diff: any }) {
  const sections: { key: string; label: string }[] = [
    { key: "nodes", label: "Действия" },
    { key: "flows", label: "Потоки" },
    { key: "roles", label: "Роли" },
    { key: "data", label: "Данные/документы" },
  ];
  const anyChange = sections.some((s) => diff[s.key] && (diff[s.key].added.length || diff[s.key].removed.length || diff[s.key].changed.length));
  if (!anyChange) return <p className="muted">Существенных изменений не обнаружено.</p>;
  return (
    <div>
      {sections.map(({ key, label }) => {
        const d = diff[key];
        if (!d || (!d.added.length && !d.removed.length && !d.changed.length)) return null;
        return (
          <div key={key} style={{ marginBottom: 6, fontSize: 13 }}>
            <strong>{label}:</strong>{" "}
            {d.added.length > 0 && <span style={{ color: "#2C7A57" }}>+{d.added.length} добавлено </span>}
            {d.removed.length > 0 && <span style={{ color: "#AD4130" }}>−{d.removed.length} удалено </span>}
            {d.changed.length > 0 && <span style={{ color: "#B87317" }}>~{d.changed.length} изменено</span>}
          </div>
        );
      })}
    </div>
  );
}
