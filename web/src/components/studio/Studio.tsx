import { loadDisplay, saveDisplay, type DisplayOptions } from "../editor-core/display";
import { deleteDiagramImpact } from "./usage-ops";
import { addEntryToSet, addToSet, createSet, deleteSet, removeEntryFromSet, removeFromSet, renameSet } from "./set-ops";
import { setNodeIds } from "@shared/objectSets";
import { useEffect, useMemo, useRef, useState } from "react";
import { splitAccepted, validateModel } from "@shared/validate";
import { bpmnHosts, functionCodes, stepCodes } from "@shared/codes";
import { applyPatch } from "@shared/patch";
import { api, type AgentQuestionRow, type AgentReportRow, type AgentTaskRow, type Proposal, type ReportFinding } from "../../api/client";
import type { ProcessLogicModel, ProcessNode, SessionRecord, ValidationIssue } from "../../types";
import { handleCommonKeys, isTextInput, useBeforeUnload, useDraftPersistence, useModelHistory } from "../editor-core/hooks";
import { DraftBanner } from "../editor-core/fields";
import BpmnEditor from "../bpmn-editor/BpmnEditor";
import Idef0Editor from "../idef0-editor/Idef0Editor";
import { positionsFromBpmnXml, visibleNodes, withLayout, withScopeLayouts } from "../bpmn-editor/geometry";
import { functionsOf, idef0Codes, withIdef0Layout } from "../idef0-editor/geometry";
import { addFunction } from "../idef0-editor/ops";
import { deleteNode, duplicateNode, updateNode } from "../bpmn-editor/model-ops";
import { diagramSvg, download, sheetBox, svgToPng } from "./export-image";
import { sheetPrintHtml, sheetPrintSetup } from "@shared/sheetPrint";
import Navigator, { type SetOp } from "./Navigator";
import ProblemsPanel from "./ProblemsPanel";
import DictionaryView from "./DictionaryView";
import ReportView from "./ReportView";
import PropertiesPanel from "./PropertiesPanel";
import type { Selection } from "./selection";
import { bpmnDoc, dictDoc, docIsStale, docTitle, idef0Doc, type StudioDoc } from "./docs";
import { acceptIssue, addOperationSkeleton, quickFixFor, revokeAcceptance, type QuickFix } from "./quick-fixes";
import { addChildFunction, copyFunctionTree, copyImpact, deleteImpact, moveFunction, pasteDestination, type MoveTarget } from "./structure-ops";
import StructureWizard from "./StructureWizard";
import VisioSlot from "./VisioSlot";
import RibbonIcon from "./RibbonIcon";
import { inDesktopShell, onShellMessage, postToShell, recalledTabs, rememberTabs, showShellMenu, type ShellMenuItem } from "../../desktop";
import { SUBTYPES, nextId } from "../bpmn-editor/model-ops";
import type { ExistingKind } from "./ShapePalette";
import { setSheetFrame, type FramePatch } from "../editor-core/sheet-ops";
import { SHEET_FORMATS, bpmnFrameShown, frameKey, frameShown, gridShown, sheetFormatOf } from "@shared/idef0Frame";
import { LC_STATUS_LABELS, lcStatus, lcVersion, nextVersion } from "./lifecycle";
import { LOOP_KINDS, LOOP_LABELS } from "@shared/loops";
import type { PropTab } from "./PanelParts";

type M = ProcessLogicModel;

/** Начальное состояние черновика: роли и позиции фигур достроены (в черновиках, сохранённых раньше, полей новой версии модели нет). */
const normalize = (m: M): M =>
  m.assignments && m.pools && m.messages && m.accepted_issues ? m : { ...m, assignments: m.assignments ?? [], pools: m.pools ?? [], messages: m.messages ?? [], accepted_issues: m.accepted_issues ?? [] };
// В настольном приложении диаграммы рисует и раскладывает сервер, а правит Visio: позиции BPMN студия не достраивает и не сохраняет
// (иначе её раскладка, не знающая служебных начала и конца, ложилась бы на фигуры и перекрывала их).
const seed = (m: M, bpmnXml: string | null | undefined): M => (inDesktopShell() ? withIdef0Layout(normalize(m)) : withIdef0Layout(withScopeLayouts(withLayout(normalize(m), false, positionsFromBpmnXml(bpmnXml)))));

/**
 * Окно студии: единое рабочее место процессного аналитика в духе Business Studio. Слева навигатор
 * (процессы, справочники, отчёты), в центре вкладки-документы (диаграммы BPMN и IDEF0, справочники,
 * отчёты), снизу проверки, сверху лента команд. Вся модель — одна: общая история правок, одно сохранение.
 */
/** У операции есть своя диаграмма BPMN — в модели есть её шаги. */
const hasOperationDiagram = (m: ProcessLogicModel, id: string) => m.nodes.some((n) => n.bpmn_scope === id);

/** Сколько открытых диаграмм помнит «Назад». */
const HISTORY_DOCS = 50;

