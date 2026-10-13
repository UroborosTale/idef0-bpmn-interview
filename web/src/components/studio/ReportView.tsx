import type { ProcessLogicModel, SessionRecord } from "../../types";
import RegulationPanel from "../RegulationPanel";
import JobDescriptionsPanel from "../JobDescriptionsPanel";
import type { ReportKind } from "./docs";
import PassportView from "./PassportView";
import RaciMatrix from "./RaciMatrix";
import StatusScheme from "./StatusScheme";

type M = ProcessLogicModel;

/**
 * Отчёты окна студии: паспорт процесса и матрица RACI строятся по текущему черновику прямо в браузере;
 * регламент и должностные инструкции формирует сервер — по сохранённой версии модели.
 */
export default function ReportView({
  kind,
  session,
  model,
  dirty,
  onChange,
  onSave,
  filterSet = null,
  onClearFilter,
}: {
  /** Активный набор объектов: матрица RACI строится по его функциям. */
  filterSet?: { id: string; name: string; nodeIds: Set<string> } | null;
  onClearFilter?: () => void;
  kind: ReportKind;
  session: SessionRecord;
  model: M;
  dirty: boolean;
  onChange: (next: M) => void;
  onSave: () => void;
}) {
  if (kind === "passport") return <PassportView model={model} onChange={onChange} />;
  if (kind === "statuses") return <StatusScheme model={model} />;
  if (kind === "raci") return <RaciMatrix model={model} dirty={dirty} sessionId={session.id} onChange={onChange} filterSet={filterSet} onClearFilter={onClearFilter} />;

  // серверные отчёты: до сохранения они показали бы старую модель
  if (dirty) {
    return (
      <div className="report-gate">
        <p>
          Этот отчёт формирует сервер по <b>сохранённой</b> версии модели, а в студии есть несохранённые изменения.
        </p>
        <button className="primary" onClick={onSave}>
          Сохранить и показать отчёт
        </button>
      </div>
    );
  }
  return (
    <div className="report-server">
      {kind === "regulation" && <RegulationPanel session={session} />}
      {kind === "jobs" && <JobDescriptionsPanel session={session} />}
    </div>
  );
}
