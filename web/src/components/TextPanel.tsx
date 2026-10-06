import { useEffect, useRef } from "react";
import type { Fragment } from "../types";

const SPEAKER_LABEL: Record<string, string> = {
  interviewer: "Интервьюер",
  owner: "Владелец процесса",
  participant: "Участник",
  unknown: "—",
};

export default function TextPanel({ fragments, highlightId }: { fragments: Fragment[]; highlightId: string | null }) {
  const refs = useRef<Record<string, HTMLDivElement | null>>({});

  useEffect(() => {
    if (highlightId && refs.current[highlightId]) {
      refs.current[highlightId]!.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [highlightId]);

  if (fragments.length === 0) {
    return <p className="muted">Текст интервью ещё не загружен.</p>;
  }

  return (
    <div>
      {fragments.map((f) => (
        <div
          key={f.id}
          ref={(el) => (refs.current[f.id] = el)}
          className={`fragment ${f.speaker} ${highlightId === f.id ? "highlighted" : ""}`}
        >
          <div className="label">
            [{f.id}] {f.speaker_label || SPEAKER_LABEL[f.speaker]}
          </div>
          <div>{f.text}</div>
        </div>
      ))}
    </div>
  );
}
