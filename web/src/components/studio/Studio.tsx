import { loadDisplay, saveDisplay, type DisplayOptions } from "../editor-core/display";
import { deleteDiagramImpact } from "./usage-ops";
import { addToSet, createSet, deleteSet, removeFromSet, renameSet } from "./set-ops";
import { useEffect, useMemo, useRef, useState } from "react";
import { splitAccepted, validateModel } from "@shared/validate";
import { bpmnHosts, functionCodes, stepCodes } from "@shared/codes";
import { applyPatch } from "@shared/patch";
import { api, type AgentQuestionRow, type AgentReportRow, type AgentTaskRow, type Proposal, type ReportFinding } from "../../api/client";
import type { ProcessLogicModel, SessionRecord, ValidationIssue } from "../../types";
import { handleCommonKeys, isTextInput, useBeforeUnload, useDraftPersistence, useModelHistory } from "../editor-core/hooks";
import { DraftBanner } from "../editor-core/fields";
import BpmnEditor from "../bpmn-editor/BpmnEditor";
import Idef0Editor from "../idef0-editor/Idef0Editor";
import { positionsFromBpmnXml, visibleNodes, withLayout, withScopeLayouts } from "../bpmn-editor/geometry";
import { functionsOf, idef0Codes, withIdef0Layout } from "../idef0-editor/geometry";
import { addFunction } from "../idef0-editor/ops";
import { deleteNode, duplicateNode, updateNode } from "../bpmn-editor/model-ops";
import { diagramSvg, download, svgToPng } from "./export-image";
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

type M = ProcessLogicModel;

/** Начальное состояние черновика: роли и позиции фигур достроены (в черновиках, сохранённых раньше, полей новой версии модели нет). */
const normalize = (m: M): M =>
  m.assignments && m.pools && m.messages && m.accepted_issues ? m : { ...m, assignments: m.assignments ?? [], pools: m.pools ?? [], messages: m.messages ?? [], accepted_issues: m.accepted_issues ?? [] };