export default function Studio({ session, busy, onSave, onOpenImport, onReopen }: { session: SessionRecord; busy: boolean; onSave: (m: M) => Promise<boolean>; /** Открыть вкладку приёма правок из внешних редакторов. */ onOpenImport?: () => void; /** Открыть новый цикл правок у утверждённой версии. */ onReopen?: () => Promise<void> | void }) {
  const model = session.model!;
  // утверждённая версия заблокирована от изменений (сервер отвечает 409): студия только показывает модель
  const locked = model.process.status === "approved";
  const h = useModelHistory<M>(() => seed(model, session.bpmnXml), locked);
  // редакторам диаграмм история отдаётся без права писать: перетаскивание и промежуточные состояния жеста ничего не меняют
  const hEdit = locked ? { ...h, setDraft: () => undefined, recordPast: () => undefined } : h;
  const draft = h.draft;
  const persisted = useDraftPersistence<M>({ id: `${session.id}:studio`, base: session.updatedAt, draft, dirty: h.dirty, restore: (m) => h.setDraft(normalize(m)) });
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

  // в настольном приложении вкладки переживают перезагрузку студии (после приёма правок из Visio)
  const recalled = inDesktopShell() ? recalledTabs<{ docs: StudioDoc[]; active: string }>(session.id) : null;
  const [docs, setDocs] = useState<StudioDoc[]>(() => (recalled?.docs?.length ? recalled.docs : [bpmnDoc(), idef0Doc(null)]));
  const [activeKey, setActiveKey] = useState(recalled?.active ?? "bpmn");
  const [focus, setFocus] = useState<{ id: string; nonce: number } | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [navOpen, setNavOpen] = useState(true);
  const [ribbonTab, setRibbonTab] = useState<"main" | "export">("main");
  useEffect(() => {
    if (inDesktopShell()) rememberTabs(session.id, { docs, active: activeKey });
  }, [docs, activeKey, session.id]);
  // вид диаграмм: слой подписей и номера (запоминается по сессии)
  const displayKey = `display:${session.id}`;
  const [display, setDisplayState] = useState<DisplayOptions>(() => loadDisplay(displayKey));
  const setDisplay = (patch: Partial<DisplayOptions>) => {
    const next = { ...display, ...patch };
    setDisplayState(next);
    saveDisplay(displayKey, next);
  };
  const [navReveal, setNavReveal] = useState<{ id: string | null; n: number }>({ id: null, n: 0 });
  /** Бумага для печати листа IDEF0: "" — по формату листа диаграммы (если он стандартный), иначе A4. */
  const [paper, setPaper] = useState("");
  const [propsOpen, setPropsOpen] = useState(true);
  const [full, setFull] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [problemsOpen, setProblemsOpen] = useState(true);
  const [problemsTab, setProblemsTab] = useState<{ tab: "issues" | "gaps" | "proposals" | "tasks" | "questions" | "reports"; nonce: number } | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [tasks, setTasks] = useState<AgentTaskRow[]>([]);
  const [questions, setQuestions] = useState<AgentQuestionRow[]>([]);
  const [agentAllowed, setAgentAllowed] = useState(!!session.meta.agentAccess);
  const [reports, setReports] = useState<AgentReportRow[]>([]);
  const nonce = useRef(0);

  // Предложения агентов (Cline): подхватываем присланные, пока студия открыта; сбой связи не мешает работе
  const loadProposals = async () => {
    // предложения и задания — необязательная часть окна: при сбое связи остаётся прежний список
    const fetched = async <T,>(load: () => Promise<T[]>): Promise<T[] | null> => {
      try {
        const rows = await load();
        return Array.isArray(rows) ? rows : null;
      } catch {
        return null;
      }
    };
    const [p, t, q, r] = await Promise.all([
      fetched(() => api.listProposals(session.id, "pending")),
      fetched(() => api.listTasks(session.id)),
      fetched(() => api.listQuestions(session.id)),
      fetched(() => api.listReports(session.id)),
    ]);
    if (p) setProposals(p);
    if (t) setTasks(t);
    if (q) setQuestions(q);
    if (r) setReports(r);
  };
  useEffect(() => {
    void loadProposals();
    const timer = setInterval(() => void loadProposals(), 8000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id]);

  /** Применить предложение агента: правки попадают в черновик (шагом истории — их можно отменить), сохраняет аналитик как обычно. */
  const applyProposal = async (p: Proposal) => {
    if (locked) return;
    const r = applyPatch(h.draftRef.current, p.patch);
    if (r.errors.length > 0) return;
    h.commit(seed(r.model, null));
    try {
      await api.resolveProposal(p.id, { status: "applied" });
    } catch {
      /* правки уже в черновике; статус предложения обновится при следующем решении */
    }
    await loadProposals();
  };
  /** Правка структуры из навигатора — шаги общей истории (Ctrl+Z); коды пересчитываются, ссылки на них в текстах обновляются. */
  const moveFn = (id: string, target: MoveTarget) => {
    h.commit(withIdef0Layout(moveFunction(h.draftRef.current, id, target)));
    setSelection({ kind: "node", id });
  };
  // буфер дерева: копирование функции вместе с вложенными и шагами диаграмм; вырезанная функция переносится при вставке
  const [clip, setClip] = useState<{ id: string; mode: "copy" | "cut" } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const copyFn = (id: string) => {
    setClip({ id, mode: "copy" });
    setNotice(null);
  };
  const cutFn = (id: string) => {
    setClip({ id, mode: "cut" });
    setNotice(null);
  };
  const pasteFn = (target: string | null) => {
    if (!clip || locked) return;
    const m = h.draftRef.current;
    const src = m.nodes.find((n) => n.id === clip.id);
    if (!src) {
      setClip(null);
      setNotice("Скопированная функция уже удалена.");
      return;
    }
    if (clip.mode === "cut") {
      const dest = pasteDestination(m, clip.id, target);
      if ("error" in dest) return setNotice(dest.error);
      if (!dest.move) return setNotice("Функция уже на верхнем уровне.");
      h.commit(withIdef0Layout(moveFunction(m, clip.id, dest.move)));
      setClip(null);
      setNotice(null);
      setSelection({ kind: "node", id: clip.id });
      return;
    }
    const imp = copyImpact(m, clip.id);
    if ((imp.functions > 1 || imp.steps > 0) && !window.confirm(`Копировать «${src.name}» вместе с вложенным: функций ${imp.functions - 1}, шагов диаграмм ${imp.steps}?`)) return;
    const host = target ? m.nodes.find((n) => n.id === target) : undefined;
    let error = "";
    for (const parent of target === null ? [null] : [target, host?.idef0_parent ?? null]) {
      const r = copyFunctionTree(m, clip.id, parent);
      if ("error" in r) {
        error = r.error;
        continue;
      }
      h.commit(withIdef0Layout(r.model));
      setNotice(null);
      setSelection({ kind: "node", id: r.id });
      return;
    }
    setNotice(error);
  };
  // наборы объектов: фильтр дерева (запоминается по сессии) и правка состава
  const setKey = `nav-set:${session.id}`;
  const [activeSet, setActiveSetState] = useState<string | null>(() => {
    try {
      return localStorage.getItem(setKey);
    } catch {
      return null;
    }
  });
  const activeSetId = activeSet && (draft.object_sets ?? []).some((s) => s.id === activeSet) ? activeSet : null;
  const activeSetObj = activeSetId ? (draft.object_sets ?? []).find((s) => s.id === activeSetId) : undefined;
  const chooseSet = (id: string | null) => {
    setActiveSetState(id);
    try {
      if (id) localStorage.setItem(setKey, id);
      else localStorage.removeItem(setKey);
    } catch {
      /* без хранилища фильтр просто не запоминается */
    }
  };
  const setOp = (op: SetOp) => {
    const m = h.draftRef.current;
    if (op.kind === "create") {
      const r = createSet(m, op.name, op.fnId ? [op.fnId] : []);
      h.commit(r.model);
      chooseSet(r.id);
    } else if (op.kind === "rename") h.commit(renameSet(m, op.id, op.name));
    else if (op.kind === "add") h.commit(addToSet(m, op.setId, op.fnId));
    else if (op.kind === "remove") h.commit(removeFromSet(m, op.setId, op.fnId));
    else if (op.kind === "add-entry") h.commit(addEntryToSet(m, op.setId, op.dict, op.id));
    else if (op.kind === "remove-entry") h.commit(removeEntryFromSet(m, op.setId, op.dict, op.id));
    else {
      const s = (m.object_sets ?? []).find((x) => x.id === op.id);
      if (!s || !window.confirm(`Удалить набор «${s.name}»? Функции в модели останутся.`)) return;
      h.commit(deleteSet(m, op.id));
      if (activeSetId === op.id) chooseSet(null);
    }
  };
  const renameFn = (id: string, name: string) => {
    h.commit(updateNode(h.draftRef.current, id, { name }));
  };
  const fnAction = (action: "add-child" | "skeleton" | "duplicate" | "delete" | "new-version", id: string) => {
    const m = h.draftRef.current;
    if (action === "new-version") {
      const n = m.nodes.find((x) => x.id === id);
      if (n) h.commit(updateNode(m, id, { lc_version: nextVersion(lcVersion(n)), lc_status: "in_work" }));
      return;
    }
    if (action === "add-child") {
      const r = addChildFunction(m, id);
      h.commit(r.model);
      open(idef0Doc(id));
      setSelection({ kind: "node", id: r.id });
      goto(r.id);
    } else if (action === "skeleton") {
      h.commit(addOperationSkeleton(m, id));
      open(bpmnDoc(id));
    } else if (action === "duplicate") {
      const r = duplicateNode(m, id);
      if (r.error) return;
      h.commit(r.model);
      setSelection({ kind: "node", id: r.id! });
    } else {
      const node = m.nodes.find((n) => n.id === id);
      if (!node) return;
      const imp = deleteImpact(m, id);
      const what = [imp.functions > 1 ? `функций: ${imp.functions}` : "", imp.steps ? `шагов диаграмм: ${imp.steps}` : "", imp.flows ? `стрелок: ${imp.flows}` : ""].filter(Boolean).join(", ");
      const dg = deleteDiagramImpact(m, id);
      const diagrams = [dg.changed.length ? `блок уйдёт с диаграмм: ${dg.changed.join(", ")}` : "", dg.removed.length ? `исчезнут диаграммы: ${dg.removed.join(", ")}` : ""].filter(Boolean).join("; ");
      if (!window.confirm(`Удалить «${node.name}»${what ? ` (вместе с вложенным: ${what})` : ""}?${diagrams ? `

На диаграммах: ${diagrams}.` : ""}

Отменить можно Ctrl+Z.`)) return;
      h.commit(deleteNode(m, id));
      setSelection(null);
    }
  };

  /** Исправление и принятие замечаний — шаги общей истории: их можно отменить Ctrl+Z. */
  const fixIssue = (_issue: ValidationIssue, fix: QuickFix, optionId?: string) => h.commit(fix.apply(h.draftRef.current, optionId));
  const acceptOne = (issue: ValidationIssue, reason: string) => h.commit(acceptIssue(h.draftRef.current, issue, reason));
  const revokeOne = (issue: ValidationIssue) => h.commit(revokeAcceptance(h.draftRef.current, issue));

  const createTask = async (task: { text: string; scope: string | null; agent?: string }) => {
    try {
      await api.createTask(session.id, task);
    } catch (e) {
      setExportError(`Не удалось поставить задание: ${(e as Error).message}`);
    }
    await loadProposals();
  };
  const cancelTask = async (task: AgentTaskRow) => {
    try {
      await api.cancelTask(task.id);
    } catch {
      /* задание останется в списке */
    }
    await loadProposals();
  };
  const setQuestionStatus = async (q: AgentQuestionRow, status: AgentQuestionRow["status"], answer?: string) => {
    try {
      await api.setQuestionStatus(q.id, { status, ...(answer ? { answer } : {}) });
    } catch {
      /* вопрос останется в прежнем состоянии */
    }
    await loadProposals();
  };
  const setReportStatus = async (r: AgentReportRow, status: AgentReportRow["status"]) => {
    try {
      await api.setReportStatus(r.id, status);
    } catch {
      /* отчёт останется в прежнем состоянии */
    }
    await loadProposals();
  };
  /** Функция или шаг по коду Соглашения (B002.01.02) — для ссылок из выводов отчётов. */
  const nodeByCode = (code: string): string | null => {
    for (const map of [functionCodes(draft), stepCodes(draft)]) for (const [id, c] of map) if (c === code) return id;
    return null;
  };
  /** Конфиденциальная сессия: разрешить или закрыть доступ агентов — решение аналитика, сохраняется в мете сессии. */
  const setAgentAccess = async (allowed: boolean) => {
    if (allowed && !window.confirm("Тексты интервью и модель этой конфиденциальной сессии станут доступны агентам — то есть внешней модели Cline. Разрешить?")) return;
    try {
      await api.patchSession(session.id, { meta: { ...session.meta, agentAccess: allowed } });
      setAgentAllowed(allowed);
    } catch (e) {
      setExportError(`Не удалось изменить доступ агентов: ${(e as Error).message}`);
    }
  };
  const showTasks = () => setProblemsTab({ tab: "tasks", nonce: ++nonce.current });
  const handOffAnswers = async () => {
    try {
      await api.handOffAnswers(session.id);
      showTasks();
    } catch (e) {
      setExportError(`Не удалось передать ответы моделисту: ${(e as Error).message}`);
    }
    await loadProposals();
  };
  /** Вывод отчёта → задание моделисту: в тексте вывод целиком, ссылка на отчёт и рекомендация. */
  const assignFinding = async (report: AgentReportRow, f: ReportFinding) => {
    const parts = [`По отчёту «${report.title}» (${report.id}) доработай модель: ${f.what}.`, f.where ? `Где: ${f.where}.` : "", f.basis ? `Основание: ${f.basis}.` : "", f.recommendation ? `Рекомендация аналитика: ${f.recommendation}.` : "", "Правки — предложениями; чего нет в тексте интервью, не выдумывай."];
    const scope = (f.where ? nodeByCode(f.where) : null) ?? report.scopeNodeId;
    try {
      await api.createTask(session.id, { text: parts.filter(Boolean).join(" ").slice(0, 2000), scope, agent: "моделист" });
      showTasks();
    } catch (e) {
      setExportError(`Не удалось поставить задание: ${(e as Error).message}`);
    }
    await loadProposals();
  };
  const fnLabel = (id: string) => {
    const n = draft.nodes.find((x) => x.id === id);
    if (!n) return id;
    const code = functionCodes(draft).get(id) ?? stepCodes(draft).get(id);
    return `${code ? `${code} ` : ""}«${n.name}»`;
  };
  const selectedFn = selection?.kind === "node" && draft.nodes.some((n) => n.id === selection.id && (n.type === "task" || n.type === "subprocess")) ? { id: selection.id, label: fnLabel(selection.id) } : null;
  const rejectProposal = async (p: Proposal, reason: string) => {
    try {
      await api.resolveProposal(p.id, { status: "rejected", reason: reason || undefined });
    } catch {
      /* предложение останется в списке */
    }
    await loadProposals();
  };

  const liveDocs = docs.filter((d) => !docIsStale(d, draft));
  const active = liveDocs.find((d) => d.key === activeKey) ?? liveDocs[0] ?? bpmnDoc();
  const allIssues: ValidationIssue[] = useMemo(() => validateModel(draft), [draft]);
  // принятые аналитиком замечания (с причиной) в счётчики и списки действующих не входят
  const split = useMemo(() => splitAccepted(draft.accepted_issues, allIssues), [draft.accepted_issues, allIssues]);
  const issues = split.active;
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

  // История открытых диаграмм («Назад» и «Вперёд»): переход по вкладке, по декомпозиции и из навигатора записывается одинаково
  const [hist, setHist] = useState<{ items: StudioDoc[]; pos: number }>(() => ({ items: [bpmnDoc()], pos: 0 }));
  const navTo = useRef<string | null>(null); // ключ документа, на который перешли кнопкой «Назад» или «Вперёд» — в историю не записывается
  useEffect(() => {
    if (navTo.current === active.key) {
      navTo.current = null;
      return;
    }
    navTo.current = null;
    setHist((hs) => {
      if (hs.items[hs.pos]?.key === active.key) return hs;
      const items = [...hs.items.slice(0, hs.pos + 1), active].slice(-HISTORY_DOCS);
      return { items, pos: items.length - 1 };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active.key]);
  /** Ближайшая в сторону dir запись истории, документ которой ещё существует. */
  const histTarget = (dir: -1 | 1): number | null => {
    for (let q = hist.pos + dir; q >= 0 && q < hist.items.length; q += dir) if (!docIsStale(hist.items[q], draft)) return q;
    return null;
  };
  const goHist = (dir: -1 | 1) => {
    const q = histTarget(dir);
    if (q === null) return;
    const doc = hist.items[q];
    if (doc.key !== active.key) navTo.current = doc.key;
    setHist((hs) => ({ ...hs, pos: q }));
    open(doc);
  };
  /** Диаграмма уровнем выше: для декомпозиции функции и для диаграммы BPMN операции — диаграмма IDEF0, где стоит их функция. */
  const upTarget = (): { doc: StudioDoc; from: string } | null => {
    const parentId = active.kind === "idef0" ? active.parent : active.kind === "bpmn" ? active.scope : null;
    const fn = parentId ? draft.nodes.find((n) => n.id === parentId) : undefined;
    return fn ? { doc: idef0Doc(fn.idef0_parent ?? null), from: fn.id } : null;
  };
  const goUp = () => {
    const up = upTarget();
    if (!up) return;
    open(up.doc);
    setSelection({ kind: "node", id: up.from });
    goto(up.from);
  };
  /** Диаграмма уровнем ниже для выбранной функции: её декомпозиция, а без неё — диаграмма BPMN операции. */
  const downTarget = (): StudioDoc | null => {
    const fn = selection?.kind === "node" ? draft.nodes.find((n) => n.id === selection.id && !n.bpmn_scope && (n.type === "task" || n.type === "subprocess")) : undefined;
    if (!fn) return null;
    if (draft.nodes.some((n) => n.idef0_parent === fn.id && !n.bpmn_scope)) return idef0Doc(fn.id);
    return draft.nodes.some((n) => n.bpmn_scope === fn.id) ? bpmnDoc(fn.id) : null;
  };
  const goDown = () => {
    const doc = downTarget();
    if (doc) open(doc);
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
    if (n.bpmn_scope) {
      open(bpmnDoc(n.bpmn_scope));
    } else if (active.kind === "bpmn" && active.scope === null && !n.idef0_parent) {
      setSelection({ kind: "node", id });
      goto(id);
      return;
    } else open(idef0Doc(n.idef0_parent ?? null));
    setSelection({ kind: "node", id });
    goto(id);
  };

  /** «Найти в навигаторе»: выбранный элемент, а без выбора — функция текущей диаграммы или сама диаграмма. */
  const findInNavigator = () => {
    const id = selection?.kind === "node" ? selection.id : active.kind === "bpmn" ? active.scope : active.kind === "idef0" ? active.parent : null;
    setNavOpen(true);
    setNavReveal((r) => ({ id, n: r.n + 1 }));
  };

  /** Показать элемент на диаграмме выбранной нотации (из панели свойств). */
  const reveal = (id: string, where: "bpmn" | "idef0") => {
    const n = draft.nodes.find((x) => x.id === id);
    if (!n) return;
    open(where === "bpmn" ? bpmnDoc(n.bpmn_scope ?? null) : idef0Doc(n.idef0_parent ?? null));
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
        if ((s.kind === "node" || s.kind === "flow" || s.kind === "pool" || s.kind === "message") && "id" in prev && s.id === prev.id) return prev;
      }
      return s;
    });

  // Живая связь с Visio в настольном приложении: выбранная в Visio фигура становится выделением студии (панель свойств), а шаг,
  // выбранный в студии (навигатор, проверки, свойства), выделяется на диаграмме Visio. Последний id, пришедший из Visio, не
  // отправляется обратно, чтобы не было эха.
  const shellSelected = useRef<string | null>(null);
  const [syncNav, setSyncNav] = useState(false);
  const [propsTabRequest, setPropsTabRequest] = useState<{ tab: PropTab; n: number } | undefined>(undefined);
  /**
   * Меню объекта по правому щелчку в Visio, как в Business Studio: у шага — тип задачи, тип цикла, вырезать/копировать/вставить,
   * выделить все подобные, анализ использования, свойства; у пустого места — вставить, выделить всё и команды страницы.
   * Смена типа сразу записывается в модель — Visio перечитывает диаграмму.
   */
  /**
   * Вторая группа палитры, как в Business Studio: существующий объект справочника — к выбранному шагу диаграммы. Документ — входом или
   * выходом, программный продукт и нормативный документ — отметкой, исполнитель — дорожкой; «Деятельность» ставит на диаграмму
   * операции шаг-ссылку на другую функцию. Изменение сразу записывается в модель, Visio перечитывает диаграмму.
   */
  const pickExisting = (kind: ExistingKind, anchor: Element) => {
    const m = h.draftRef.current;
    const step = selection?.kind === "node" ? m.nodes.find((n) => n.id === selection.id && (n.type === "task" || n.type === "subprocess")) : undefined;
    const scope = active.kind === "bpmn" ? active.scope : null;
    let items: ShellMenuItem[];
    if (kind === "activity") {
      const fns = m.nodes.filter((n) => (n.type === "task" || n.type === "subprocess") && !n.bpmn_scope && n.id !== scope);
      const codes = idef0Codes(m);
      items = fns.length ? fns.map((f) => ({ id: `act:${f.id}`, label: `${codes.get(f.id) ?? ""} ${f.name}`.trim() })) : [{ id: "none", label: "В модели нет других функций", disabled: true }];
    } else if (!step) {
      items = [{ id: "none", label: "Сначала выберите шаг на диаграмме", disabled: true }];
    } else if (kind === "document") {
      items = [
        ...m.data.map((d) => ({ label: d.name, items: [{ id: `in:${d.id}`, label: "Вход шага", checked: step.inputs.includes(d.id) }, { id: `out:${d.id}`, label: "Выход шага", checked: step.outputs.includes(d.id) }] })),
        { group: "Новый" },
        { id: "new-doc", label: "Новый документ…" },
      ];
    } else if (kind === "system") {
      items = [...m.systems.map((s) => ({ id: `sys:${s.id}`, label: s.name, checked: step.system_ids.includes(s.id) })), { group: "Новый" }, { id: "new-sys", label: "Новый программный продукт…" }];
    } else if (kind === "regulation") {
      items = m.controls.length ? m.controls.map((c) => ({ id: `ctl:${c.id}`, label: c.name, checked: step.controls.includes(c.id) })) : [{ id: "none", label: "В справочнике нет нормативных документов", disabled: true }];
    } else {
      items = m.roles.map((r) => ({ id: `role:${r.id}`, label: r.name, checked: step.role_id === r.id }));
    }
    void showShellMenu(anchor, items).then((picked) => {
      if (!picked || picked === "none") return;
      const cur = h.draftRef.current;
      const [what, id = ""] = picked.split(/:(.*)/s);
      const toggle = (list: string[], x: string) => (list.includes(x) ? list.filter((y) => y !== x) : [...list, x]);
      let next: ProcessLogicModel | null = null;
      if (what === "act") {
        const fn = cur.nodes.find((n) => n.id === id);
        if (!fn || !scope) return;
        const node: ProcessNode = { id: nextId("n", cur.nodes.map((n) => n.id)), type: "subprocess", name: fn.name, role_id: fn.role_id ?? null, system_ids: [], inputs: [], outputs: [], controls: [], bpmn_scope: scope, status: "confirmed", confidence: 1, source: [], requirement_ids: [], tags: [`reuse:${fn.id}`], confirmed_by: [] };
        next = { ...cur, nodes: [...cur.nodes, node] };
      } else if (step) {
        const s = cur.nodes.find((n) => n.id === step.id)!;
        if (what === "in") next = updateNode(cur, s.id, { inputs: toggle(s.inputs, id) });
        else if (what === "out") next = updateNode(cur, s.id, { outputs: toggle(s.outputs, id) });
        else if (what === "sys") next = updateNode(cur, s.id, { system_ids: toggle(s.system_ids, id) });
        else if (what === "ctl") next = updateNode(cur, s.id, { controls: toggle(s.controls, id) });
        else if (what === "role") next = updateNode(cur, s.id, { role_id: id });
        else if (what === "new-doc" || what === "new-sys") {
          const name = window.prompt(what === "new-doc" ? "Название нового документа" : "Название программного продукта")?.trim();
          if (!name) return;
          if (what === "new-doc") {
            const did = nextId("d", cur.data.map((d) => d.id));
            next = updateNode({ ...cur, data: [...cur.data, { id: did, name, kind: "document", source: [] } as ProcessLogicModel["data"][number]] }, s.id, { outputs: [...s.outputs, did] });
          } else {
            const sid = nextId("s", cur.systems.map((x) => x.id));
            next = updateNode({ ...cur, systems: [...cur.systems, { id: sid, name, source: [] } as ProcessLogicModel["systems"][number]] }, s.id, { system_ids: [...s.system_ids, sid] });
          }
        }
      }
      if (!next) return;
      h.commit(next);
      window.setTimeout(() => void save(), 0);
    });
  };

  /**
   * Лист диаграммы в окне Visio, как «Параметры страницы»: формат (A4, A3, A2), поворот, авторазмер по содержимому, рамка со штампом и
   * сетка. Размер сохраняется в настройках листа модели (idef0_frames / bpmn_frames), Visio перечитывает диаграмму. Лист можно
   * растянуть и прямо в Visio — приём правок перенесёт новый размер в модель.
   */
  const sheetControl = (() => {
    if (active.kind !== "bpmn" && active.kind !== "idef0") return undefined;
    const field = active.kind === "bpmn" ? ("bpmn_frames" as const) : ("idef0_frames" as const);
    const key = active.kind === "bpmn" ? active.scope ?? "" : frameKey(active.parent);
    const frame = draft[field]?.[key];
    const on = active.kind === "bpmn" ? bpmnFrameShown(frame) : frameShown(frame);
    const manual = frame?.w !== undefined && frame?.h !== undefined;
    const format = manual ? sheetFormatOf(frame!.w!, frame!.h!) : null;
    const rectNow = { x: frame?.x ?? 0, y: frame?.y ?? 0, w: frame?.w ?? SHEET_FORMATS[0].w, h: frame?.h ?? SHEET_FORMATS[0].h };
    const items: ShellMenuItem[] = [
      { id: "frame", label: "Рамка листа со штампом", checked: on },
      { id: "grid", label: "Сетка", checked: on && gridShown(frame), disabled: !on },
      { group: "Формат" },
      { id: "auto", label: "По содержимому диаграммы", checked: !manual, disabled: !on },
      ...SHEET_FORMATS.map((f) => ({ id: `fmt:${f.id}`, label: `${f.label} (${f.id === "A4" ? "210 × 297" : f.id === "A3" ? "297 × 420" : "420 × 594"} мм)`, checked: format?.id === f.id, disabled: !on })),
      { group: "Ориентация" },
      { id: "landscape", label: "Альбомная", checked: manual ? rectNow.w >= rectNow.h : true, disabled: !on || !manual },
      { id: "portrait", label: "Книжная", checked: manual && rectNow.w < rectNow.h, disabled: !on || !manual },
    ];
    const onPick = (id: string) => {
      let patch: FramePatch | null = null;
      if (id === "frame") patch = { show: !on };
      else if (id === "grid") patch = { grid: !gridShown(frame) };
      else if (id === "auto") patch = { rect: null };
      else if (id.startsWith("fmt:")) {
        const f = SHEET_FORMATS.find((x) => x.id === id.slice(4));
        if (!f) return;
        const portrait = manual && rectNow.w < rectNow.h;
        patch = { rect: { x: rectNow.x, y: rectNow.y, w: portrait ? f.h : f.w, h: portrait ? f.w : f.h } };
      } else if (id === "landscape" || id === "portrait") {
        const wide = rectNow.w >= rectNow.h;
        if ((id === "landscape") === wide) return;
        patch = { rect: { x: rectNow.x, y: rectNow.y, w: rectNow.h, h: rectNow.w } };
      }
      if (!patch) return;
      h.commit(setSheetFrame(h.draftRef.current, field, key, patch));
      window.setTimeout(() => void save(), 0); // в окне Visio лист виден после записи в модель
    };
    return { items, onPick };
  })();

  const shapeMenuRef = useRef<(kind: string | null, id: string | null) => void>(() => undefined);
  shapeMenuRef.current = (kind, id) => {
    const node = (kind === "node" || kind === "fn") && id ? draft.nodes.find((n) => n.id === id) : undefined;
    const edit: ShellMenuItem[] = [
      { group: "Правка" },
      { id: "cmd:cut", label: "Вырезать", kbd: "Ctrl+X" },
      { id: "cmd:copy", label: "Копировать", kbd: "Ctrl+C" },
      { id: "cmd:paste", label: "Вставить", kbd: "Ctrl+V" },
      { id: "cmd:delete", label: "Удалить", kbd: "Del" },
    ];
    const kindMenu = (label: string, prefix: string, options: [string, string][], current: string): ShellMenuItem => ({
      label,
      items: options.map(([k, l]) => ({ id: `${prefix}:${k}`, label: l, checked: current === k })),
    });
    let items: ShellMenuItem[];
    if (node) {
      const typed: ShellMenuItem[] = [];
      if (node.type === "task" || node.type === "subprocess") {
        if ((SUBTYPES[node.type] ?? []).length > 0) typed.push(kindMenu(node.type === "task" ? "Тип задачи" : "Тип подпроцесса", "subtype", SUBTYPES[node.type], node.subtype ?? ""));
        typed.push(kindMenu("Тип цикла", "loop", [["", "Нет, выполняется один раз"], ...LOOP_KINDS.map((k) => [k, LOOP_LABELS[k]] as [string, string])], node.loop ?? ""));
      } else if (node.type === "gateway") typed.push(kindMenu("Тип шлюза", "subtype", SUBTYPES.gateway ?? [], node.subtype ?? ""));
      items = [
        ...typed,
        ...edit,
        { group: "Объект" },
        { id: "similar", label: "Выделить все подобные" },
        { id: "usage", label: "Анализ использования объекта" },
        { id: "find", label: "Найти в навигаторе" },
        { group: "Свойства" },
        { id: "props", label: "Свойства объекта", kbd: "Ctrl+E" },
      ];
    } else if (kind === "flow" && id) {
      items = [{ id: "cmd:delete", label: "Удалить", kbd: "Del" }, { group: "Свойства" }, { id: "props", label: "Свойства объекта", kbd: "Ctrl+E" }];
    } else {
      items = [
        { id: "cmd:paste", label: "Вставить", kbd: "Ctrl+V" },
        { id: "cmd:selectall", label: "Выделить всё", kbd: "Ctrl+A" },
        { group: "Страница" },
        { id: "cmd:pagesetup", label: "Параметры страницы…", kbd: "Shift+F5" },
        { id: "cmd:fitcontent", label: "Изменить размеры по содержимому" },
        { id: "grid", label: "Сетка: показать или скрыть" },
        { group: "Свойства" },
        { id: "props", label: "Свойства диаграммы", kbd: "Ctrl+E" },
      ];
    }
    void showShellMenu("cursor", items).then((picked) => {
      if (!picked) return;
      const [what, arg = ""] = picked.split(/:(.*)/s);
      if (what === "cmd") return postToShell({ t: "cmd", name: arg });
      if (what === "grid") return postToShell({ t: "grid" });
      if (what === "props") return setPropsOpen(true);
      if (!node) return;
      if (what === "subtype" || what === "loop") {
        const patch: Partial<ProcessNode> = what === "subtype" ? { subtype: arg || undefined } : { loop: (arg || undefined) as ProcessNode["loop"] };
        h.commit(updateNode(h.draftRef.current, node.id, patch));
        window.setTimeout(() => void save(), 0); // в окне Visio правка видна после записи в модель
        return;
      }
      if (what === "similar") {
        const same = draft.nodes.filter((n) => n.type === node.type && n.bpmn_scope === node.bpmn_scope && (n.bpmn_scope ? true : n.idef0_parent === node.idef0_parent));
        return postToShell({ t: "select-many", ids: same.map((n) => n.id) });
      }
      if (what === "usage") {
        setSelection({ kind: "node", id: node.id });
        setPropsOpen(true);
        setPropsTabRequest((r) => ({ tab: "links", n: (r?.n ?? 0) + 1 }));
        return;
      }
      if (what === "find") findInNavigator();
    });
  };
  const syncNavRef = useRef(false);
  syncNavRef.current = syncNav;
  useEffect(() => {
    if (!inDesktopShell()) return;
    return onShellMessage((m) => {
      if (m.t === "props") {
        setPropsOpen(true); // Ctrl+E в окне Visio — свойства объекта, как в Business Studio
        return;
      }
      if (m.t === "shape-menu") {
        shapeMenuRef.current(m.kind, m.id);
        return;
      }
      if (m.t !== "visio-select") return;
      shellSelected.current = m.id;
      reportSelection({ kind: m.kind, id: m.id });
      // включённая синхронизация показывает выбранную фигуру в дереве навигатора
      if (syncNavRef.current && m.kind === "node") setNavReveal((r) => ({ id: m.id, n: r.n + 1 }));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!inDesktopShell() || selection?.kind !== "node") return;
    if (selection.id === shellSelected.current) return;
    shellSelected.current = selection.id;
    postToShell({ t: "select", id: selection.id });
  }, [selection]);

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
      open(bpmnDoc(n.bpmn_scope ?? null));
      setSelection({ kind: "node", id: n.id });
      goto(n.id);
    } else if (elementId && (isRole || draft.flows.some((f) => f.id === elementId))) {
      const flow = draft.flows.find((f) => f.id === elementId);
      open(bpmnDoc(flow ? draft.nodes.find((x) => x.id === flow.from)?.bpmn_scope ?? null : null));
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

  /** Копия выбранной функции или шага рядом с оригиналом. */
  const duplicate = () => {
    if (selection?.kind !== "node") return;
    const r = duplicateNode(h.draftRef.current, selection.id);
    if (r.error) return;
    h.commit(r.model);
    setSelection({ kind: "node", id: r.id! });
    goto(r.id!);
  };

  /** Выгрузка открытой диаграммы такой, как она на экране (в т. ч. с несохранёнными правками). */
  const exportDiagram = async (format: "svg" | "png") => {
    setExportError(null);
    const canvas = document.querySelector<SVGSVGElement>(".doc-area svg.bpe-svg, .doc-area svg.scheme-svg");
    const out = canvas && diagramSvg(canvas);
    if (!out) {
      setExportError("Откройте диаграмму BPMN или IDEF0 — выгружать нечего.");
      return;
    }
    const name = `${draft.process.name} — ${docTitle(active, draft)}`;
    try {
      if (format === "svg") download(new Blob([out.svg], { type: "image/svg+xml" }), `${name}.svg`);
      else download(await svgToPng(out.svg, out.width, out.height), `${name}.png`);
    } catch (e) {
      setExportError((e as Error).message);
    }
  };

  /**
   * Печать листа BPMN: рисунок с экрана (как SVG/PNG) — включённый лист с рамкой или вся диаграмма.
   * «Печать…» открывает страницу печати в новой вкладке, «Лист в PDF» собирает PDF на сервере.
   */
  const printBpmnSheet = async (to: "pdf" | "print") => {
    setExportError(null);
    const canvas = document.querySelector<SVGSVGElement>(".doc-area svg.bpe-svg");
    const out = canvas && diagramSvg(canvas, sheetBox(canvas) ?? undefined);
    if (active.kind !== "bpmn" || !out) {
      setExportError("Откройте диаграмму BPMN — печатать нечего.");
      return;
    }
    const frame = draft.bpmn_frames?.[active.scope ?? ""];
    const { paper: p, orientation } = sheetPrintSetup(frame?.show ? frame : undefined, { w: out.width, h: out.height }, { paper: paper || undefined });
    const title = `${draft.process.name} — ${docTitle(active, draft)}`;
    if (to === "print") {
      const win = window.open(URL.createObjectURL(new Blob([sheetPrintHtml(out.svg, title, p, orientation)], { type: "text/html" })), "_blank");
      if (!win) setExportError("Браузер не дал открыть вкладку печати — разрешите всплывающие окна для этого сайта.");
      return;
    }
    try {
      download(await api.sheetPdf(session.id, { svg: out.svg, title, paper: p, orientation }), `${title}.${p}.pdf`);
    } catch (e) {
      setExportError((e as Error).message);
    }
  };

  /** «Обновить» панели свойств: вернуть сохранённую модель; несохранённые правки отбрасываются после подтверждения. */
  const refreshFromServer = () => {
    if (h.dirty && !window.confirm("Отбросить несохранённые правки и вернуть сохранённую модель?")) return;
    const s = seed(model, session.bpmnXml);
    h.setDraft(s);
    h.markSaved(s);
  };

  const save = async () => {
    const snapshot = h.draftRef.current;
    if (await onSave(snapshot)) h.markSaved(snapshot);
  };

  // История и сохранение вне редакторов диаграмм
  const onKeyDown = (e: React.KeyboardEvent) => {
    // Alt+← и Alt+→ — назад и вперёд по открытым диаграммам (как в браузере)
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === "ArrowLeft" || e.key === "ArrowRight") && !isTextInput(e.target)) {
      e.preventDefault();
      goHist(e.key === "ArrowLeft" ? -1 : 1);
      return;
    }
    // Ctrl+E — свойства объекта, как в Business Studio
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key.toLowerCase() === "e" || e.code === "KeyE")) {
      e.preventDefault();
      setPropsOpen(true);
      return;
    }
    // диаграммы обрабатывают клавиши сами; остальное (справочники, отчёты, панель свойств) — здесь
    if ((e.target as Element).closest?.(".bpe") || isTextInput(e.target)) return;
    handleCommonKeys(e, { undo: h.undo, redo: h.redo, save: () => h.dirty && !busy && void save() });
  };

  const exportLink = (label: string, path: string) => (
    <a key={path} href={api.exportUrl(session.id, path)} target="_blank" rel="noreferrer" className={h.dirty ? "disabled-link" : ""} onClick={(e) => h.dirty && e.preventDefault()} title={h.dirty ? "Экспортируется сохранённая версия — сначала сохраните" : undefined}>
      <RibbonIcon name="export" />
      {label}
    </a>
  );

  const shown = visibleNodes(draft);
  const fnCount = draft.nodes.filter((n) => (n.type === "task" || n.type === "subprocess") && !n.bpmn_scope).length;

  return (
    <div className={`studio ${full ? "full" : ""} ${locked ? "studio-readonly" : ""}`} onKeyDown={onKeyDown}>
      {locked && (
        <div className="studio-lock" role="status">
          <b>Версия утверждена и заблокирована от изменений.</b> Диаграммы, справочники и отчёты открыты только для просмотра.
          {onReopen && (
            <button disabled={busy} onClick={() => void onReopen()}>
              Открыть новый цикл правок
            </button>
          )}
        </div>
      )}
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

      <div className="ribbon-tabs" role="tablist" aria-label="Лента">
        {([["main", "Главная"], ["export", "Выгрузка и печать"]] as const).map(([key, title]) => (
          <button key={key} role="tab" className="ribbon-tab" aria-selected={ribbonTab === key} onClick={() => setRibbonTab(key)}>
            {title}
          </button>
        ))}
      </div>
      <div className="ribbon" data-tab={ribbonTab}>
        <div className="ribbon-group" data-tab="main">
          <div className="ribbon-buttons">
            {inDesktopShell() && (
              <button className="rb big" onClick={() => postToShell({ t: "apply" })} title="Сохранить правки, сделанные в Visio, в модель процесса">
                <RibbonIcon name="apply" />
                Принять из Visio
              </button>
            )}
            <button className="rb big" disabled={!h.dirty || busy} onClick={() => void save()} title="Сохранить (Ctrl+S)">
              <RibbonIcon name="save" />
              {busy ? "Сохранение…" : "Сохранить"}
            </button>
            <button className="rb big" disabled={!h.canUndo} onClick={h.undo} title="Отменить (Ctrl+Z)">
              <RibbonIcon name="undo" />
              Отменить
            </button>
            <button className="rb big" disabled={!h.canRedo} onClick={h.redo} title="Повторить (Ctrl+Y)">
              <RibbonIcon name="redo" />
              Повторить
            </button>
          </div>
          <div className="ribbon-caption">Файл</div>
        </div>
        <div className="ribbon-group" data-tab="main">
          <div className="ribbon-buttons">
            <button className="ribbon-icon" aria-label="Предыдущая диаграмма" disabled={histTarget(-1) === null} onClick={() => goHist(-1)} title="Предыдущая открытая диаграмма (Alt+←)">
              <RibbonIcon name="prev" />
            </button>
            <button className="ribbon-icon" aria-label="Следующая диаграмма" disabled={histTarget(1) === null} onClick={() => goHist(1)} title="Следующая открытая диаграмма (Alt+→)">
              <RibbonIcon name="next" />
            </button>
            <button className="ribbon-icon" aria-label="Вверх: диаграмма выше" disabled={!upTarget()} onClick={goUp} title="Вверх: диаграмма, на которой стоит функция этой диаграммы">
              <RibbonIcon name="up" />
            </button>
            <button className="ribbon-icon" aria-label="Вниз: диаграмма ниже" disabled={!downTarget()} onClick={goDown} title="Вниз: декомпозиция выбранной функции или диаграмма BPMN её операции">
              <RibbonIcon name="down" />
            </button>
            <button className="ribbon-icon" onClick={findInNavigator} aria-label="Найти в навигаторе" title="Найти в навигаторе: показать в дереве выбранный элемент или текущую диаграмму">
              <RibbonIcon name="find" />
            </button>
            {(active.kind === "bpmn" || active.kind === "idef0") && (
              <>
                <button className={`ribbon-icon ${display.labels ? "toggled" : ""}`} aria-label="Подписи" aria-pressed={display.labels} onClick={() => setDisplay({ labels: !display.labels })} title="Слой подписей: названия событий и шлюзов, условия и подписи стрелок. Названия внутри задач и блоков остаются">
                  <RibbonIcon name="labels" />
                </button>
                <button
                  className={`ribbon-icon ${(active.kind === "bpmn" ? display.bpmnNumbers : display.idef0Numbers) ? "toggled" : ""}`}
                  aria-label="Номера"
                  aria-pressed={active.kind === "bpmn" ? display.bpmnNumbers : display.idef0Numbers}
                  onClick={() => setDisplay(active.kind === "bpmn" ? { bpmnNumbers: !display.bpmnNumbers } : { idef0Numbers: !display.idef0Numbers })}
                  title={active.kind === "bpmn" ? "Номера: код функции или шага на задачах диаграммы" : "Номера: код функции на блоках диаграммы"}
                >
                  <RibbonIcon name="numbers" />
                </button>
              </>
            )}
            <button className="rb" onClick={() => open(bpmnDoc())}>
              <RibbonIcon name="bpmn" />
              Диаграмма BPMN
            </button>
            <button className="rb" onClick={() => open(idef0Doc(null))}>
              <RibbonIcon name="idef0" />
              Диаграмма IDEF0
            </button>
            <button className="rb" onClick={() => addFn(active.kind === "idef0" ? active.parent : null)} title="Добавить функцию на текущую диаграмму IDEF0 (A0, если открыта другая вкладка)">
              <RibbonIcon name="addfn" />
              + Функция
            </button>
            <button className="rb" onClick={() => setWizardOpen(true)} title="Подпроцессы и операции списком: коды по Соглашению и заготовки диаграмм">
              <RibbonIcon name="wizard" />
              Мастер структуры…
            </button>
            <button className="rb" disabled={locked || selection?.kind !== "node"} onClick={duplicate} title="Копия выбранной функции или шага (Ctrl+D на диаграмме)">
              <RibbonIcon name="duplicate" />
              Дублировать
            </button>
          </div>
          <div className="ribbon-caption">Модель</div>
        </div>
        <div className="ribbon-group" data-tab="main">
          <div className="ribbon-buttons">
            <button className={`rb big ${navOpen ? "toggled" : ""}`} onClick={() => setNavOpen(!navOpen)}>
              <RibbonIcon name="navigator" />
              Навигатор
            </button>
            <button className={`rb big ${propsOpen ? "toggled" : ""}`} onClick={() => setPropsOpen(!propsOpen)}>
              <RibbonIcon name="properties" />
              Свойства
            </button>
            <button className={`rb big ${full ? "toggled" : ""}`} onClick={() => setFull(!full)} title="Окно студии на весь экран — больше места для диаграммы">
              <RibbonIcon name="fullscreen" />
              {full ? "Свернуть окно" : "На весь экран"}
            </button>
            <button className={`rb big ${problemsOpen ? "toggled" : ""}`} onClick={() => setProblemsOpen(!problemsOpen)}>
              <RibbonIcon name="checks" />
              Проверки{errors + warnings > 0 ? ` (${errors + warnings})` : ""}
            </button>
            <button
              className={`rb big ${proposals.length > 0 ? "attention" : ""}`}
              onClick={() => {
                setProblemsOpen(true);
                setProblemsTab({ tab: "proposals", nonce: ++nonce.current });
              }}
              title="Правки, которые предложил агент (Cline): вы решаете, применить их или отклонить"
            >
              <RibbonIcon name="suggest" />
              Предложения{proposals.length > 0 ? ` (${proposals.length})` : ""}
            </button>
          </div>
          <div className="ribbon-caption">Вид</div>
        </div>
        <div className="ribbon-group" data-tab="export">
          <div className="ribbon-buttons ribbon-links">
            {exportLink("BPMN", "bpmn")}
            {active.kind === "bpmn" && active.scope && hasOperationDiagram(draft, active.scope) && exportLink("BPMN операции", `bpmn?scope=${encodeURIComponent(active.scope)}`)}
            {bpmnHosts(draft).some((h) => hasOperationDiagram(draft, h.id)) && exportLink("BPMN всех операций (zip)", "bpmn.zip")}
            {activeSetId && exportLink("BPMN набора (zip)", `bpmn.zip?set=${encodeURIComponent(activeSetId)}`)}
            {exportLink("IDEF0 (SVG)", "idef0/decomposition.svg")}
            {exportLink("Visio", "vsdx")}
            {exportLink("Модель (JSON)", "model.json")}
          </div>
          <div className="ribbon-caption">Выгрузка</div>
        </div>
        {active.kind === "idef0" && (
          <div className="ribbon-group" data-tab="export">
            <div className="ribbon-buttons ribbon-links">
              {(() => {
                // адрес диаграммы в выгрузке: верхняя — decomposition, диаграмма функции — её код
                const diagram = active.parent === null ? "decomposition" : idef0Codes(draft).get(active.parent);
                if (!diagram) return null;
                const q = paper ? `?paper=${paper}` : "";
                const guard = { className: h.dirty ? "disabled-link" : "", onClick: (e: React.MouseEvent) => h.dirty && e.preventDefault(), title: h.dirty ? "Печатается сохранённая версия — сначала сохраните" : undefined };
                return (
                  <>
                    <select aria-label="Бумага для печати" value={paper} onChange={(e) => setPaper(e.target.value)} title="Бумага: «По листу» берёт формат рамки диаграммы (A4, A3, A2), иначе A4">
                      <option value="">Бумага: по листу</option>
                      <option value="A4">A4</option>
                      <option value="A3">A3</option>
                      <option value="A2">A2</option>
                    </select>
                    <a href={api.exportUrl(session.id, `idef0/${encodeURIComponent(diagram)}.pdf${q}`)} target="_blank" rel="noreferrer" {...guard}>
                      <RibbonIcon name="pdf" />
                      Лист в PDF
                    </a>
                    <a href={api.exportUrl(session.id, `idef0/${encodeURIComponent(diagram)}.print.html${q}`)} target="_blank" rel="noreferrer" {...guard}>
                      <RibbonIcon name="print" />
                      Печать…
                    </a>
                  </>
                );
              })()}
            </div>
            <div className="ribbon-caption">Печать листа IDEF0</div>
          </div>
        )}
        {active.kind === "bpmn" && (
          <div className="ribbon-group" data-tab="export">
            <div className="ribbon-buttons ribbon-links">
              <select aria-label="Бумага для печати" value={paper} onChange={(e) => setPaper(e.target.value)} title="Бумага: «По листу» берёт формат рамки листа (A4, A3, A2), иначе A4">
                <option value="">Бумага: по листу</option>
                <option value="A4">A4</option>
                <option value="A3">A3</option>
                <option value="A2">A2</option>
              </select>
              <button onClick={() => void printBpmnSheet("pdf")} title="Лист как на экране (включите рамку в меню «Лист» редактора), в том числе с несохранёнными правками">
                <RibbonIcon name="pdf" />
                Лист в PDF
              </button>
              <button onClick={() => void printBpmnSheet("print")} title="Страница печати листа как на экране: Ctrl+P или «Сохранить как PDF»">
                <RibbonIcon name="print" />
                Печать…
              </button>
            </div>
            <div className="ribbon-caption">Печать листа BPMN</div>
          </div>
        )}
        {onOpenImport && (
          <div className="ribbon-group" data-tab="export">
            <div className="ribbon-buttons">
              <button onClick={onOpenImport} title="Загрузить правки из bpmn.io, Camunda Modeler или draw.io: переименования применятся, новые элементы появятся как гипотезы. Новую модель из Visio, Excel или изображения создают на странице «Новая сессия».">
                <RibbonIcon name="import" />
                Импорт…
              </button>
            </div>
            <div className="ribbon-caption">Импорт</div>
          </div>
        )}
        <div className="ribbon-group" data-tab="export">
          <div className="ribbon-buttons">
            <button onClick={() => void exportDiagram("svg")} title="Открытая диаграмма как на экране, в том числе с несохранёнными правками">
              <RibbonIcon name="image" />
              SVG
            </button>
            <button onClick={() => void exportDiagram("png")} title="Открытая диаграмма как на экране, в том числе с несохранёнными правками">
              <RibbonIcon name="image" />
              PNG
            </button>
          </div>
          <div className="ribbon-caption">Эта диаграмма</div>
        </div>
      </div>

      <div className="studio-body" style={{ gridTemplateColumns: `${navOpen ? "330px " : ""}minmax(0, 1fr)${propsOpen ? " 340px" : ""}` }}>
        {navOpen && (
          <Navigator model={draft} activeKey={active.key} selectedId={selection?.kind === "node" ? selection.id : null} onOpenDoc={open} onSelectFn={selectFn} onProperties={(id) => (selectFn(id), setPropsOpen(true))} onAddFunction={locked ? () => undefined : addFn} onOpenEntry={(dict, id) => { open(dictDoc(dict)); setSelection({ kind: "entry", dict, id }); }} onMoveFunction={locked ? undefined : moveFn} onFunctionAction={locked ? undefined : fnAction} onWizard={locked ? undefined : () => setWizardOpen(true)} reveal={navReveal} storageKey={session.id} onRenameFunction={locked ? undefined : renameFn} clipboard={clip} onCopy={locked ? undefined : copyFn} onCut={locked ? undefined : cutFn} onPaste={locked ? undefined : pasteFn} activeSet={activeSetId} onActiveSet={chooseSet} onSetOp={locked ? undefined : setOp} onClose={() => setNavOpen(false)} />
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
            {inDesktopShell() && (active.kind === "bpmn" || active.kind === "idef0") && (
              <VisioSlot sessionId={session.id} updatedAt={session.updatedAt} diagram={active.kind === "bpmn" ? { kind: "bpmn", scope: active.scope } : { kind: "idef0", parent: active.parent }} toolbar={{
                  propsOpen,
                  onToggleProps: () => setPropsOpen(!propsOpen),
                  onFind: findInNavigator,
                  onClose: liveDocs.length > 1 ? () => close(active.key) : undefined,
                  onUp: upTarget() ? goUp : undefined,
                  onDown: downTarget() ? goDown : undefined,
                  onPrev: histTarget(-1) !== null ? () => goHist(-1) : undefined,
                  onNext: histTarget(1) !== null ? () => goHist(1) : undefined,
                  syncNav,
                  onToggleSync: () => setSyncNav((v) => !v),
                  onExisting: locked ? undefined : pickExisting,
                  sheet: locked ? undefined : sheetControl,
                }}
              />
            )}
            {!inDesktopShell() && active.kind === "bpmn" && (
              <BpmnEditor key={active.key} display={display} scope={active.scope} model={draft} busy={busy} onSave={onSave} draftId={`${session.id}:studio`} draftBase={session.updatedAt} bpmnXml={session.bpmnXml} history={hEdit} focus={focus} onSelectionChange={reportSelection} />
            )}
            {!inDesktopShell() && active.kind === "idef0" && (
              <Idef0Editor
                key={active.key}
                display={display}
                model={draft}
                busy={busy}
                onSave={onSave}
                draftId={`${session.id}:studio`}
                draftBase={session.updatedAt}
                history={hEdit}
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
                sets={draft.object_sets ?? []}
                filterSet={activeSetObj ?? null}
                onSetOp={locked ? undefined : setOp}
                onClearFilter={() => chooseSet(null)}
              />
            )}
            {active.kind === "report" && <ReportView key={active.key} kind={active.report} session={session} model={draft} dirty={h.dirty} onChange={h.commit} filterSet={activeSetObj ? { id: activeSetObj.id, name: activeSetObj.name, nodeIds: setNodeIds(draft, activeSetObj.id) } : null} onClearFilter={() => chooseSet(null)} onSave={() => void save()} />}
          </div>
          {problemsOpen && <ProblemsPanel model={draft} issues={issues} onGoto={gotoIssue} proposals={proposals} onApplyProposal={applyProposal} onRejectProposal={rejectProposal} showTab={problemsTab} tasks={tasks} selectedFn={selectedFn} labelOf={fnLabel} onCreateTask={createTask} onCancelTask={cancelTask} questions={questions} onQuestionStatus={setQuestionStatus} reports={reports} onReportStatus={setReportStatus} onHandOffAnswers={handOffAnswers} sessionId={session.id} agentAccess={session.meta.confidential ? { confidential: true, allowed: agentAllowed } : undefined} onSetAgentAccess={setAgentAccess} nodeByCode={nodeByCode} onSelectFn={selectFn} onAssignFinding={assignFinding} acceptedIssues={split.accepted} fixFor={(i) => quickFixFor(draft, i)} onFix={fixIssue} onAccept={acceptOne} onRevoke={revokeOne} />}
        </div>
        {propsOpen && (
          <fieldset disabled={locked} className="props-fieldset">
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
            tabRequest={propsTabRequest}
            toolbar={{ dirty: h.dirty, busy, onSave: () => void save(), onRefresh: refreshFromServer, onFind: findInNavigator, onDuplicate: locked ? undefined : duplicate }}
          />
          </fieldset>
        )}
      </div>

      {wizardOpen && <StructureWizard model={draft} onApply={(next) => h.commit(seed(next, null))} onClose={() => setWizardOpen(false)} />}
      {notice && (
        <div className="bpe-banner" role="alert">
          {notice}
          <span className="spacer" />
          <button onClick={() => setNotice(null)}>Скрыть</button>
        </div>
      )}
      {exportError && (
        <div className="bpe-banner" role="alert">
          {exportError}
          <span className="spacer" />
          <button onClick={() => setExportError(null)}>Скрыть</button>
        </div>
      )}
      <div className="statusbar">
        {(() => {
          // как в Business Studio: при выбранном объекте строка состояния показывает его код, статус и происхождение
          const n = selection?.kind === "node" ? draft.nodes.find((x) => x.id === selection.id) : undefined;
          if (!n)
            return (
              <span>
                <b>{draft.process.name}</b> · {draft.process.type} · версия {draft.process.version} · статус: {draft.process.status}
              </span>
            );
          const code = idef0Codes(draft).get(n.id);
          return (
            <span data-status-object>
              {code && <>{code} </>}
              <b>{n.name}</b> · версия {lcVersion(n)}, {LC_STATUS_LABELS[lcStatus(n)].toLowerCase()} · {n.status === "confirmed" ? "подтверждён" : `гипотеза ${Math.round(n.confidence * 100)}%`} ·{" "}
              {n.source.length > 0 ? `из интервью (цитат: ${n.source.length})` : "создан вручную"} · версия процесса {draft.process.version}, {new Date(session.updatedAt).toLocaleString("ru-RU")}
            </span>
          );
        })()}
        <span className="muted">
          функций {fnCount} · шагов BPMN {shown.length} · связей {draft.flows.length} · исполнителей {draft.roles.length}
        </span>
        <span className="spacer" />
        <span className={errors ? "st-err" : "muted"}>ошибок: {errors}</span>
        <span className="muted">предупреждений: {warnings}</span>
        {split.accepted.length > 0 && <span className="muted">принято: {split.accepted.length}</span>}
        <span className={h.dirty ? "st-dirty" : "st-ok"}>{h.dirty ? "● есть несохранённые изменения" : "✓ сохранено"}</span>
      </div>
    </div>
  );
}
