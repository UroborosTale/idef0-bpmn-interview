import { useEffect, useMemo, useRef, useState } from "react";
import { mergeScope, scopeView } from "@shared/scope";
import type { ProcessLogicModel } from "../../types";
import { handleCommonKeys, isTextInput, useBeforeUnload, useDraftPersistence, useHint, useModelHistory, useViewport, type Pt } from "../editor-core/hooks";
import { DraftBanner, RenameOverlay } from "../editor-core/fields";
import EditorToolbar from "../editor-core/EditorToolbar";
import { MIN_X, boxMap, boxOf, diagramExtras, isBoundary, laneIndexAtY, modelExtents, positionsFromBpmnXml, snap, snapTop, visibleNodes, withLayout } from "./geometry";
import MiniMap from "./MiniMap";
import { routeFlows } from "@shared/bpmnRouting";
import { alignLeft, alignMiddle, boundsOf, copyFragment, deleteGroup, distributeHorizontally, dropGroup, hasClipboard, moveGroup, nodesInRect, pasteFragment, selectableIds, setClipboard, takeClipboard } from "./selection-ops";
import { EVENT_PALETTE, PALETTE, addBoundaryEvent, addFlow, addNodeAt, addRole, addScopeLane, deleteFlow, deleteNode, dropNodeIntoLane, duplicateNode, moveNode, updateNode, type NewNodeSpec } from "./model-ops";
import { ArrowDefs, ArtifactShape, FlowShape, LanesLayer, MessageShape, NodeShape, PoolShape, UNASSIGNED_LANE } from "./shapes";
import type { Selection } from "../studio/selection";

type M = ProcessLogicModel;
type Sel = { kind: "node" | "flow" | "lane"; id: string } | null;
type Drag =
  | { kind: "pan"; sx: number; sy: number; tx: number; ty: number }
  | { kind: "node"; id: string; offX: number; offY: number; startModel: M; moved: boolean; sx: number; sy: number }
  | { kind: "connect"; from: string }
  | { kind: "marquee"; x0: number; y0: number; add: boolean }
  | { kind: "group"; id: string; ids: string[]; base: M; startModel: M; x0: number; y0: number; moved: boolean };

