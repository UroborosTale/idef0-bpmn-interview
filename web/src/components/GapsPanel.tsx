import { useEffect, useState } from "react";
import { api, type CriticalityScore } from "../api/client";
import type { Gap } from "../types";

const PRIORITY_LABEL: Record<string, string> = { critical: "Критично", important: "Важно", desirable: "Желательно" };
const ORDER: Record<string, number> = { critical: 0, important: 1, desirable: 2 };

/** ФТ-М4.5: адаптивная глубина — критичность участков процесса и точечный запрос уточнений по ним. */
function CriticalitySection({ sessionId, onChanged }: { sessionId: string; onChanged: () => void }) {
  const [scores, setScores] = useState<CriticalityScore[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState<number | null>(null);

  useEffect(() => {
    api.getCriticality(sessionId).then(setScores).catch(() => setScores([]));
  }, [sessionId]);

  const critical = (scores ?? []).filter((s) => s.score >= 1);
  if (!scores || critical.length === 0) return null;

  return (
    <div className="card" style={{ marginBottom: 14, background: "#f8fafc" }}>
      <div className="toolbar">
        <strong style={{ fontSize: 13 }}>Критичные участки процесса ({critical.length})</strong>
        <div className="spacer" />
        <button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await api.requestAdaptiveDepthGaps(sessionId);
              setAdded(r.added);
              onChanged();
            } finally {
              setBusy(false);
            }
          }}
        >
          Запросить уточнение критичных участков
        </button>
      </div>
      <p className="muted" style={{ fontSize: 12 }}>
        Критичность определена по признакам: деньги/оплата, сроки, внешние стороны, связь с требованиями СМК (или отмечена аналитиком вручную).
      </p>
      <ul style={{ fontSize: 12, margin: 0 }}>
        {critical.slice(0, 8).map((c) => (
          <li key={c.nodeId}>«{c.name}» — {c.reasons.join(", ")}</li>
        ))}
      </ul>
      {added !== null && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>Добавлено вопросов: {added}</div>}
    </div>
  );
}

export default function GapsPanel({
  gaps,
  onAnswer,
  onSelectElement,
  busy,
  sessionId,
  onChanged,
}: {
  gaps: Gap[];
  onAnswer: (gapId: string, text: string) => Promise<void>;
  onSelectElement: (id: string | null) => void;
  busy: boolean;
  sessionId: string;
  onChanged: () => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [showAll, setShowAll] = useState(false);

  const open = gaps.filter((g) => g.status === "open").sort((a, b) => ORDER[a.priority] - ORDER[b.priority]);
  const other = gaps.filter((g) => g.status !== "open");

  return (
    <div>
      <CriticalitySection sessionId={sessionId} onChanged={onChanged} />
      {gaps.length === 0 && <p className="muted">Пробелов не выявлено.</p>}
      {gaps.length > 0 && open.length === 0 && <p className="muted">Открытых пробелов нет — по правилам полноты модель выглядит целостной.</p>}
      {open.map((g) => (
        <div key={g.id} className="gap-item">
          <div className={`prio prio-${g.priority}`}>{PRIORITY_LABEL[g.priority]}</div>
          <div>
            {g.question}
            {g.element_id && (
              <>
                {" "}
                <a onClick={() => onSelectElement(g.element_id)} style={{ cursor: "pointer" }}>
                  [показать элемент]
                </a>
              </>
            )}
          </div>
          <div className="answer-row">
            <input
              placeholder="Ответ владельца процесса…"
              value={drafts[g.id] ?? ""}
              onChange={(e) => setDrafts((d) => ({ ...d, [g.id]: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === "Enter" && drafts[g.id]?.trim()) {
                  onAnswer(g.id, drafts[g.id].trim());
                  setDrafts((d) => ({ ...d, [g.id]: "" }));
                }
              }}
            />
            <button
              disabled={busy || !drafts[g.id]?.trim()}
              onClick={() => {
                onAnswer(g.id, drafts[g.id].trim());
                setDrafts((d) => ({ ...d, [g.id]: "" }));
              }}
            >
              Ответить
            </button>
          </div>
        </div>
      ))}
      {other.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <button onClick={() => setShowAll((v) => !v)}>{showAll ? "Скрыть закрытые пробелы" : `Показать закрытые (${other.length})`}</button>
          {showAll &&
            other.map((g) => (
              <div key={g.id} className="gap-item" style={{ opacity: 0.6 }}>
                <div className={`prio prio-${g.priority}`}>{PRIORITY_LABEL[g.priority]}</div>
                <div>{g.question}</div>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
