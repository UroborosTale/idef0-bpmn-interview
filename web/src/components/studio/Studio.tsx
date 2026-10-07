import { useEffect, useMemo, useRef, useState } from "react";
import { validateModel } from "@shared/validate";
import { api } from "../../api/client";
import type { ProcessLogicModel, SessionRecord, ValidationIssue } from "../../types";
import { handleCommonKeys, isTextInput, useBeforeUnload, useDraftPersistence, useModelHistory } from "../editor-core/hooks";
import { DraftBanner } from "../editor-core/fields";
import BpmnEditor from "../bpmn-editor/BpmnEditor";
import Idef0Editor from "../idef0-editor/Idef0Editor";
import { positionsFromBpmnXml, visibleNodes, withLayout } from "../bpmn-editor/geometry";
import { functionsOf, withIdef0Layout } from "../idef0-editor/geometry";
import { addFunction } from "../idef0-editor/ops";
import Navigator from "./Navigator";
import ProblemsPanel from "./ProblemsPanel";
import DictionaryView from "./DictionaryView";
import ReportView from "./ReportView";
import PropertiesPanel from "./PropertiesPanel";
import type { Selection } from "./selection";
import { bpmnDoc, docIsStale, docTitle, idef0Doc, type StudioDoc } from "./docs";

type M = ProcessLogicModel;

const seed = (m: M, bpmnXml: string | null | undefined): M => withIdef0Layout(withLayout(m, false, positionsFromBpmnXml(bpmnXml)));

/**
 * Окно студии: единое рабочее место процессного аналитика в духе Business Studio. Слева навигатор
 * (процессы, справочники, отчёты), в центре вкладки-документы (диаграммы BPMN и IDEF0, справочники,
 * отчёты), снизу проверки, сверху лента команд. Вся модель — одна: общая история правок, одно сохранение.
 */
