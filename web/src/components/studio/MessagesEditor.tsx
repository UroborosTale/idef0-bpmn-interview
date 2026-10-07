import { useState } from "react";
import type { ExternalPool, ProcessLogicModel } from "../../types";
import { CommitInput, Field } from "../editor-core/fields";
import { addMessage, addPool, deleteMessage, deletePool, updateMessage, updatePool } from "../bpmn-editor/model-ops";

type M = ProcessLogicModel;

export const poolLabel = (p: Pick<ExternalPool, "name" | "code">) => `${p.code ? `${p.code} ` : ""}${p.name}`;

/**
 * Потоки сообщений шага диаграммы с внешними пулами (Соглашение о моделировании: пулы других процессов по коду,
 * связанные потоками сообщений). Поток начинается у задачи «Отправка» или события-сообщения и приходит к пулу;
 * входящий поток идёт от пула к задаче «Получение» или событию-сообщению.
 */
export default function MessagesEditor({ model, nodeId, onChange }: { model: M; nodeId: string; onChange: (next: M) => void }) {
  const [direction, setDirection] = useState<"out" | "in">("out");
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const pools = model.pools ?? [];
  const mine = (model.messages ?? []).filter((m) => m.from === nodeId || m.to === nodeId);
  const poolOf = (id: string) => pools.find((p) => p.id === id);

  const attach = (poolId: string, base: M = model) => {
    const r = direction === "out" ? addMessage(base, nodeId, poolId) : addMessage(base, poolId, nodeId);
    if (!r.error) onChange(r.model);
  };
  const createPool = () => {
    if (!name.trim()) return;
    const p = addPool(model, name, code);
    attach(p.id!, p.model);
    setCreating(false);
    setName("");
    setCode("");
  };

  return (
    <div className="assignments">
      {mine.length === 0 && <p className="muted prop-note">Потоков сообщений нет.</p>}
      {mine.map((m) => {
        const out = m.from === nodeId;
        const pool = poolOf(out ? m.to : m.from);
        return (
          <div key={m.id} className="assignment">
            <div className="assignment-head">
              <span className="muted" style={{ whiteSpace: "nowrap" }}>
                {out ? "→ отправляет в" : "← получает из"}
              </span>
              <b className="message-pool" title={pool ? poolLabel(pool) : ""}>
                {pool ? poolLabel(pool) : "пул удалён"}
              </b>
              <button className="bpe-chip-x" title="Убрать поток сообщений" onClick={() => onChange(deleteMessage(model, m.id))}>
                ×
              </button>
            </div>
            <CommitInput value={m.name ?? ""} placeholder="Название сообщения" onCommit={(v) => onChange(updateMessage(model, m.id, { name: v.trim() || null }))} />
          </div>
        );
      })}
      {creating ? (
        <div className="assignment">
          <Field label="Название внешнего процесса или участника">
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => (e.stopPropagation(), e.key === "Enter" && createPool())} />
          </Field>
          <Field label="Код процесса (необязательно)">
            <input value={code} placeholder="B002.02.01" onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => (e.stopPropagation(), e.key === "Enter" && createPool())} />
          </Field>
          <div className="bpe-actions" style={{ marginTop: 4 }}>
            <button onClick={createPool} disabled={!name.trim()}>
              Создать и связать
            </button>
            <button onClick={() => setCreating(false)}>Отмена</button>
          </div>
        </div>
      ) : (
        <div className="assignment-head">
          <select value={direction} aria-label="Направление сообщения" onChange={(e) => setDirection(e.target.value as "out" | "in")}>
            <option value="out">Отправляет в…</option>
            <option value="in">Получает из…</option>
          </select>
          <select
            value=""
            aria-label="Внешний пул"
            onChange={(e) => {
              if (e.target.value === "__new__") setCreating(true);
              else if (e.target.value) attach(e.target.value);
            }}
          >
            <option value="">＋ внешний пул…</option>
            {pools.map((p) => (
              <option key={p.id} value={p.id}>
                {poolLabel(p)}
              </option>
            ))}
            <option value="__new__">✎ Новый пул…</option>
          </select>
        </div>
      )}
    </div>
  );
}

/** Внешние пулы процесса: название и код, число потоков сообщений, удаление (вместе с потоками). */
export function PoolsEditor({ model, onChange }: { model: M; onChange: (next: M) => void }) {
  const pools = model.pools ?? [];
  const count = (id: string) => (model.messages ?? []).filter((m) => m.from === id || m.to === id).length;
  return (
    <div className="assignments">
      {pools.length === 0 && <p className="muted prop-note">Внешних пулов нет. Пул создаётся из потока сообщений шага диаграммы BPMN.</p>}
      {pools.map((p) => (
        <div key={p.id} className="assignment">
          <div className="assignment-head">
            <CommitInput required value={p.name} onCommit={(v) => onChange(updatePool(model, p.id, { name: v.trim() }))} />
            <button
              className="bpe-chip-x"
              title={count(p.id) > 0 ? `Удалить пул и ${count(p.id)} поток(ов) сообщений` : "Удалить пул"}
              onClick={() => onChange(deletePool(model, p.id))}
            >
              ×
            </button>
          </div>
          <CommitInput value={p.code ?? ""} placeholder="Код процесса, например B002.02.01" onCommit={(v) => onChange(updatePool(model, p.id, { code: v.trim() || null }))} />
          <span className="muted" style={{ fontSize: 11 }}>
            Потоков сообщений: {count(p.id)}
          </span>
        </div>
      ))}
    </div>
  );
}
