import type { ProcessLogicModel, ProcessMeta } from "../../types";
import { functionsOf, idef0Codes } from "../idef0-editor/geometry";

type M = ProcessLogicModel;

const STATUS: Record<ProcessMeta["status"], string> = { draft: "Черновик", review: "На согласовании", needs_rework: "На доработке", approved: "Утверждён", archived: "В архиве" };

/**
 * Паспорт процесса (аналог «Паспорта процесса» в Business Studio): атрибуты правятся здесь же,
 * остальное — входы и выходы процесса, исполнители, системы, регламенты, показатели, риски и
 * перечень функций — собирается из модели. Печать выводит только лист паспорта.
 */
export default function PassportView({ model, onChange }: { model: M; onChange: (next: M) => void }) {
  const p = model.process;
  const set = (patch: Partial<ProcessMeta>) => onChange({ ...model, process: { ...p, ...patch } });
  const codes = idef0Codes(model);
  const top = functionsOf(model, null);
  const name = (list: { id: string; name: string }[], id: string) => list.find((x) => x.id === id)?.name ?? id;

  // внешние входы и выходы процесса: данные верхнего уровня, не связанные другой функцией
  const produced = new Set(top.flatMap((n) => n.outputs));
  const consumed = new Set(top.flatMap((n) => [...n.inputs, ...(n.control_data_ids ?? [])]));
  const inputs = [...new Set(top.flatMap((n) => n.inputs).filter((d) => !produced.has(d)))];
  const outputs = [...new Set(top.flatMap((n) => n.outputs).filter((d) => !consumed.has(d)))];

  const field = (label: string, value: string | undefined | null, key: keyof ProcessMeta, multiline = false) => (
    <div className="passport-field">
      <label>{label}</label>
      {multiline ? (
        <textarea rows={2} value={value ?? ""} onChange={(e) => set({ [key]: e.target.value } as Partial<ProcessMeta>)} />
      ) : (
        <input value={value ?? ""} onChange={(e) => set({ [key]: e.target.value } as Partial<ProcessMeta>)} />
      )}
    </div>
  );
  const list = (title: string, rows: string[], empty = "не указано") => (
    <section className="passport-section">
      <h5>{title}</h5>
      {rows.length ? <ul>{rows.map((r, i) => <li key={i}>{r}</li>)}</ul> : <div className="muted">{empty}</div>}
    </section>
  );

  return (
    <div className="passport">
      <div className="passport-bar no-print">
        <h4>Паспорт процесса</h4>
        <span className="muted">Атрибуты можно править прямо здесь; остальное берётся из модели.</span>
        <span className="spacer" />
        <button onClick={() => window.print()}>Печать</button>
      </div>

      <div className="passport-sheet print-area">
        <h2 className="passport-title">Паспорт процесса «{p.name}»</h2>

        <div className="passport-grid">
          {field("Наименование", p.name, "name")}
          {field("Код процесса", p.code, "code")}
          {field("Владелец процесса", p.owner, "owner")}
          {field("Подразделение", p.department, "department")}
          <div className="passport-field">
            <label>Тип модели</label>
            <select value={p.type} onChange={(e) => set({ type: e.target.value as ProcessMeta["type"] })}>
              <option value="AS-IS">AS-IS (как есть)</option>
              <option value="TO-BE">TO-BE (как должно быть)</option>
            </select>
          </div>
          <div className="passport-field">
            <label>Уровень</label>
            <select value={p.level ?? ""} onChange={(e) => set({ level: (e.target.value || null) as ProcessMeta["level"] })}>
              <option value="">не задан</option>
              {["L0", "L1", "L2", "L3"].map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </div>
          <div className="passport-field">
            <label>Частота, раз в месяц</label>
            <input type="number" min={0} value={p.frequency_per_month ?? ""} onChange={(e) => set({ frequency_per_month: e.target.value === "" ? null : Number(e.target.value) })} />
          </div>
          <div className="passport-field">
            <label>Дата планового пересмотра</label>
            <input type="date" value={p.review_date ?? ""} onChange={(e) => set({ review_date: e.target.value || null })} />
          </div>
        </div>
        <div className="passport-grid one">
          {field("Цель процесса", p.goal, "goal", true)}
          {field("Событие, запускающее процесс", p.trigger, "trigger", true)}
          {field("Результат процесса", p.result, "result", true)}
        </div>
        <div className="passport-meta">
          Версия {p.version} · статус: {STATUS[p.status]}
        </div>

        <div className="passport-cols">
          {list("Входы процесса", inputs.map((d) => name(model.data, d)))}
          {list("Выходы процесса", outputs.map((d) => name(model.data, d)))}
          {list("Исполнители", model.roles.map((r) => `${r.name}${r.kind === "external" ? " (внешний)" : ""}`))}
          {list("Информационные системы", model.systems.map((s) => s.name))}
          {list("Регламенты и нормы", model.controls.map((c) => c.name))}
          {list(
            "Показатели (KPI)",
            p.kpi.map((k) => `${k.name}${k.target ? ` — цель ${k.target}${k.unit ? ` ${k.unit}` : ""}` : ""}`)
          )}
          {list(
            "Риски",
            p.risks.map((r) => `${r.name}${r.mitigation ? ` — ${r.mitigation}` : ""}`)
          )}
        </div>

        <section className="passport-section">
          <h5>Перечень функций</h5>
          <table className="passport-table">
            <thead>
              <tr>
                <th style={{ width: 60 }}>Код</th>
                <th>Функция</th>
                <th style={{ width: 160 }}>Исполнитель</th>
                <th style={{ width: 160 }}>Системы</th>
                <th style={{ width: 90 }}>Длительность</th>
              </tr>
            </thead>
            <tbody>
              {[...codes.entries()]
                .map(([id, code]) => ({ n: model.nodes.find((x) => x.id === id)!, code }))
                .filter((r) => r.n)
                .map(({ n, code }) => (
                  <tr key={n.id}>
                    <td>{code}</td>
                    <td style={{ paddingLeft: 6 + (code.length - 2) * 10 }}>{n.name}</td>
                    <td>{n.role_id ? name(model.roles, n.role_id) : "—"}</td>
                    <td>{n.system_ids.length ? n.system_ids.map((s) => name(model.systems, s)).join(", ") : "—"}</td>
                    <td>{n.duration ?? "—"}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}