export default function Studio({ session, busy, onSave }: { session: SessionRecord; busy: boolean; onSave: (m: M) => Promise<boolean> }) {
  const model = session.model!;
  const h = useModelHistory<M>(() => seed(model, session.bpmnXml));
  const draft = h.draft;
  const persisted = useDraftPersistence<M>({ id: `${session.id}:studio`, base: session.updatedAt, draft, dirty: h.dirty, restore: (m) => h.setDraft(m) });
  useBeforeUnload(h.dirty);

  // Модель на сервере изменилась не из этого окна (повторная обработка, откат версии) — подхватываем, если нет несохранённых правок.
  const lastModel = useRef(model);
  useEffect(() => {
    if (lastModel.current === model) return;
    lastModel.current = model;
    if (!h.dirty) {
      const s = seed(model, session.bpmnXml);
      h.setDraft(s);
      h.markSaved(s);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model]);

  const [docs, setDocs] = useState<StudioDoc[]>(() => [bpmnDoc(), idef0Doc(null)]);
  const [activeKey, setActiveKey] = useState("bpmn");
  const [focus, setFocus] = useState<{ id: string; nonce: number } | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [navOpen, setNavOpen] = useState(true);
  const [propsOpen, setPropsOpen] = useState(true);
  const [problemsOpen, setProblemsOpen] = useState(true);
  const nonce = useRef(0);

  const liveDocs = docs.filter((d) => !docIsStale(d, draft));
  const active = liveDocs.find((d) => d.key === activeKey) ?? liveDocs[0] ?? bpmnDoc();
  const issues: ValidationIssue[] = useMemo(() => validateModel(draft), [draft]);
  const errors = issues.filter((i) => i.severity === "error").length;
  const warnings = issues.length - errors;

  /** Выделение принадлежит документу: при смене вкладки панель возвращается к свойствам процесса, пока документ не сообщит своё. */
  const activate = (key: string) => {
    if (key !== activeKey) setSelection(null);
    setActiveKey(key);
  };
  const open = (doc: StudioDoc) => {
    setDocs((ds) => (ds.some((d) => d.key === doc.key) ? ds : [...ds, doc]));
    activate(doc.key);
  };
  const close = (key: string) => {
    const rest = liveDocs.filter((d) => d.key !== key);
    if (rest.length === 0) return; // последний документ остаётся
    setDocs(rest);
    if (active.key === key) activate(rest[Math.max(0, liveDocs.findIndex((d) => d.key === key) - 1)].key);
  };
  const goto = (id: string) => setFocus({ id, nonce: ++nonce.current });

  /** Выделить функцию: в открытой диаграмме BPMN — если она там есть, иначе на её диаграмме IDEF0. */
  const selectFn = (id: string) => {
    const n = draft.nodes.find((x) => x.id === id);
    if (!n) return;
    if (active.kind === "bpmn" && !n.idef0_parent) {
      setSelection({ kind: "node", id });
      goto(id);
      return;
    }
    open(idef0Doc(n.idef0_parent ?? null));
    setSelection({ kind: "node", id });
    goto(id);
  };

  /** Показать элемент на диаграмме выбранной нотации (из панели свойств). */
  const reveal = (id: string, where: "bpmn" | "idef0") => {
    const n = draft.nodes.find((x) => x.id === id);
    if (!n) return;
    open(where === "bpmn" ? bpmnDoc() : idef0Doc(n.idef0_parent ?? null));
    setSelection({ kind: "node", id });
    goto(id);
  };

  /** Выделение изменилось на диаграмме: одинаковое не перезаписываем, чтобы не гонять лишние перерисовки. */
  const reportSelection = (s: Selection) =>
    setSelection((prev) => {
      if (!s && !prev) return prev;
      if (s && prev && s.kind === prev.kind && !prev.back) {
        if (s.kind === "arrow" && prev.kind === "arrow" && s.arrow.key === prev.arrow.key) return prev;
        if (s.kind === "entry" && prev.kind === "entry" && s.dict === prev.dict && s.id === prev.id) return prev;
        if ((s.kind === "node" || s.kind === "flow") && "id" in prev && s.id === prev.id) return prev;
      }
      return s;
    });

  /** Переход к элементу из списка проверок: нужная диаграмма и выделение. */
  const gotoIssue = ({ elementId, notation }: { elementId: string | null; notation: ValidationIssue["notation"] }) => {
    const n = elementId ? draft.nodes.find((x) => x.id === elementId) : undefined;
    const isRole = !!elementId && draft.roles.some((r) => r.id === elementId);
    if (notation === "IDEF0" && n) {
      open(idef0Doc(n.idef0_parent ?? null));
      setSelection({ kind: "node", id: n.id });
      goto(n.id);
    } else if (notation === "IDEF0") {
      open(idef0Doc(null));
    } else if (n && !n.idef0_parent) {
      open(bpmnDoc());
      setSelection({ kind: "node", id: n.id });
      goto(n.id);
    } else if (elementId && (isRole || draft.flows.some((f) => f.id === elementId))) {
      open(bpmnDoc());
      goto(elementId);
    } else if (n) {
      open(idef0Doc(n.idef0_parent ?? null));
      goto(n.id);
    } else {
      open(bpmnDoc());
    }
  };

  const addFn = (parentId: string | null) => {
    const r = addFunction(h.draftRef.current, parentId, 300, 300);
    h.commit(r.model);
    open(idef0Doc(parentId));
    setSelection({ kind: "node", id: r.id! });
    goto(r.id!);
  };

  /** Переход по декомпозиции внутри вкладки IDEF0: вкладка показывает другую диаграмму. */
  const navigateIdef0 = (fromKey: string, parent: string | null) => {
    const next = idef0Doc(parent);
    setDocs((ds) => {
      const without = ds.filter((d) => d.key !== fromKey);
      return without.some((d) => d.key === next.key) ? without : ds.map((d) => (d.key === fromKey ? next : d));
    });
    setActiveKey(next.key); // выделение сохраняем: это тот же редактор, он сам сообщит новое
  };

  const save = async () => {
    const snapshot = h.draftRef.current;
    if (await onSave(snapshot)) h.markSaved(snapshot);
  };

  // История и сохранение вне редакторов диаграмм
  const onKeyDown = (e: React.KeyboardEvent) => {
    // диаграммы обрабатывают клавиши сами; остальное (справочники, отчёты, панель свойств) — здесь
    if ((e.target as Element).closest?.(".bpe") || isTextInput(e.target)) return;
    handleCommonKeys(e, { undo: h.undo, redo: h.redo, save: () => h.dirty && !busy && void save() });
  };

  const exportLink = (label: string, path: string) => (
    <a key={path} href={api.exportUrl(session.id, path)} target="_blank" rel="noreferrer" className={h.dirty ? "disabled-link" : ""} onClick={(e) => h.dirty && e.preventDefault()} title={h.dirty ? "Экспортируется сохранённая версия — сначала сохраните" : undefined}>
      {label}
    </a>
  );

  const shown = visibleNodes(draft);
  const fnCount = draft.nodes.filter((n) => n.type === "task" || n.type === "subprocess").length;

  return (
    <div className="studio" onKeyDown={onKeyDown}>
      <DraftBanner
        restored={persisted.restored}
        stale={persisted.stale}
        onDiscard={() => {
          h.discard();
          persisted.forget();
        }}
        onDismiss={persisted.dismiss}
        onRestoreStale={persisted.restoreStale}
      />

      <div className="ribbon">
        <div className="ribbon-group">
          <div className="ribbon-buttons">
            <button className="primary" disabled={!h.dirty || busy} onClick={() => void save()} title="Сохранить (Ctrl+S)">
              {busy ? "Сохранение…" : "Сохранить"}
            </button>
            <button disabled={!h.canUndo} onClick={h.undo} title="Отменить (Ctrl+Z)">
              ↶ Отменить
            </button>
            <button disabled={!h.canRedo} onClick={h.redo} title="Повторить (Ctrl+Y)">
              ↷ Повторить
            </button>
          </div>
          <div className="ribbon-caption">Файл</div>
        </div>
        <div className="ribbon-group">
          <div className="ribbon-buttons">
            <button onClick={() => open(bpmnDoc())}>Диаграмма BPMN</button>
            <button onClick={() => open(idef0Doc(null))}>Диаграмма IDEF0</button>
            <button onClick={() => addFn(active.kind === "idef0" ? active.parent : null)} title="Добавить функцию на текущую диаграмму IDEF0 (A0, если открыта другая вкладка)">
              + Функция
            </button>
          </div>
          <div className="ribbon-caption">Модель</div>
        </div>
        <div className="ribbon-group">
          <div className="ribbon-buttons">
            <button className={navOpen ? "toggled" : ""} onClick={() => setNavOpen(!navOpen)}>
              Навигатор
            </button>
            <button className={propsOpen ? "toggled" : ""} onClick={() => setPropsOpen(!propsOpen)}>
              Свойства
            </button>
            <button className={problemsOpen ? "toggled" : ""} onClick={() => setProblemsOpen(!problemsOpen)}>
              Проверки{errors + warnings > 0 ? ` (${errors + warnings})` : ""}
            </button>
          </div>
          <div className="ribbon-caption">Вид</div>
        </div>
        <div className="ribbon-group">
          <div className="ribbon-buttons ribbon-links">
            {exportLink("BPMN", "bpmn")}
            {exportLink("IDEF0 (SVG)", "idef0/decomposition.svg")}
            {exportLink("Visio", "vsdx")}
            {exportLink("Модель (JSON)", "model.json")}
          </div>
          <div className="ribbon-caption">Выгрузка</div>
        </div>
      </div>

      <div className="studio-body" style={{ gridTemplateColumns: `${navOpen ? "270px " : ""}minmax(0, 1fr)${propsOpen ? " 340px" : ""}` }}>
        {navOpen && (
          <Navigator model={draft} activeKey={active.key} selectedId={selection?.kind === "node" ? selection.id : null} onOpenDoc={open} onSelectFn={selectFn} onAddFunction={addFn} />
        )}
        <div className="studio-main">
          <div className="doc-tabs" role="tablist">
            {liveDocs.map((d) => (
              <div key={d.key} role="tab" aria-selected={d.key === active.key} className={`doc-tab ${d.key === active.key ? "active" : ""}`} onClick={() => activate(d.key)}>
                {docTitle(d, draft)}
                {liveDocs.length > 1 && (
                  <button
                    className="doc-close"
                    title="Закрыть вкладку"
                    onClick={(e) => {
                      e.stopPropagation();
                      close(d.key);
                    }}
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
          </div>
          <div className="doc-area">
            {active.kind === "bpmn" && (
              <BpmnEditor key="bpmn" model={draft} busy={busy} onSave={onSave} draftId={`${session.id}:studio`} draftBase={session.updatedAt} bpmnXml={session.bpmnXml} history={h} focus={focus} onSelectionChange={reportSelection} />
            )}
            {active.kind === "idef0" && (
              <Idef0Editor
                key={active.key}
                model={draft}
                busy={busy}
                onSave={onSave}
                draftId={`${session.id}:studio`}
                draftBase={session.updatedAt}
                history={h}
                focus={focus}
                onSelectionChange={reportSelection}
                parentId={active.parent}
                onParentChange={(p) => navigateIdef0(active.key, p)}
              />
            )}
            {active.kind === "dict" && (
              <DictionaryView
                key={active.key}
                kind={active.dict}
                model={draft}
                selectedId={selection?.kind === "entry" && selection.dict === active.dict ? selection.id : null}
                onSelect={(id) => setSelection({ kind: "entry", dict: active.dict, id })}
                onChange={h.commit}
                onGoto={(id) => gotoIssue({ elementId: id, notation: "BPMN" })}
              />
            )}
            {active.kind === "report" && <ReportView key={active.key} kind={active.report} session={session} model={draft} dirty={h.dirty} onChange={h.commit} onSave={() => void save()} />}
          </div>
          {problemsOpen && <ProblemsPanel model={draft} issues={issues} onGoto={gotoIssue} />}
        </div>
        {propsOpen && (
          <PropertiesPanel
            model={draft}
            selection={selection}
            session={session}
            issues={issues}
            activeKind={active.kind}
            onChange={h.commit}
            onSelect={setSelection}
            onGoto={selectFn}
            onReveal={reveal}
            onOpenDecomposition={(id) => open(idef0Doc(id))}
            onOpenDoc={open}
            onClose={() => setPropsOpen(false)}
          />
        )}
      </div>

      <div className="statusbar">
        <span>
          <b>{draft.process.name}</b> · {draft.process.type} · версия {draft.process.version} · статус: {draft.process.status}
        </span>
        <span className="muted">
          функций {fnCount} · шагов BPMN {shown.length} · связей {draft.flows.length} · исполнителей {draft.roles.length}
        </span>
        <span className="spacer" />
        <span className={errors ? "st-err" : "muted"}>ошибок: {errors}</span>
        <span className="muted">предупреждений: {warnings}</span>
        <span className={h.dirty ? "st-dirty" : "st-ok"}>{h.dirty ? "● есть несохранённые изменения" : "✓ сохранено"}</span>
      </div>
    </div>
  );
}
