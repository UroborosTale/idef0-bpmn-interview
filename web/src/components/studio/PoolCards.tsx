import type { ProcessLogicModel } from "../../types";
import { CommitInput, Field } from "../editor-core/fields";
import { deleteMessage, deletePool, updateMessage, updatePool } from "../bpmn-editor/model-ops";
import { Section } from "./PanelParts";
import { poolLabel } from "./MessagesEditor";

type M = ProcessLogicModel;

/** Карточка внешнего пула: название, код процесса, потоки сообщений с шагами, удаление (вместе с потоками). */
export function PoolCard({ model, id, onChange, onSelect, onGoto }: { model: M; id: string; onChange: (next: M) => void; onSelect: (sel: { kind: "message"; id: string }) => void; onGoto: (nodeId: string) => void }) {
  const pool = (model.pools ?? []).find((p) => p.id === id);
  if (!pool) return <p className="muted prop-note">Пул удалён.</p>;
  const msgs = (model.messages ?? []).filter((m) => m.from === id || m.to === id);
  const nodeName = (nid: string) => model.nodes.find((n) => n.id === nid)?.name || nid;
  return (
    <div className="entry-card">
      <div className="prop-kind">
        Внешний пул · <span className="muted">другой процесс или участник</span>
      </div>
      <Section title="Общие">
        <Field label="Название">
          <CommitInput required value={pool.name} onCommit={(v) => onChange(updatePool(model, id, { name: v.trim() }))} />
        </Field>
        <Field label="Код процесса">
          <CommitInput value={pool.code ?? ""} placeholder="например, B002.02.01" onCommit={(v) => onChange(updatePool(model, id, { code: v.trim() || null }))} />
        </Field>
      </Section>
      <Section title="Потоки сообщений" count={msgs.length}>
        {msgs.length === 0 ? (
          <p className="muted prop-note">Потоков нет — пул без них на диаграмме не рисуется.</p>
        ) : (
          <div className="bpe-chips">
            {msgs.map((m) => {
              const out = m.to === id;
              const step = out ? m.from : m.to;
              return (
                <span key={m.id}>
                  <button className="usage-chip" onClick={() => onSelect({ kind: "message", id: m.id })} title="Открыть поток сообщений">
                    {out ? "→" : "←"} {m.name || "без названия"}
                  </button>{" "}
                  <button className="usage-chip" onClick={() => onGoto(step)} title="Перейти к шагу">
                    {nodeName(step)}
                  </button>
                </span>
              );
            })}
          </div>
        )}
      </Section>
      <div className="bpe-actions">
        <button className="danger" onClick={() => window.confirm(msgs.length ? `Удалить пул «${poolLabel(pool)}» и ${msgs.length} поток(ов) сообщений?` : `Удалить пул «${poolLabel(pool)}»?`) && onChange(deletePool(model, id))}>
          Удалить пул
        </button>
      </div>
    </div>
  );
}

/** Карточка потока сообщений: название, откуда и куда идёт, удаление. */
export function MessageCard({ model, id, onChange, onSelect, onGoto }: { model: M; id: string; onChange: (next: M) => void; onSelect: (sel: { kind: "pool"; id: string }) => void; onGoto: (nodeId: string) => void }) {
  const msg = (model.messages ?? []).find((m) => m.id === id);
  if (!msg) return <p className="muted prop-note">Поток сообщений удалён.</p>;
  const pools = model.pools ?? [];
  const end = (eid: string) => {
    const pool = pools.find((p) => p.id === eid);
    if (pool) return { label: poolLabel(pool), open: () => onSelect({ kind: "pool", id: eid }), what: "пул" };
    return { label: model.nodes.find((n) => n.id === eid)?.name || eid, open: () => onGoto(eid), what: "шаг" };
  };
  const [from, to] = [end(msg.from), end(msg.to)];
  return (
    <div className="entry-card">
      <div className="prop-kind">
        Поток сообщений · <span className="muted">BPMN</span>
      </div>
      <Section title="Общие">
        <Field label="Название сообщения">
          <CommitInput value={msg.name ?? ""} placeholder="например, Запрос предложений" onCommit={(v) => onChange(updateMessage(model, id, { name: v.trim() || null }))} />
        </Field>
        <Field label="Откуда">
          <button className="usage-chip" onClick={from.open} title={`Перейти: ${from.what}`}>
            {from.label}
          </button>
        </Field>
        <Field label="Куда">
          <button className="usage-chip" onClick={to.open} title={`Перейти: ${to.what}`}>
            {to.label}
          </button>
        </Field>
      </Section>
      <div className="bpe-actions">
        <button className="danger" onClick={() => onChange(deleteMessage(model, id))}>
          Удалить поток сообщений
        </button>
      </div>
    </div>
  );
}
