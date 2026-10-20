import type { ProcessLogicModel, RaciEntry } from "../../types";
import { api } from "../../api/client";
import { idef0Codes } from "../idef0-editor/geometry";

type M = ProcessLogicModel;
type RaciType = RaciEntry["type"];

const TYPES: RaciType[] = ["R", "A", "C", "I"];
const TITLE: Record<RaciType, string> = { R: "Исполняет (Responsible)", A: "Отвечает (Accountable) — ровно один на функцию", C: "Согласовывает (Consulted)", I: "Уведомляется (Informed)" };

/**
 * Матрица RACI по функциям и исполнителям — правится на текущем черновике. Правила: на каждую функцию
 * ровно один «A» и хотя бы один «R»; нарушения подсвечиваются.
 */
export default function RaciMatrix({
  model,
  dirty,
  sessionId,
  onChange,
  filterSet = null,
  onClearFilter,
}: {
  model: M;
  dirty: boolean;
  sessionId: string;
  onChange: (next: M) => void;
  /** Отчёт по набору объектов: только функции набора; xlsx тоже по набору. */
  filterSet?: { id: string; name: string; nodeIds: Set<string> } | null;
  onClearFilter?: () => void;
}) {
  const codes = idef0Codes(model);
  const fns = [...codes.keys()].map((id) => model.nodes.find((n) => n.id === id)!).filter((n) => n && (!filterSet || filterSet.nodeIds.has(n.id)));
  const has = (nodeId: string, roleId: string, t: RaciType) => model.raci.some((r) => r.node_id === nodeId && r.role_id === roleId && r.type === t);
  const count = (nodeId: string, t: RaciType) => model.raci.filter((r) => r.node_id === nodeId && r.type === t).length;

  const toggle = (nodeId: string, roleId: string, t: RaciType) => {
    const exists = has(nodeId, roleId, t);
    onChange({
      ...model,
      raci: exists ? model.raci.filter((r) => !(r.node_id === nodeId && r.role_id === roleId && r.type === t)) : [...model.raci, { node_id: nodeId, role_id: roleId, type: t }],
    });
  };

  /** Заготовка по исполнителям функций: исполнитель — «R», а если «A» не назначен — и «A». Существующие отметки не трогаются. */
  const fill = () => {
    const next = [...model.raci];
    for (const n of fns) {
      if (!n.role_id) continue;
      if (!next.some((r) => r.node_id === n.id && r.role_id === n.role_id && r.type === "R")) next.push({ node_id: n.id, role_id: n.role_id, type: "R" });
      if (!next.some((r) => r.node_id === n.id && r.type === "A")) next.push({ node_id: n.id, role_id: n.role_id, type: "A" });
    }
    onChange({ ...model, raci: next });
  };

  const problems = fns.filter((n) => count(n.id, "A") !== 1 || count(n.id, "R") === 0);

  return (
    <div className="raci">
      <div className="passport-bar">
        <h4>Матрица RACI{filterSet ? ` — набор «${filterSet.name}»` : ""}</h4>
        {filterSet && (
          <button className="link-button" data-raci-filter onClick={onClearFilter}>
            Показать все функции
          </button>
        )}
        <span className="muted">
          {problems.length === 0 ? "Правила соблюдены." : `Нарушены правила у ${problems.length} функц.: нужен ровно один A и хотя бы один R.`}
        </span>
        <span className="spacer" />
        <button onClick={fill} title="Добавить R и A по исполнителю функции там, где отметок нет">
          Заполнить по исполнителям
        </button>
        <a href={dirty ? undefined : api.raciExportXlsxUrl(sessionId, filterSet?.id)} download className={dirty ? "disabled-link" : ""} title={dirty ? "Экспортируется сохранённая версия — сначала сохраните" : undefined}>
          <button disabled={dirty}>Экспорт .xlsx</button>
        </a>
      </div>
      {model.roles.length === 0 || fns.length === 0 ? (
        <p className="muted" style={{ padding: 14 }}>
          Нужны исполнители и функции, чтобы построить матрицу.
        </p>
      ) : (
        <div className="raci-scroll">
          <table className="raci-table">
            <thead>
              <tr>
                <th className="sticky">Функция</th>
                {model.roles.map((r) => (
                  <th key={r.id}>{r.name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {fns.map((n) => {
                const bad = count(n.id, "A") !== 1 || count(n.id, "R") === 0;
                return (
                  <tr key={n.id} className={bad ? "raci-bad" : ""}>
                    <td className="sticky">
                      <span className="nav-code">{codes.get(n.id)}</span> {n.name}
                    </td>
                    {model.roles.map((r) => (
                      <td key={r.id}>
                        <div className="raci-cell">
                          {TYPES.map((t) => (
                            <button key={t} title={TITLE[t]} className={has(n.id, r.id, t) ? `on ${t}` : ""} onClick={() => toggle(n.id, r.id, t)}>
                              {t}
                            </button>
                          ))}
                        </div>
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
