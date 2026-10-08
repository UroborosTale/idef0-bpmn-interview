import { useEffect, useState } from "react";
import { api, type AgentRoleStats, type AgentStatsReport } from "../../api/client";

const pct = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)}%`);

/**
 * Подсказки по настройке инструкций: что в сводке говорит о том, что роль работает не так, как задумано. Только факты из цифр —
 * что именно дописать в инструкцию, решает человек по причинам отказа.
 */
export function statsHints(roles: AgentRoleStats[]): string[] {
  const out: string[] = [];
  for (const r of roles) {
    const p = r.proposals;
    const decided = p.applied + p.rejected;
    if (decided >= 5 && p.acceptance !== null && p.acceptance < 0.5) out.push(`«${r.role}»: принято меньше половины решённых предложений (${p.applied} из ${decided}) — прочитайте причины отказа и допишите в «Границы» или «Правила качества» этой роли.`);
    if (p.total >= 3 && p.introduced > p.resolved) out.push(`«${r.role}»: предложения вносят больше замечаний проверок, чем снимают (${p.introduced} против ${p.resolved}) — роль не смотрит на ответ propose_patch; усильте этот пункт инструкции.`);
    if (p.pending >= 10) out.push(`«${r.role}»: ${p.pending} предложений ждут решения — разберите их или попросите методолога не копить.`);
    const top = p.topReasons[0];
    if (top && top.count >= 2) out.push(`«${r.role}»: причина отказа повторяется ${top.count} раза — «${top.reason}». Это кандидат в правило инструкции.`);
    if (r.questions.added >= 5 && r.questions.answered === 0 && r.questions.dismissed >= Math.ceil(r.questions.added / 2)) out.push(`«${r.role}»: больше половины вопросов сняты без ответа (${r.questions.dismissed} из ${r.questions.added}) — вопросы не попадают в цель; проверьте формулировки и адресатов.`);
  }
  return out;
}

/**
 * Статистика работы агентов по ролям: по открытой сессии или по всем сессиям приложения. По ней настраивают инструкции ролей
 * после реальных запусков: где агент ошибается, что отклоняют и почему.
 */
export default function AgentStatsPanel({ sessionId }: { sessionId: string }) {
  const [all, setAll] = useState(false);
  const [report, setReport] = useState<AgentStatsReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    setError(null);
    api
      .agentStats(sessionId, all)
      .then((r) => alive && setReport(r))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [sessionId, all, tick]);

  const roles = report?.roles ?? [];
  const hints = statsHints(roles);
  return (
    <div className="agent-stats">
      <div className="task-form-row questions-bar">
        <span className="muted">Работа агентов по ролям — {all ? "по всем сессиям" : "по этой сессии"}</span>
        <span className="spacer" />
        <label className="problems-filter">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> по всем сессиям
        </label>
        <button onClick={() => setTick((n) => n + 1)}>Обновить</button>
      </div>
      {error && <div className="problems-empty">Не удалось получить сводку: {error}</div>}
      {!error && report && roles.length === 0 && <div className="muted problems-empty">Агенты пока ничего не присылали. Сводка появится после первых предложений, вопросов и отчётов.</div>}
      {hints.length > 0 && (
        <ul className="stats-hints" aria-label="Что стоит поправить в инструкциях">
          {hints.map((h) => (
            <li key={h}>{h}</li>
          ))}
        </ul>
      )}
      {roles.length > 0 && (
        <table className="report-findings stats-table">
          <thead>
            <tr>
              <th rowSpan={2}>Роль</th>
              <th colSpan={5}>Предложения</th>
              <th colSpan={2}>Замечания проверок</th>
              <th colSpan={2}>Задания</th>
              <th colSpan={3}>Вопросы</th>
              <th colSpan={2}>Отчёты</th>
            </tr>
            <tr>
              <th>всего</th>
              <th>ждут</th>
              <th>применено</th>
              <th>отклонено</th>
              <th>принято</th>
              <th>вносят</th>
              <th>снимают</th>
              <th>взято</th>
              <th>выполнено</th>
              <th>сохранено</th>
              <th>с ответом</th>
              <th>сняты</th>
              <th>всего</th>
              <th>выводов</th>
            </tr>
          </thead>
          <tbody>
            {roles.map((r) => (
              <tr key={r.role} data-role={r.role}>
                <td>
                  <strong>{r.role}</strong>
                </td>
                <td>{r.proposals.total}</td>
                <td>{r.proposals.pending}</td>
                <td>{r.proposals.applied}</td>
                <td>{r.proposals.rejected}</td>
                <td>{pct(r.proposals.acceptance)}</td>
                <td>{r.proposals.introduced}</td>
                <td>{r.proposals.resolved}</td>
                <td>{r.tasks.taken}</td>
                <td>{r.tasks.done}</td>
                <td>{r.questions.added}</td>
                <td>{r.questions.answered}</td>
                <td>{r.questions.dismissed}</td>
                <td>{r.reports.total}</td>
                <td>{r.reports.findings}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {roles.some((r) => r.proposals.topReasons.length > 0) && (
        <div className="stats-reasons">
          <div className="muted">Частые причины отказа</div>
          {roles
            .filter((r) => r.proposals.topReasons.length > 0)
            .map((r) => (
              <div key={r.role}>
                <strong>{r.role}</strong>
                <ul>
                  {r.proposals.topReasons.map((x) => (
                    <li key={x.reason}>
                      {x.reason} <span className="muted">× {x.count}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}