export default function BpmnEditor({
  model,
  busy,
  onSave,
  draftId,
  draftBase,
  bpmnXml,
  history,
  focus,
  onSelectionChange,
  scope,
}: {
  model: M;
  busy: boolean;
  onSave: (m: M) => Promise<boolean>;
  /** Ключ черновика (сессия + редактор) и версия модели, на которой он основан. */
  draftId: string;
  draftBase: string;
  /** Сгенерированный сервером BPMN: из него берутся позиции фигур, у которых их ещё нет. */
  bpmnXml?: string | null;
  /** Общая история окна студии: если задана, редактор работает с ней, а черновик и сохранение ведёт студия. */
  history?: ReturnType<typeof useModelHistory<M>>;
  /** Перейти к элементу (из навигатора или списка проверок); nonce меняется при каждом запросе. */
  focus?: { id: string; nonce: number } | null;
  /** Выделение сообщается окну студии — по нему панель «Свойства» показывает карточку объекта. Дорожка — это запись справочника «Исполнители». */
  onSelectionChange?: (sel: Selection) => void;
  /** Диаграмма BPMN операции (id функции IDEF0); null или не задано — общая схема процесса. */
  scope?: string | null;
}) {
  const local = useModelHistory<M>(() => withLayout(model, false, positionsFromBpmnXml(bpmnXml)));
  const h = history ?? local;
  const embedded = !!history;
  const { draftRef } = h;
  const scopeId = scope ?? null;
  // Диаграмма операции — вид модели на её шаги и дорожки; правки вида вливаются в полную модель (shared/scope.ts).
  const draft = useMemo(() => scopeView(h.draft, scopeId), [h.draft, scopeId]);
  const viewRef = useRef(draft);
  viewRef.current = draft;
  const setDraft = (fn: (m: M) => M) => h.setDraft((full) => mergeScope(full, fn(scopeView(full, scopeId)), scopeId));
  const persisted = useDraftPersistence<M>({ id: draftId, base: draftBase, draft: h.draft, dirty: h.dirty, restore: (m) => h.setDraft(m), enabled: !embedded });
  const [sel, setSel] = useState<Sel>(null);
  /** Несколько выделенных фигур (от двух); одна выделенная — это обычный sel. */
  const [multi, setMulti] = useState<string[]>([]);
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [showMap, setShowMap] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);
  const [hotLane, setHotLane] = useState<number | null>(null);
  const [connectTo, setConnectTo] = useState<Pt | null>(null);
  const [connectHot, setConnectHot] = useState<string | null>(null);
  const { hint, showHint } = useHint();

  const rootRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const { view, setView, fit, toWorld, zoomBy, centerOn } = useViewport(svgRef, wrapRef, () => modelExtents(viewRef.current));
  useBeforeUnload(h.dirty && !embedded);

  // переход к элементу по запросу извне
  useEffect(() => {
    if (!focus) return;
    const n = viewRef.current.nodes.find((x) => x.id === focus.id);
    if (n && !n.idef0_parent) {
      setSel({ kind: "node", id: n.id });
      centerOn(boxMap(visibleNodes(viewRef.current)).get(n.id) ?? boxOf(n));
    } else if (viewRef.current.flows.some((f) => f.id === focus.id)) setSel({ kind: "flow", id: focus.id });
    else if (viewRef.current.roles.some((r) => r.id === focus.id)) setSel({ kind: "lane", id: focus.id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.nonce]);

  const toSelection = (s: Sel): Selection => (!s ? null : s.kind === "lane" ? { kind: "entry", dict: "roles", id: s.id } : { kind: s.kind, id: s.id });
  /** Выбор мышью: сообщаем студии всегда, даже если выделен тот же элемент (панель могла уйти к другой записи). */
  const pick = (s: Sel) => {
    setSel(s);
    onSelectionChange?.(toSelection(s));
  };

  const nodeExists = (id: string) => draft.nodes.some((n) => n.id === id);
  const curSel: Sel =
    sel &&
    ((sel.kind === "node" && nodeExists(sel.id)) ||
      (sel.kind === "flow" && draft.flows.some((f) => f.id === sel.id)) ||
      (sel.kind === "lane" && draft.roles.some((r) => r.id === sel.id)))
      ? sel
      : null;

  const groupIds = multi.filter(nodeExists);
  const inGroup = groupIds.length >= 2;
  /** Что сейчас выделено: группа, одна фигура или ничего. */
  const pickedIds = inGroup ? groupIds : curSel?.kind === "node" ? [curSel.id] : [];

  // выделение изменилось не мышью (переход из навигатора, новая фигура, удаление) — тоже сообщаем
  useEffect(() => {
    onSelectionChange?.(toSelection(curSel));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curSel?.kind, curSel?.id]);

  /** Зафиксировать изменение как один шаг истории (и, если задано, сменить выделение). */
  const commit = (next: M, nextSel?: Sel) => {
    if (h.commit(mergeScope(draftRef.current, next, scopeId, viewRef.current)) && nextSel !== undefined) setSel(nextSel);
  };

  const save = async () => {
    const snapshot = draftRef.current;
    if (await onSave(snapshot)) h.markSaved(snapshot);
  };

  // --- указатель на холсте ---

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    rootRef.current?.focus();
    if (editing) return;
    const t = e.target as Element;
    const connectEl = t.closest("[data-connect]");
    const nodeEl = t.closest("[data-node-id]");
    const flowEl = t.closest("[data-flow-id]");
    const laneEl = t.closest("[data-lane-id]");
    const artifactEl = t.closest("[data-artifact]");
    const onEmpty = !connectEl && !nodeEl && !flowEl && !laneEl && !artifactEl;

    if (e.button === 0 && e.shiftKey && onEmpty) {
      // Shift + рамка: выделить несколько фигур (с Ctrl — добавить к уже выделенным)
      e.preventDefault();
      const [wx, wy] = toWorld(e.clientX, e.clientY);
      dragRef.current = { kind: "marquee", x0: wx, y0: wy, add: e.ctrlKey || e.metaKey };
      svgRef.current!.setPointerCapture(e.pointerId);
      return;
    }
    if (e.button === 1 || (e.button === 0 && onEmpty)) {
      e.preventDefault();
      if (e.button === 0) {
        pick(null);
        setMulti([]);
      }
      dragRef.current = { kind: "pan", sx: e.clientX, sy: e.clientY, tx: view.tx, ty: view.ty };
      svgRef.current!.setPointerCapture(e.pointerId);
      return;
    }
    if (e.button !== 0) return;

    if (connectEl) {
      dragRef.current = { kind: "connect", from: connectEl.getAttribute("data-connect")! };
      setConnectTo(toWorld(e.clientX, e.clientY));
      svgRef.current!.setPointerCapture(e.pointerId);
    } else if (nodeEl) {
      const id = nodeEl.getAttribute("data-node-id")!;
      const n = draft.nodes.find((x) => x.id === id);
      if (!n) return;
      if (e.shiftKey && !isBoundary(n, draft.nodes)) {
        // Shift + щелчок: добавить фигуру в выделение или убрать из него
        const cur = inGroup ? groupIds : curSel?.kind === "node" ? [curSel.id] : [];
        const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
        setMulti(next.length >= 2 ? next : []);
        pick(next.length === 1 ? { kind: "node", id: next[0] } : next.length === 0 ? null : { kind: "node", id });
        return;
      }
      if (inGroup && groupIds.includes(id)) {
        // потянули фигуру из выделенной группы — едет вся группа
        const [wx, wy] = toWorld(e.clientX, e.clientY);
        dragRef.current = { kind: "group", id, ids: groupIds, base: viewRef.current, startModel: draftRef.current, x0: wx, y0: wy, moved: false };
        svgRef.current!.setPointerCapture(e.pointerId);
        return;
      }
      setMulti([]);
      pick({ kind: "node", id });
      if (isBoundary(n, draft.nodes)) {
        dragRef.current = null; // граничное событие стоит на границе задачи — его не переносят
        return;
      }
      const b = boxOf(n);
      const [wx, wy] = toWorld(e.clientX, e.clientY);
      dragRef.current = { kind: "node", id, offX: wx - b.x, offY: wy - b.y, startModel: draftRef.current, moved: false, sx: e.clientX, sy: e.clientY };
      svgRef.current!.setPointerCapture(e.pointerId);
    } else if (artifactEl) {
      setMulti([]);
      pick({ kind: "node", id: artifactEl.getAttribute("data-artifact")! });
    } else if (flowEl) {
      setMulti([]);
      pick({ kind: "flow", id: flowEl.getAttribute("data-flow-id")! });
    } else if (laneEl) {
      setMulti([]);
      const id = laneEl.getAttribute("data-lane-id")!;
      pick(id === UNASSIGNED_LANE ? null : { kind: "lane", id });
    }
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const d = dragRef.current;
    if (!d) return;
    if (d.kind === "pan") {
      setView((v) => ({ ...v, tx: d.tx + e.clientX - d.sx, ty: d.ty + e.clientY - d.sy }));
    } else if (d.kind === "node") {
      if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 4) return;
      d.moved = true;
      const [wx, wy] = toWorld(e.clientX, e.clientY);
      setDraft((m) => moveNode(m, d.id, Math.max(MIN_X, snap(wx - d.offX)), snapTop(wy - d.offY, boxOf(m.nodes.find((x) => x.id === d.id)!).h)));
      setHotLane(laneIndexAtY(viewRef.current, wy));
    } else if (d.kind === "marquee") {
      const [wx, wy] = toWorld(e.clientX, e.clientY);
      setMarquee({ x: Math.min(d.x0, wx), y: Math.min(d.y0, wy), w: Math.abs(wx - d.x0), h: Math.abs(wy - d.y0) });
    } else if (d.kind === "group") {
      const [wx, wy] = toWorld(e.clientX, e.clientY);
      if (!d.moved && Math.hypot(wx - d.x0, wy - d.y0) * view.k < 4) return;
      d.moved = true;
      setDraft(() => moveGroup(d.base, d.ids, wx - d.x0, wy - d.y0));
    } else {
      setConnectTo(toWorld(e.clientX, e.clientY));
      const target = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-node-id]")?.getAttribute("data-node-id") ?? null;
      setConnectHot(target && target !== d.from ? target : null);
    }
  };

  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (svgRef.current?.hasPointerCapture(e.pointerId)) svgRef.current.releasePointerCapture(e.pointerId);
    if (!d) return;
    if (d.kind === "node" && d.moved) {
      h.recordPast(d.startModel);
      setDraft((m) => dropNodeIntoLane(m, d.id));
      setHotLane(null);
    } else if (d.kind === "group") {
      if (d.moved) {
        h.recordPast(d.startModel);
        setDraft((m) => dropGroup(m, d.ids));
      } else {
        // щелчок без движения по члену группы — оставляем только эту фигуру
        setMulti([]);
        pick({ kind: "node", id: d.id });
      }
    } else if (d.kind === "marquee") {
      const rect = marquee;
      setMarquee(null);
      if (!rect || (rect.w < 3 && rect.h < 3)) return;
      const hit = nodesInRect(viewRef.current, rect);
      const ids = d.add ? [...new Set([...pickedIds, ...hit])] : hit;
      setMulti(ids.length >= 2 ? ids : []);
      pick(ids.length === 1 ? { kind: "node", id: ids[0] } : ids.length > 1 ? { kind: "node", id: ids[ids.length - 1] } : null);
    } else if (d.kind === "connect") {
      const target = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-node-id]")?.getAttribute("data-node-id");
      setConnectTo(null);
      setConnectHot(null);
      if (target && target !== d.from) {
        const r = addFlow(viewRef.current, d.from, target);
        if (r.error) showHint(r.error);
        else commit(r.model, { kind: "flow", id: r.id! });
      }
    }
  };

  const onDoubleClick = (e: React.MouseEvent<SVGSVGElement>) => {
    const id = (e.target as Element).closest("[data-node-id]")?.getAttribute("data-node-id");
    if (id) setEditing(id);
  };

  // --- добавление элементов ---

  const addFromPalette = (spec: NewNodeSpec, at?: Pt) => {
    const m = viewRef.current;
    let cx: number, cy: number;
    const from = curSel?.kind === "node" ? m.nodes.find((n) => n.id === curSel.id) : undefined;
    if (at) {
      [cx, cy] = at;
    } else if (from) {
      const b = boxMap(visibleNodes(m)).get(from.id) ?? boxOf(from);
      cx = b.x + b.w + 100;
      cy = b.y + b.h / 2;
    } else {
      const r = svgRef.current!.getBoundingClientRect();
      [cx, cy] = toWorld(r.left + r.width / 2, r.top + r.height / 2);
    }
    const added = addNodeAt(m, spec, cx, cy);
    let next = added.model;
    // «быстрое продолжение»: новая фигура сразу соединяется с выбранной
    if (!at && from) {
      const linked = addFlow(next, from.id, added.id!);
      if (!linked.error) next = linked.model;
    }
    commit(next, { kind: "node", id: added.id! });
    setEditing(added.id!);
  };

  /** Граничное событие на выбранной задаче (или на задаче, к которой прикреплено выбранное граничное событие). */
  const addBoundary = () => {
    const m = viewRef.current;
    const picked = curSel?.kind === "node" ? m.nodes.find((n) => n.id === curSel.id) : undefined;
    const hostId = picked && isBoundary(picked, m.nodes) ? picked.attached_to : picked?.id;
    if (!hostId) return showHint("Выберите задачу, к которой нужно прикрепить событие");
    const r = addBoundaryEvent(m, hostId);
    if (r.error) showHint(r.error);
    else commit(r.model, { kind: "node", id: r.id! });
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const raw = e.dataTransfer.getData("application/x-bpmn-new");
    if (!raw) return;
    addFromPalette(JSON.parse(raw) as NewNodeSpec, toWorld(e.clientX, e.clientY));
  };

  // --- группа: копирование, вставка, выравнивание ---

  /** Выделить набор фигур: две и больше — группа, одна — обычное выделение. */
  const selectIds = (ids: string[]) => {
    setMulti(ids.length >= 2 ? ids : []);
    pick(ids.length === 0 ? null : { kind: "node", id: ids[ids.length - 1] });
  };
  const copySelected = () => {
    const frag = copyFragment(viewRef.current, pickedIds);
    if (!frag) return showHint("Сначала выделите фигуры");
    setClipboard(frag);
    showHint(`Скопировано: ${frag.nodes.length} (Ctrl+V — вставить, можно в другую диаграмму)`);
  };
  const pasteClipboard = () => {
    const c = takeClipboard();
    if (!c) return showHint("Буфер пуст: выделите фигуры и нажмите Ctrl+C");
    const full = draftRef.current;
    const off = 40 * c.n;
    const r = pasteFragment(viewRef.current, c.fragment, off, off, { nodes: full.nodes.map((n) => n.id), flows: full.flows.map((f) => f.id) });
    commit(r.model);
    selectIds(r.ids);
  };
  const duplicateSelected = () => {
    const frag = copyFragment(viewRef.current, pickedIds);
    if (!frag) return;
    const full = draftRef.current;
    const r = pasteFragment(viewRef.current, frag, 40, 0, { nodes: full.nodes.map((n) => n.id), flows: full.flows.map((f) => f.id) });
    commit(r.model);
    selectIds(r.ids);
  };
  const deleteSelected = () => {
    if (pickedIds.length === 0) return;
    commit(deleteGroup(draft, pickedIds), null);
    setMulti([]);
  };
  const zoomToSelection = () => {
    const b = boundsOf(draft, pickedIds);
    const el = wrapRef.current;
    if (!b || !el) return showHint("Сначала выделите фигуры");
    const k = Math.min(1.5, Math.max(0.3, Math.min(el.clientWidth / (b.w + 120), el.clientHeight / (b.h + 120))));
    setView({ k, tx: el.clientWidth / 2 - (b.x + b.w / 2) * k, ty: el.clientHeight / 2 - (b.y + b.h / 2) * k });
  };

  // --- клавиатура ---

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (isTextInput(e.target)) return;
    if (handleCommonKeys(e, { undo: h.undo, redo: h.redo, save: () => h.dirty && !busy && void save() })) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = (l: string) => e.key.toLowerCase() === l || e.code === `Key${l.toUpperCase()}`; // в русской раскладке key — другая буква
    if (mod && key("a")) {
      e.preventDefault();
      selectIds(selectableIds(draft));
    } else if (mod && key("c")) {
      e.preventDefault();
      copySelected();
    } else if (mod && key("x")) {
      e.preventDefault();
      copySelected();
      deleteSelected();
    } else if (mod && key("v")) {
      e.preventDefault();
      pasteClipboard();
    } else if (mod && key("d") && inGroup) {
      e.preventDefault();
      duplicateSelected();
    } else if (mod && key("d") && curSel?.kind === "node") {
      e.preventDefault(); // иначе браузер добавит страницу в закладки
      const r = duplicateNode(draft, curSel.id);
      if (!r.error) commit(r.model, { kind: "node", id: r.id! });
    } else if (e.key.startsWith("Arrow") && inGroup) {
      e.preventDefault();
      const step = e.shiftKey ? 50 : 10;
      const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
      const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
      commit(dropGroup(moveGroup(draft, groupIds, dx, dy), groupIds));
    } else if (e.key.startsWith("Arrow") && curSel?.kind === "node") {
      // стрелки сдвигают выбранную фигуру на шаг сетки (Shift — на 5 шагов); вертикально фигура остаётся в дорожке
      e.preventDefault();
      const n = draft.nodes.find((x) => x.id === curSel.id);
      if (!n || isBoundary(n, draft.nodes)) return;
      const step = e.shiftKey ? 5 * 10 : 10;
      const b = boxOf(n);
      const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
      const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
      commit(dropNodeIntoLane(moveNode(draft, n.id, Math.max(MIN_X, b.x + dx), b.y + dy), n.id));
    } else if ((e.key === "Delete" || e.key === "Backspace") && inGroup) {
      e.preventDefault();
      deleteSelected();
    } else if ((e.key === "Delete" || e.key === "Backspace") && curSel) {
      e.preventDefault();
      if (curSel.kind === "node") commit(deleteNode(draft, curSel.id), null);
      else if (curSel.kind === "flow") commit(deleteFlow(draft, curSel.id), null);
    } else if (e.key === "Escape") {
      setMulti([]);
      setSel(null);
      setEditing(null);
    }
  };

  // --- отрисовка ---

  const { w: worldW, h: worldH } = modelExtents(draft);
  const W = Math.max(worldW, 1400);
  // фигуры, документы, пулы и ВСЕ стрелки считаются вместе (shared/bpmnRouting.ts): без общих портов и наложений линий
  const { shown, boxes, extras, routes, bottomUsed } = useMemo(() => {
    const shown = visibleNodes(draft);
    const boxes = boxMap(shown);
    const extras = diagramExtras(draft, shown, boxes);
    const withArtifacts = new Set(extras.artifacts.map((a) => a.nodeId));
    const poolIds = new Set(extras.pools.map((p) => p.pool.id));
    const end = (id: string) => (poolIds.has(id) ? `pool:${id}` : id);
    const routes = routeFlows(
      [...shown.map((n) => ({ id: n.id, box: boxes.get(n.id)!, type: n.type, boundary: isBoundary(n, shown), artifacts: withArtifacts.has(n.id) })), ...extras.pools.map((p) => ({ id: `pool:${p.pool.id}`, box: p.box, type: "pool" }))],
      [...draft.flows.filter((f) => boxes.has(f.from) && boxes.has(f.to)).map((f) => ({ id: f.id, from: f.from, to: f.to })), ...extras.messages.map(({ message }) => ({ id: `msg:${message.id}`, from: end(message.from), to: end(message.to), message: true }))],
      extras.artifacts.map((a) => a.box)
    );
    // фигуры, у нижней вершины которых проходит стрелка: подпись таких фигур сдвигается левее линии
    const bottomUsed = new Set<string>();
    for (const f of draft.flows) {
      const pts = routes.get(f.id);
      const a = boxes.get(f.from);
      const b = boxes.get(f.to);
      if (!pts || !a || !b) continue;
      if (Math.abs(pts[0][1] - (a.y + a.h)) < 0.5) bottomUsed.add(f.from);
      if (Math.abs(pts[pts.length - 1][1] - (b.y + b.h)) < 0.5) bottomUsed.add(f.to);
    }
    return { shown, boxes, extras, routes, bottomUsed };
  }, [draft]);  const selectedNode = curSel?.kind === "node" ? draft.nodes.find((n) => n.id === curSel.id) : undefined;
  const editingNode = editing ? draft.nodes.find((n) => n.id === editing) : undefined;

  return (
    <div className="bpe" ref={rootRef} tabIndex={-1} onKeyDown={onKeyDown}>
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
      <EditorToolbar
        canUndo={h.canUndo}
        canRedo={h.canRedo}
        onUndo={h.undo}
        onRedo={h.redo}
        zoom={view.k}
        onZoomOut={() => zoomBy(1 / 1.2)}
        onZoomIn={() => zoomBy(1.2)}
        onFit={fit}
        onActual={() => setView((v) => ({ ...v, k: 1, tx: 10, ty: 10 }))}
        dirty={h.dirty}
        busy={busy}
        hint={hint}
        onSave={() => void save()}
        compact={embedded}
        extra={
          <>
            <button onClick={() => commit(withLayout(draft, true))} title="Расставить все фигуры заново (можно отменить)">
              Авто-раскладка
            </button>
            <button className={showMap ? "on" : ""} onClick={() => setShowMap((v) => !v)} title="Миникарта диаграммы">
              Миникарта
            </button>
          </>
        }
      />

      <div className="bpe-body">
        <div className="bpe-palette">
          <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>
            Перетащите на холст или нажмите
          </div>
          <div className="muted" style={{ fontSize: 10.5, marginBottom: 6 }}>
            Shift + рамка или Shift + щелчок — выделить несколько; Ctrl+C / V — копировать.
          </div>
          {PALETTE.map((p) => (
            <button
              key={p.label}
              draggable
              onDragStart={(e) => e.dataTransfer.setData("application/x-bpmn-new", JSON.stringify(p.spec))}
              onClick={() => addFromPalette(p.spec)}
            >
              {p.label}
            </button>
          ))}
          <details className="bpe-palette-more">
            <summary title="Начало, ожидание, отправка и конец с триггером: сообщение, таймер, условие, сигнал, ошибка, ссылка…">События с триггером</summary>
            {["Начало", "Ожидание", "Отправка", "Конец"].map((group) => (
              <div key={group}>
                <div className="muted bpe-palette-group">{group}</div>
                {EVENT_PALETTE.filter((p) => p.group === group).map((p) => (
                  <button key={p.label} draggable onDragStart={(e) => e.dataTransfer.setData("application/x-bpmn-new", JSON.stringify(p.spec))} onClick={() => addFromPalette(p.spec)}>
                    {p.label}
                  </button>
                ))}
              </div>
            ))}
          </details>
          <button onClick={addBoundary} title="Таймер, сообщение или ошибка на границе выбранной задачи (вид меняется в свойствах)">
            Гр. событие
          </button>
          <button style={{ marginTop: 10 }} onClick={() => (scopeId ? h.commit(addScopeLane(draftRef.current, scopeId).model) : commit(addRole(draft).model))} title={scopeId ? "Новая роль и исполнитель этой операции" : undefined}>
            + Дорожка
          </button>
        </div>

        <div className="bpe-canvas" ref={wrapRef} onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
          <svg
            ref={svgRef}
            className="bpe-svg"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onDoubleClick={onDoubleClick}
          >
            <ArrowDefs />
            <g transform={`translate(${view.tx} ${view.ty}) scale(${view.k})`}>
              <LanesLayer model={draft} width={W} hotLane={hotLane} selectedLaneId={curSel?.kind === "lane" ? curSel.id : null} />

              {draft.flows.map((f) => {
                const points = routes.get(f.id);
                return points ? <FlowShape key={f.id} flow={f} points={points} selected={curSel?.kind === "flow" && curSel.id === f.id} /> : null;
              })}

              {extras.messages.map(({ message, points }) => (
                <MessageShape key={message.id} points={routes.get(`msg:${message.id}`) ?? points} label={message.name} />
              ))}
              {extras.pools.map(({ pool, box }) => (
                <PoolShape key={pool.id} pool={pool} box={box} />
              ))}
              {extras.artifacts.map((a) => (
                <ArtifactShape key={a.key} artifact={a} />
              ))}

              {shown.map((n) => (
                <NodeShape key={n.id} node={n} box={boxes.get(n.id)!} selected={inGroup ? groupIds.includes(n.id) : curSel?.kind === "node" && curSel.id === n.id} hot={connectHot === n.id} boundary={isBoundary(n, shown)} labelLeft={bottomUsed.has(n.id)} />
              ))}

              {inGroup && (() => {
                const b = boundsOf(draft, groupIds);
                return b && <rect data-group-box x={b.x - 8} y={b.y - 8} width={b.w + 16} height={b.h + 16} fill="none" stroke="#4338ca" strokeWidth={1} strokeDasharray="5 4" pointerEvents="none" />;
              })()}
              {marquee && <rect data-marquee x={marquee.x} y={marquee.y} width={marquee.w} height={marquee.h} fill="rgba(67,56,202,0.08)" stroke="#4338ca" strokeDasharray="4 3" pointerEvents="none" />}

              {!inGroup && selectedNode && !(selectedNode.type === "event" && selectedNode.subtype === "end") && !editing && (
                <g data-connect={selectedNode.id} style={{ cursor: "crosshair" }}>
                  <circle cx={boxes.get(selectedNode.id)!.x + boxes.get(selectedNode.id)!.w + 16} cy={boxes.get(selectedNode.id)!.y + boxes.get(selectedNode.id)!.h / 2} r={9} fill="#4338ca" />
                  <path
                    d={`M${boxes.get(selectedNode.id)!.x + boxes.get(selectedNode.id)!.w + 12} ${boxes.get(selectedNode.id)!.y + boxes.get(selectedNode.id)!.h / 2} h8 m-3 -3 l3 3 l-3 3`}
                    stroke="#fff"
                    strokeWidth={1.8}
                    fill="none"
                    pointerEvents="none"
                  />
                </g>
              )}

              {connectTo && dragRef.current?.kind === "connect" && (() => {
                const b = boxes.get((dragRef.current as { from: string }).from);
                if (!b) return null;
                return <path d={`M${b.x + b.w} ${b.y + b.h / 2} L${connectTo[0]} ${connectTo[1]}`} stroke="#4338ca" strokeWidth={2} strokeDasharray="6 4" fill="none" pointerEvents="none" />;
              })()}
            </g>
          </svg>

          {editingNode && (
            <RenameOverlay
              key={editingNode.id}
              name={editingNode.name}
              box={boxes.get(editingNode.id) ?? boxOf(editingNode)}
              view={view}
              onCommit={(v) => commit(updateNode(viewRef.current, editingNode.id, { name: v }))}
              onDone={() => setEditing(null)}
            />
          )}
          {shown.length === 0 && (
            <div className="bpe-empty">
              <b>Диаграмма пуста</b>
              <span>
                Перетащите фигуру из палитры слева или нажмите на неё — например, «Начало». Выберите фигуру и потяните за ● справа, чтобы провести стрелку.
                {scopeId && " Дорожки — исполнители операции: назначьте их в свойствах операции или добавьте кнопкой «+ Дорожка»."}
              </span>
            </div>
          )}
          {(pickedIds.length > 0 || hasClipboard()) && (
            <div className="bpe-selbar" role="toolbar" aria-label="Действия с выделением">
              {pickedIds.length > 0 && <span className="muted">Выделено: {pickedIds.length}</span>}
              <button disabled={pickedIds.length === 0} onClick={copySelected} title="Копировать (Ctrl+C)">
                Копировать
              </button>
              <button disabled={!hasClipboard()} onClick={pasteClipboard} title="Вставить (Ctrl+V); фрагмент можно вставить в другую диаграмму">
                Вставить
              </button>
              <button disabled={pickedIds.length === 0} onClick={zoomToSelection} title="Показать выделенное крупно">
                Приблизить
              </button>
              {inGroup && (
                <>
                  <button onClick={() => commit(alignLeft(draft, groupIds))} title="Выровнять по левому краю">
                    ⇤ Влево
                  </button>
                  <button onClick={() => commit(alignMiddle(draft, groupIds))} title="Выровнять центры по одной линии (фигуры остаются в своих дорожках)">
                    ⇔ По линии
                  </button>
                  <button disabled={groupIds.length < 3} onClick={() => commit(distributeHorizontally(draft, groupIds))} title="Равные промежутки по горизонтали (нужно три фигуры)">
                    ⇹ Поровну
                  </button>
                </>
              )}
              <button disabled={pickedIds.length === 0} onClick={deleteSelected} title="Удалить выделенное (Delete)">
                Удалить
              </button>
            </div>
          )}
          {showMap && shown.length > 0 && (
            <MiniMap
              nodes={shown.map((n) => ({ id: n.id, box: boxes.get(n.id)!, type: n.type, selected: pickedIds.includes(n.id) }))}
              world={{ w: W, h: worldH }}
              view={view}
              size={{ w: wrapRef.current?.clientWidth ?? 800, h: wrapRef.current?.clientHeight ?? 400 }}
              onCenter={(wx, wy) => centerOn({ x: wx, y: wy, w: 0, h: 0 })}
            />
          )}
          <div className="bpe-corner muted">
            {shown.length} элем. · {draft.flows.length} связей · {Math.round(worldH)}px
          </div>
        </div>
      </div>
    </div>
  );
}