const seed = (m: M, bpmnXml: string | null | undefined): M => withIdef0Layout(withScopeLayouts(withLayout(normalize(m), false, positionsFromBpmnXml(bpmnXml))));

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

  const [docs, setDocs] = useState<StudioDoc[]>(() => [bpmnDoc(), idef0Doc(null)]);
  const [activeKey, setActiveKey] = useState("bpmn");
  const [focus, setFocus] = useState<{ id: string; nonce: number } | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [navOpen, setNavOpen] = useState(true);
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
  const fnAction = (action: "add-child" | "skeleton" | "duplicate" | "delete", id: string) => {
    const m = h.draftRef.current;
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
            <button className="ribbon-icon" aria-label="Предыдущая диаграмма" disabled={histTarget(-1) === null} onClick={() => goHist(-1)} title="Предыдущая открытая диаграмма (Alt+←)">
              ‹
            </button>
            <button className="ribbon-icon" aria-label="Следующая диаграмма" disabled={histTarget(1) === null} onClick={() => goHist(1)} title="Следующая открытая диаграмма (Alt+→)">
              ›
            </button>
            <button className="ribbon-icon" aria-label="Вверх: диаграмма выше" disabled={!upTarget()} onClick={goUp} title="Вверх: диаграмма, на которой стоит функция этой диаграммы">
              ↑
            </button>
            <button className="ribbon-icon" aria-label="Вниз: диаграмма ниже" disabled={!downTarget()} onClick={goDown} title="Вниз: декомпозиция выбранной функции или диаграмма BPMN её операции">
              ↓
            </button>
            <button className="ribbon-icon" onClick={findInNavigator} aria-label="Найти в навигаторе" title="Найти в навигаторе: показать в дереве выбранный элемент или текущую диаграмму">
              ⌖
            </button>
            {(active.kind === "bpmn" || active.kind === "idef0") && (
              <>
                <button className={`ribbon-icon ${display.labels ? "toggled" : ""}`} aria-label="Подписи" aria-pressed={display.labels} onClick={() => setDisplay({ labels: !display.labels })} title="Слой подписей: названия событий и шлюзов, условия и подписи стрелок. Названия внутри задач и блоков остаются">
                  Аб
                </button>
                <button
                  className={`ribbon-icon ${(active.kind === "bpmn" ? display.bpmnNumbers : display.idef0Numbers) ? "toggled" : ""}`}
                  aria-label="Номера"
                  aria-pressed={active.kind === "bpmn" ? display.bpmnNumbers : display.idef0Numbers}
                  onClick={() => setDisplay(active.kind === "bpmn" ? { bpmnNumbers: !display.bpmnNumbers } : { idef0Numbers: !display.idef0Numbers })}
                  title={active.kind === "bpmn" ? "Номера: код функции или шага на задачах диаграммы" : "Номера: код функции на блоках диаграммы"}
                >
                  №
                </button>
              </>
            )}
            <button onClick={() => open(bpmnDoc())}>Диаграмма BPMN</button>
            <button onClick={() => open(idef0Doc(null))}>Диаграмма IDEF0</button>
            <button onClick={() => addFn(active.kind === "idef0" ? active.parent : null)} title="Добавить функцию на текущую диаграмму IDEF0 (A0, если открыта другая вкладка)">
              + Функция
            </button>
            <button onClick={() => setWizardOpen(true)} title="Подпроцессы и операции списком: коды по Соглашению и заготовки диаграмм">
              Мастер структуры…
            </button>
            <button disabled={locked || selection?.kind !== "node"} onClick={duplicate} title="Копия выбранной функции или шага (Ctrl+D на диаграмме)">
              Дублировать
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
            <button className={full ? "toggled" : ""} onClick={() => setFull(!full)} title="Окно студии на весь экран — больше места для диаграммы">
              {full ? "Свернуть окно" : "На весь экран"}
            </button>
            <button className={problemsOpen ? "toggled" : ""} onClick={() => setProblemsOpen(!problemsOpen)}>
              Проверки{errors + warnings > 0 ? ` (${errors + warnings})` : ""}
            </button>
            <button
              className={proposals.length > 0 ? "attention" : ""}
              onClick={() => {
                setProblemsOpen(true);
                setProblemsTab({ tab: "proposals", nonce: ++nonce.current });
              }}
              title="Правки, которые предложил агент (Cline): вы решаете, применить их или отклонить"
            >
              Предложения{proposals.length > 0 ? ` (${proposals.length})` : ""}
            </button>
          </div>
          <div className="ribbon-caption">Вид</div>
        </div>
        <div className="ribbon-group">
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
          <div className="ribbon-group">
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
                      Лист в PDF
                    </a>
                    <a href={api.exportUrl(session.id, `idef0/${encodeURIComponent(diagram)}.print.html${q}`)} target="_blank" rel="noreferrer" {...guard}>
                      Печать…
                    </a>
                  </>
                );
              })()}
            </div>
            <div className="ribbon-caption">Печать листа IDEF0</div>
          </div>
        )}
        {onOpenImport && (
          <div className="ribbon-group">
            <div className="ribbon-buttons">
              <button onClick={onOpenImport} title="Загрузить правки из bpmn.io, Camunda Modeler или draw.io: переименования применятся, новые элементы появятся как гипотезы. Новую модель из Visio, Excel или изображения создают на странице «Новая сессия».">
                Импорт…
              </button>
            </div>
            <div className="ribbon-caption">Импорт</div>
          </div>
        )}
        <div className="ribbon-group">
          <div className="ribbon-buttons">
            <button onClick={() => void exportDiagram("svg")} title="Открытая диаграмма как на экране, в том числе с несохранёнными правками">
              SVG
            </button>
            <button onClick={() => void exportDiagram("png")} title="Открытая диаграмма как на экране, в том числе с несохранёнными правками">
              PNG
            </button>
          </div>
          <div className="ribbon-caption">Эта диаграмма</div>
        </div>
      </div>

      <div className="studio-body" style={{ gridTemplateColumns: `${navOpen ? "330px " : ""}minmax(0, 1fr)${propsOpen ? " 340px" : ""}` }}>
        {navOpen && (
          <Navigator model={draft} activeKey={active.key} selectedId={selection?.kind === "node" ? selection.id : null} onOpenDoc={open} onSelectFn={selectFn} onAddFunction={locked ? () => undefined : addFn} onOpenEntry={(dict, id) => { open(dictDoc(dict)); setSelection({ kind: "entry", dict, id }); }} onMoveFunction={locked ? undefined : moveFn} onFunctionAction={locked ? undefined : fnAction} onWizard={locked ? undefined : () => setWizardOpen(true)} reveal={navReveal} storageKey={session.id} onRenameFunction={locked ? undefined : renameFn} clipboard={clip} onCopy={locked ? undefined : copyFn} onCut={locked ? undefined : cutFn} onPaste={locked ? undefined : pasteFn} activeSet={activeSetId} onActiveSet={chooseSet} onSetOp={locked ? undefined : setOp} />
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
              <BpmnEditor key={active.key} display={display} scope={active.scope} model={draft} busy={busy} onSave={onSave} draftId={`${session.id}:studio`} draftBase={session.updatedAt} bpmnXml={session.bpmnXml} history={hEdit} focus={focus} onSelectionChange={reportSelection} />
            )}
            {active.kind === "idef0" && (
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
              />
            )}
            {active.kind === "report" && <ReportView key={active.key} kind={active.report} session={session} model={draft} dirty={h.dirty} onChange={h.commit} onSave={() => void save()} />}
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
        <span>
          <b>{draft.process.name}</b> · {draft.process.type} · версия {draft.process.version} · статус: {draft.process.status}
        </span>
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
