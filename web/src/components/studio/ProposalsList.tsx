import { useMemo, useState } from "react";
import { validateModel } from "@shared/validate";
import { applyPatch, describePatch, issueDelta } from "@shared/patch";
import type { Proposal } from "../../api/client";
import type { ProcessLogicModel } from "../../types";

/**
 * Предложения агентов (Cline): что изменится, как изменятся проверки, можно ли применить к текущему черновику.
 * Агент только предлагает; «Применить» кладёт правки в черновик студии (их можно отменить Ctrl+Z и сохранить как обычно),
 * «Отклонить» сообщает агенту причину.
 */
export default function ProposalsList({
  model,
  proposals,
  onApply,
  onReject,
}: {
  model: ProcessLogicModel;
  proposals: Proposal[];
  onApply: (p: Proposal) => void | Promise<void>;
  onReject: (p: Proposal, reason: string) => void | Promise<void>;
}) {
  const before = useMemo(() => validateModel(model), [model]);
  if (proposals.length === 0) {
    return <div className="muted problems-empty">Предложений от агентов нет. Агент (Cline) присылает правки через MCP-сервер процессной модели — они появятся здесь.</div>;
  }
  return (
    <>
      {proposals.map((p) => (
        <ProposalCard key={p.id} proposal={p} model={model} before={before} onApply={onApply} onReject={onReject} />
      ))}
    </>
  );
}

function ProposalCard({
  proposal: p,
  model,
  before,
  onApply,
  onReject,
}: {
  proposal: Proposal;
  model: ProcessLogicModel;
  before: ReturnType<typeof validateModel>;
  onApply: (p: Proposal) => void | Promise<void>;
  onReject: (p: Proposal, reason: string) => void | Promise<void>;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const { lines, errors, delta } = useMemo(() => {
    const r = applyPatch(model, p.patch);
    return {
      lines: describePatch(model, p.patch),
      errors: r.errors,
      delta: r.errors.length === 0 ? issueDelta(before, validateModel(r.model)) : null,
    };
  }, [model, before, p.patch]);

  const run = async (fn: () => void | Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="proposal" data-proposal-id={p.id}>
      <div className="proposal-head">
        <b>{p.title}</b>
        <span className="agent-badge">{p.agent}</span>
        {p.stale && (
          <span className="agent-badge stale" title="Модель сохраняли после того, как агент подготовил предложение">
            модель изменилась
          </span>
        )}
      </div>
      {p.rationale && <p className="proposal-why">{p.rationale}</p>}
      <ul className="proposal-lines">
        {lines.map((l, i) => (
          <li key={i}>{l}</li>
        ))}
      </ul>
      {errors.length > 0 ? (
        <div className="validation-item error">
          Нельзя применить к текущему черновику:
          <ul>
            {errors.map((e, i) => (
              <li key={i}>{e.message}</li>
            ))}
          </ul>
        </div>
      ) : (
        delta && (
          <div className="proposal-delta">
            <span className={delta.resolved.length ? "st-ok" : "muted"} title={delta.resolved.map((i) => i.message).join("\n")}>
              снимает замечаний: {delta.resolved.length}
            </span>
            <span className={delta.introduced.length ? "st-err" : "muted"} title={delta.introduced.map((i) => i.message).join("\n")}>
              вносит новых: {delta.introduced.length}
            </span>
          </div>
        )
      )}
      {rejecting ? (
        <div className="proposal-actions">
          <input autoFocus placeholder="Почему отклоняете — агент это увидит" value={reason} onChange={(e) => setReason(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
          <button disabled={busy} onClick={() => run(() => onReject(p, reason.trim()))}>
            Отклонить
          </button>
          <button onClick={() => setRejecting(false)}>Отмена</button>
        </div>
      ) : (
        <div className="proposal-actions">
          <button className="primary" disabled={busy || errors.length > 0} onClick={() => run(() => onApply(p))} title="Правки попадут в черновик: их можно отменить и сохранить как обычно">
            Применить
          </button>
          <button disabled={busy} onClick={() => setRejecting(true)}>
            Отклонить…
          </button>
        </div>
      )}
    </div>
  );
}
