import { bpmnFrameDefaults, bpmnFrameShown, bpmnSheetWorld, frameGeometry, gridShown, type FrameField } from "@shared/idef0Frame";
import { processCodeOf } from "@shared/codes";
import { setSheetFrame, type FramePatch } from "../editor-core/sheet-ops";
import { FrameLayer, FrameMenu, dragRect, startFrameDrag, type FrameDrag } from "../editor-core/sheetFrame";
import { DEFAULT_DISPLAY, type DisplayOptions } from "../editor-core/display";
import { stepCodes } from "@shared/codes";
import { idef0Codes } from "../idef0-editor/geometry";
import { useEffect, useMemo, useRef, useState } from "react";
import { mergeScope, scopeView } from "@shared/scope";
import type { ProcessLogicModel } from "../../types";
import { handleCommonKeys, isTextInput, useBeforeUnload, useDraftPersistence, useHint, useModelHistory, useViewport, type Pt } from "../editor-core/hooks";
import { DraftBanner, RenameOverlay } from "../editor-core/fields";
import EditorToolbar from "../editor-core/EditorToolbar";
import { LANE_H, MAX_LANE_H, MIN_LANE_H, MIN_X, boxMap, boxOf, configuredWidth, diagramLayout, diagramWidth, isBoundary, laneBandAt, laneCount, laneHeight, laneIndexAtY, laneIndexOfRole, laneTop, modelExtents, positionsFromBpmnXml, snap, snapTop, triggerView, visibleNodes, withLayout } from "./geometry";
import MiniMap from "./MiniMap";
import { positionOnSide } from "@shared/bpmnManual";
import { MIN_HANDLE_LEN, addBend, dragCorner, dragSegment, removeBend, type FlowGeometry } from "./flow-edit";
import { GUIDE_SNAP_PX, guideFor, guideTargets, snapAxis, snapShape, type Guide, type GuideTarget } from "./guides";
import { alignLeft, alignMiddle, boundsOf, copyFragment, deleteGroup, distributeHorizontally, dropGroup, hasClipboard, moveGroup, nodesInRect, pasteFragment, selectableIds, setClipboard, takeClipboard } from "./selection-ops";
import { BLOCK_TRIGGERS, EVENT_PALETTE, PALETTE, diagramMinWidth, laneMinHeight, setDiagramWidth, setLaneHeight, setArtifactOffset, setPoolOffset, addPool, addMessage, addBoundaryEvent, attachTrigger, deleteTriggerEvent, nearestSide, reconnectFlow, setFlowRoute, type FlowSide, addFlow, addNodeAt, addRole, addScopeLane, deleteFlow, deleteMessage, deletePool, deleteNode, updateMessage, updatePool, dropNodeIntoLane, duplicateNode, moveNode, updateFlow, updateNode, type NewNodeSpec } from "./model-ops";
import { ArrowDefs, ArtifactShape, FlowShape, LaneResizeHandles, LanesLayer, MessageShape, NodeShape, PoolShape, TriggerMarkers, nodeStyle, UNASSIGNED_LANE } from "./shapes";
import type { Selection } from "../studio/selection";
import { entryOf, updateEntry } from "../studio/dict-ops";

type M = ProcessLogicModel;
type Sel = { kind: "node" | "flow" | "lane"; id: string } | { kind: "artifact"; dict: "data" | "systems"; id: string; node: string; key: string } | { kind: "pool" | "message"; id: string } | null;
type Drag =
  | { kind: "pan"; sx: number; sy: number; tx: number; ty: number }
  | { kind: "node"; id: string; offX: number; offY: number; startModel: M; moved: boolean; sx: number; sy: number; keep: { x: boolean; y: boolean } }
  | { kind: "connect"; from: string }
  | { kind: "pool"; id: string; dx0: number; dy0: number; x0: number; y0: number; startModel: M; moved: boolean }
  | { kind: "artifact"; nodeId: string; key: string; dx0: number; dy0: number; x0: number; y0: number; startModel: M; moved: boolean }
  | { kind: "marquee"; x0: number; y0: number; add: boolean }
  | { kind: "laneStretch"; base: M; startModel: M; x0: number; w0: number; moved: boolean }
  | { kind: "laneResize"; i: number; base: M; startModel: M; y0: number; h0: number; moved: boolean }
  | { kind: "flowSeg"; id: string; i: number; axis: "x" | "y"; g: FlowGeometry; startModel: M; moved: boolean; x0: number; y0: number }
  | { kind: "flowCorner"; id: string; i: number; v: Pt; g: FlowGeometry; startModel: M; moved: boolean; x0: number; y0: number }
  | { kind: "flowEnd"; id: string; end: "from" | "to" }
  | { kind: "group"; id: string; ids: string[]; base: M; startModel: M; x0: number; y0: number; moved: boolean; keep: { x: boolean; y: boolean } }
  | ({ kind: "frame"; startModel: M } & FrameDrag);

/** Лист по умолчанию накрывает дорожки целиком (их ширина не меньше 1400) и всё, что ниже, с полем вокруг. */
const sheetWorld = (m: M) => bpmnSheetWorld({ w: diagramWidth(m), h: modelExtents(m).h });

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
  display = DEFAULT_DISPLAY,
}: {
  /** Вид на экране: слой подписей и номера шагов. */
  display?: DisplayOptions;
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
  // номера на задачах: коды функций общей схемы и шагов диаграммы операции (считаются по полной модели, у вида области шаги без scope)
  const numbers = useMemo(() => (display.bpmnNumbers ? new Map([...idef0Codes(h.draft), ...stepCodes(h.draft)]) : null), [display.bpmnNumbers, h.draft]);
  const setDraft = (fn: (m: M) => M) => h.setDraft((full) => mergeScope(full, fn(scopeView(full, scopeId)), scopeId));
  const persisted = useDraftPersistence<M>({ id: draftId, base: draftBase, draft: h.draft, dirty: h.dirty, restore: (m) => h.setDraft(m), enabled: !embedded });
  const [sel, setSel] = useState<Sel>(null);
  /** Несколько выделенных фигур (от двух); одна выделенная — это обычный sel. */
  const [multi, setMulti] = useState<string[]>([]);
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [showMap, setShowMap] = useState(true);
  /** Конец стрелки в руках пользователя: куда он сейчас указывает (точка, фигура под ней, ближайшая сторона). */
  const [flowGhost, setFlowGhost] = useState<{ id: string; end: "from" | "to"; pt: Pt; target: string | null; side: FlowSide | null; pos: number | null } | null>(null);
  /** Направляющие выравнивания: ровные линии, которые видны, пока отрезок, излом или конец стрелки перетаскивают и он выровнен с чем-то. */
  const [guides, setGuides] = useState<Guide[]>([]);
  /** Дорожка, высоту которой сейчас тянут: её нижняя граница подсвечена. */
  const [resizingLane, setResizingLane] = useState<number | null>(null);
  /** Правый край дорожек тянут: он подсвечен. */
  const [stretching, setStretching] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  /** Инструмент «Поток сообщений»: щелчок по началу (шаг или пул), затем по концу — парному объекту. from — уже выбранное начало. */
  const [msgTool, setMsgTool] = useState<{ from: string | null } | null>(null);
  // другая диаграмма — инструмент начинается заново: начало, выбранное на прежней, к этой не относится
  useEffect(() => setMsgTool(null), [scope]);
  /** Правка текста стрелки (условие ветки) или значка-триггера на блоке; at — где открыть поле, в координатах диаграммы. */
  const [editSpot, setEditSpot] = useState<{ kind: "flow" | "marker" | "artifact" | "pool" | "message" | "frame"; id: string; dict?: "data" | "systems"; at: Pt } | null>(null);
  const [hotLane, setHotLane] = useState<number | null>(null);
  const [connectTo, setConnectTo] = useState<Pt | null>(null);
  const [connectHot, setConnectHot] = useState<string | null>(null);
  const { hint, showHint } = useHint();

  const rootRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<Drag | null>(null);
  // рамка листа (по умолчанию выключена) хранится в полной модели по ключу операции, "" — общая схема процесса
  const frameKeyBpmn = scopeId ?? "";
  const frame = h.draft.bpmn_frames?.[frameKeyBpmn];
  const frameRef = useRef(frame);
  frameRef.current = frame;
  /** Всё, что показывает «Вписать»: содержимое и включённый лист со штампом. */
  const fitWorld = () => {
    const ext = modelExtents(viewRef.current);
    if (!bpmnFrameShown(frameRef.current)) return ext;
    const s = frameGeometry(sheetWorld(viewRef.current), frameRef.current, { node: "", title: "", no: "" }).sheet;
    return { w: Math.max(ext.w, s.x + s.w), h: Math.max(ext.h, s.y + s.h) };
  };
  const { view, setView, fit, toWorld, zoomBy, centerOn } = useViewport(svgRef, wrapRef, fitWorld);
  const setSheet = (patch: FramePatch) => h.commit(setSheetFrame(h.draftRef.current, "bpmn_frames", frameKeyBpmn, patch));
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

  const toSelection = (s: Sel): Selection => (!s ? null : s.kind === "lane" ? { kind: "entry", dict: "roles", id: s.id } : s.kind === "artifact" ? { kind: "entry", dict: s.dict, id: s.id } : s.kind === "pool" || s.kind === "message" ? { kind: s.kind, id: s.id } : { kind: s.kind, id: s.id });
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
      (sel.kind === "lane" && draft.roles.some((r) => r.id === sel.id)) ||
      (sel.kind === "artifact" && !!entryOf(draft, sel.dict, sel.id)) ||
      (sel.kind === "pool" && (draft.pools ?? []).some((p) => p.id === sel.id)) ||
      (sel.kind === "message" && (draft.messages ?? []).some((x) => x.id === sel.id)))
      ? sel
      : null;

  /** Выбранная стрелка с ручками: поток управления (его id) или поток сообщений ("msg:<id>"). */
  const routedId = curSel?.kind === "flow" ? curSel.id : curSel?.kind === "message" ? `msg:${curSel.id}` : null;

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
    if (msgTool && e.button === 0) {
      // инструмент «Поток сообщений»: выбираем начало и конец щелчками, остальные действия мыши отключены
      const id = t.closest("[data-node-id]")?.getAttribute("data-node-id") ?? t.closest("[data-pool-id]")?.getAttribute("data-pool-id") ?? t.closest("[data-artifact]")?.getAttribute("data-artifact");
      if (!id) {
        showHint("Щёлкните по шагу диаграммы или по внешнему пулу. Esc — отмена.");
        return;
      }
      if (!msgTool.from) {
        setMsgTool({ from: id });
        showHint("Теперь щёлкните по второму концу: шаг — для пула, пул — для шага.");
        return;
      }
      const r = addMessage(viewRef.current, msgTool.from, id);
      if (r.error) {
        showHint(r.error);
        setMsgTool({ from: null });
        return;
      }
      setMsgTool(null);
      commit(r.model, { kind: "message", id: r.id! });
      return;
    }
    // лист: штамп двигает, края и углы растягивают
    const frameDrag = frameOn && e.button === 0 ? startFrameDrag(t, toWorld(e.clientX, e.clientY), frameGeo) : null;
    if (frameDrag) {
      dragRef.current = { kind: "frame", ...frameDrag, startModel: draftRef.current };
      svgRef.current!.setPointerCapture(e.pointerId);
      return;
    }
    const connectEl = t.closest("[data-connect]");
    const nodeEl = t.closest("[data-node-id]");
    const flowEl = t.closest("[data-flow-id]");
    const laneEl = t.closest("[data-lane-id]");
    const artifactEl = t.closest("[data-artifact]");
    const poolEl = t.closest("[data-pool-id]");
    const messageEl = t.closest("[data-message-id]");
    const markerEl = t.closest("[data-marker]");
    const handleEl = t.closest("[data-flow-handle]");
    const resizeEl = t.closest("[data-lane-resize]");
    const stretchEl = t.closest("[data-lane-stretch]");
    const onEmpty = !connectEl && !nodeEl && !flowEl && !laneEl && !artifactEl && !poolEl && !messageEl && !markerEl && !handleEl && !resizeEl && !stretchEl;

    if (stretchEl && e.button === 0) {
      // правый край дорожек: ширину меняют перетаскиванием
      const [wx] = toWorld(e.clientX, e.clientY);
      dragRef.current = { kind: "laneStretch", base: viewRef.current, startModel: draftRef.current, x0: wx, w0: diagramWidth(viewRef.current), moved: false };
      setStretching(true);
      svgRef.current!.setPointerCapture(e.pointerId);
      return;
    }

    if (resizeEl && e.button === 0) {
      // граница дорожки: высоту меняют перетаскиванием
      const i = Number(resizeEl.getAttribute("data-lane-resize"));
      const [, wy] = toWorld(e.clientX, e.clientY);
      dragRef.current = { kind: "laneResize", i, base: viewRef.current, startModel: draftRef.current, y0: wy, h0: laneHeight(viewRef.current, i), moved: false };
      setResizingLane(i);
      svgRef.current!.setPointerCapture(e.pointerId);
      return;
    }

    if (handleEl && e.button === 0 && routedId) {
      // ручки выбранной стрелки: концы переносят на другую сторону или фигуру (и вдоль стороны), отрезки и изломы двигают свободно
      // (у потока сообщений концы стоят на шаге и пуле, поэтому тянутся только отрезки и изломы)
      const kind = handleEl.getAttribute("data-flow-handle")!;
      const g = flowGeometry(routedId);
      const [wx, wy] = toWorld(e.clientX, e.clientY);
      if (kind.startsWith("seg:") && g) {
        const i = Number(kind.slice(4));
        dragRef.current = { kind: "flowSeg", id: routedId, i, axis: Math.abs(g.poly[i][1] - g.poly[i + 1][1]) < 0.5 ? "y" : "x", g, startModel: draftRef.current, moved: false, x0: wx, y0: wy };
      } else if (kind.startsWith("corner:") && g) {
        const i = Number(kind.slice(7));
        dragRef.current = { kind: "flowCorner", id: routedId, i, v: g.poly[i], g, startModel: draftRef.current, moved: false, x0: wx, y0: wy };
      } else if ((kind === "from" || kind === "to") && curSel?.kind === "flow") {
        dragRef.current = { kind: "flowEnd", id: curSel.id, end: kind };
        setFlowGhost({ id: curSel.id, end: kind, pt: [wx, wy], target: null, side: null, pos: null });
      } else return;
      svgRef.current!.setPointerCapture(e.pointerId);
      return;
    }

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
        dragRef.current = { kind: "group", id, ids: groupIds, base: viewRef.current, startModel: draftRef.current, x0: wx, y0: wy, moved: false, keep: { x: false, y: false } };
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
      dragRef.current = { kind: "node", id, offX: wx - b.x, offY: wy - b.y, startModel: draftRef.current, moved: false, sx: e.clientX, sy: e.clientY, keep: { x: false, y: false } };
      svgRef.current!.setPointerCapture(e.pointerId);
    } else if (markerEl) {
      // значок триггера: выбирает событие (его свойства — в панели), перетаскивать нельзя — он стоит на блоке
      setMulti([]);
      pick({ kind: "node", id: markerEl.getAttribute("data-marker")! });
    } else if (artifactEl) {
      // значок документа или хранилища: выбирает запись справочника — её карточка открывается в «Свойствах»
      setMulti([]);
      // значок можно перетащить: смещение от автоматического места хранится у задачи
      const nodeId = artifactEl.getAttribute("data-artifact")!;
      const key = `${artifactEl.getAttribute("data-artifact-kind")}:${artifactEl.getAttribute("data-artifact-entity")}`;
      pick({ kind: "artifact", dict: artifactEl.getAttribute("data-artifact-kind") === "store" ? "systems" : "data", id: artifactEl.getAttribute("data-artifact-entity")!, node: nodeId, key });
      const cur = draft.nodes.find((x) => x.id === nodeId)?.artifact_offsets?.[key];
      const [wx, wy] = toWorld(e.clientX, e.clientY);
      dragRef.current = { kind: "artifact", nodeId, key, dx0: cur?.dx ?? 0, dy0: cur?.dy ?? 0, x0: wx, y0: wy, startModel: draftRef.current, moved: false };
      svgRef.current!.setPointerCapture(e.pointerId);
    } else if (poolEl) {
      // пул можно перетащить: смещение от автоматического места хранится в самом пуле
      setMulti([]);
      const id = poolEl.getAttribute("data-pool-id")!;
      pick({ kind: "pool", id });
      const pool = (draft.pools ?? []).find((p) => p.id === id);
      const [wx, wy] = toWorld(e.clientX, e.clientY);
      dragRef.current = { kind: "pool", id, dx0: pool?.dx ?? 0, dy0: pool?.dy ?? 0, x0: wx, y0: wy, startModel: draftRef.current, moved: false };
      svgRef.current!.setPointerCapture(e.pointerId);
    } else if (messageEl) {
      setMulti([]);
      pick({ kind: "message", id: messageEl.getAttribute("data-message-id")! });
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
    if (d.kind === "frame") {
      const [wx, wy] = toWorld(e.clientX, e.clientY);
      if (!d.moved && Math.hypot(wx - d.x0, wy - d.y0) * view.k < 3) return;
      d.moved = true;
      h.setDraft((m) => setSheetFrame(m, "bpmn_frames", frameKeyBpmn, { rect: dragRect(d, wx - d.x0, wy - d.y0) }));
      return;
    }
    if (d.kind === "pan") {
      setView((v) => ({ ...v, tx: d.tx + e.clientX - d.sx, ty: d.ty + e.clientY - d.sy }));
    } else if (d.kind === "node") {
      if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 4) return;
      d.moved = true;
      const [wx, wy] = toWorld(e.clientX, e.clientY);
      const cur = viewRef.current.nodes.find((x) => x.id === d.id)!;
      const size = boxOf(cur);
      let [x, y] = [Math.max(MIN_X, snap(wx - d.offX)), snapTop(wy - d.offY, size.h)];
      d.keep = { x: false, y: false };
      if (!e.altKey) {
        // направляющие: края и середина фигуры ищут совпадение с краями и серединой остальных фигур, середина — ещё и с центрами дорожек
        const rect = { x: wx - d.offX, y: wy - d.offY, w: size.w, h: size.h };
        const s = snapShape(rect, otherBoxes([d.id]), GUIDE_SNAP_PX / view.k, laneCenters());
        if (s.x) (x = Math.max(MIN_X, rect.x + s.dx), (d.keep.x = true));
        if (s.y) (y = rect.y + s.dy, (d.keep.y = true));
        setGuides(s.guides);
      } else setGuides([]);
      setDraft((m) => moveNode(m, d.id, x, y));
      setHotLane(laneIndexAtY(viewRef.current, wy));
    } else if (d.kind === "pool") {
      const [wx, wy] = toWorld(e.clientX, e.clientY);
      if (!d.moved && Math.hypot(wx - d.x0, wy - d.y0) * view.k < 4) return;
      d.moved = true;
      const step = e.altKey ? 1 : 10;
      setDraft((m) => setPoolOffset(m, d.id, Math.round((d.dx0 + wx - d.x0) / step) * step, Math.round((d.dy0 + wy - d.y0) / step) * step));
    } else if (d.kind === "artifact") {
      const [wx, wy] = toWorld(e.clientX, e.clientY);
      if (!d.moved && Math.hypot(wx - d.x0, wy - d.y0) * view.k < 4) return;
      d.moved = true;
      const step = e.altKey ? 1 : 5;
      setDraft((m) => setArtifactOffset(m, d.nodeId, d.key, { dx: Math.round((d.dx0 + wx - d.x0) / step) * step, dy: Math.round((d.dy0 + wy - d.y0) / step) * step }));
    } else if (d.kind === "laneStretch") {
      // ширина кратна 10 (Alt — точно); уже содержимого дорожки не делаются — край упирается в самую правую фигуру
      const [wx] = toWorld(e.clientX, e.clientY);
      const raw = d.w0 + wx - d.x0;
      if (!d.moved && Math.abs(raw - d.w0) * view.k < 4) return;
      d.moved = true;
      setDraft(() => setDiagramWidth(d.base, e.altKey ? raw : Math.round(raw / 10) * 10));
    } else if (d.kind === "laneResize") {
      // высота кратна 10 (Alt — точно), не меньше, чем нужно фигурам дорожки; дорожки ниже едут вместе с границей
      const [, wy] = toWorld(e.clientX, e.clientY);
      const raw = d.h0 + wy - d.y0;
      if (!d.moved && Math.abs(raw - d.h0) * view.k < 4) return;
      d.moved = true;
      setDraft(() => setLaneHeight(d.base, d.i, e.altKey ? raw : Math.round(raw / 10) * 10));
    } else if (d.kind === "flowSeg") {
      // отрезок сдвигается поперёк себя: прилипает к направляющей (граница или середина фигуры, порт, другой излом) или к сетке в 5 пикселей; Alt — без привязки
      const [wx, wy] = toWorld(e.clientX, e.clientY);
      const raw = d.axis === "y" ? wy - d.y0 : wx - d.x0;
      if (!d.moved && Math.abs(raw) * view.k < 4) return;
      d.moved = true;
      const [a, b] = [d.g.poly[d.i], d.g.poly[d.i + 1]];
      const base = d.axis === "y" ? a[1] : a[0];
      let value = base + (e.altKey ? raw : Math.round(raw / 5) * 5);
      let guide: Guide | null = null;
      if (!e.altKey) {
        const last = d.g.poly.length - 1;
        const snap = snapAxis(base + raw, guideTargets(d.axis, boxes.values(), d.g.poly, [d.i, d.i + 1].filter((j) => j > 0 && j < last), otherFlowLines(d.id)), GUIDE_SNAP_PX / view.k);
        if (snap.hit.length > 0) {
          value = snap.value;
          guide = guideFor(d.axis, value, snap.hit, d.axis === "y" ? [a[0], b[0]] : [a[1], b[1]]);
        }
      }
      setGuides(guide ? [guide] : []);
      setDraft((m) => dragSegment(m, d.id, d.g, d.i, value - base));
    } else if (d.kind === "flowCorner") {
      const [wx, wy] = toWorld(e.clientX, e.clientY);
      if (!d.moved && Math.hypot(wx - d.x0, wy - d.y0) * view.k < 4) return;
      d.moved = true;
      const [rx, ry] = [d.v[0] + wx - d.x0, d.v[1] + wy - d.y0];
      let [x, y] = e.altKey ? [rx, ry] : [Math.round(rx / 5) * 5, Math.round(ry / 5) * 5];
      const found: { axis: "x" | "y"; hit: GuideTarget[] }[] = [];
      if (!e.altKey) {
        const tol = GUIDE_SNAP_PX / view.k;
        const sx = snapAxis(rx, guideTargets("x", boxes.values(), d.g.poly, [d.i], otherFlowLines(d.id)), tol);
        const sy = snapAxis(ry, guideTargets("y", boxes.values(), d.g.poly, [d.i], otherFlowLines(d.id)), tol);
        if (sx.hit.length > 0) (x = sx.value, found.push({ axis: "x", hit: sx.hit }));
        if (sy.hit.length > 0) (y = sy.value, found.push({ axis: "y", hit: sy.hit }));
      }
      setGuides(found.map((f) => guideFor(f.axis, f.axis === "x" ? x : y, f.hit, f.axis === "x" ? [y - 12, y + 12] : [x - 12, x + 12])));
      setDraft((m) => dragCorner(m, d.id, d.g, d.i, [x, y]));
    } else if (d.kind === "flowEnd") {
      // куда указывает конец: фигура под курсором и ближайшая к курсору её сторона
      const [wx, wy] = toWorld(e.clientX, e.clientY);
      const hit = shown.find((n) => {
        const b = boxes.get(n.id)!;
        return wx > b.x - 10 && wx < b.x + b.w + 10 && wy > b.y - 10 && wy < b.y + b.h + 10;
      });
      const side = hit ? nearestSide(boxes.get(hit.id)!, [wx, wy]) : null;
      let pos = hit && side ? positionOnSide(boxes.get(hit.id)!, side, [wx, wy]) : null;
      let guide: Guide | null = null;
      if (hit && side && !e.altKey) {
        // конец вдоль стороны прилипает к линии другого конца стрелки (тогда она идёт прямо) и к середине стороны
        const g = flowGeometry(d.id);
        const other = g ? (d.end === "from" ? g.poly[g.poly.length - 1] : g.poly[0]) : null;
        const b = boxes.get(hit.id)!;
        if (other) {
          const horizontalSide = side === "L" || side === "R";
          const [cur, start, size] = horizontalSide ? [wy, b.y, b.h] : [wx, b.x, b.w];
          const edge = horizontalSide ? (side === "L" ? b.x : b.x + b.w) : side === "T" ? b.y : b.y + b.h;
          const along = horizontalSide ? other[0] : other[1];
          const targets: GuideTarget[] = [
            { at: horizontalSide ? other[1] : other[0], lo: along, hi: along },
            { at: start + size / 2, lo: edge, hi: edge },
          ];
          const snap = snapAxis(cur, targets, GUIDE_SNAP_PX / view.k);
          if (snap.hit.length > 0) {
            pos = Math.min(0.9, Math.max(0.1, (snap.value - start) / size));
            guide = guideFor(horizontalSide ? "y" : "x", snap.value, snap.hit, [edge, edge]);
          }
        }
      }
      setGuides(guide ? [guide] : []);
      setFlowGhost({ id: d.id, end: d.end, pt: [wx, wy], target: hit?.id ?? null, side, pos });
      setConnectHot(hit?.id ?? null);
    } else if (d.kind === "marquee") {
      const [wx, wy] = toWorld(e.clientX, e.clientY);
      setMarquee({ x: Math.min(d.x0, wx), y: Math.min(d.y0, wy), w: Math.abs(wx - d.x0), h: Math.abs(wy - d.y0) });
    } else if (d.kind === "group") {
      const [wx, wy] = toWorld(e.clientX, e.clientY);
      if (!d.moved && Math.hypot(wx - d.x0, wy - d.y0) * view.k < 4) return;
      d.moved = true;
      let [dx, dy] = [wx - d.x0, wy - d.y0];
      d.keep = { x: false, y: false };
      const bb = e.altKey ? null : boundsOf(d.base, d.ids);
      if (bb) {
        // рамка группы выравнивается с остальными фигурами как одна фигура
        const s = snapShape({ x: bb.x + dx, y: bb.y + dy, w: bb.w, h: bb.h }, otherBoxes(d.ids), GUIDE_SNAP_PX / view.k);
        if (s.x) (dx += s.dx, (d.keep.x = true));
        if (s.y) (dy += s.dy, (d.keep.y = true));
        setGuides(s.guides);
      } else setGuides([]);
      setDraft(() => moveGroup(d.base, d.ids, dx, dy, d.keep));
    } else {
      setConnectTo(toWorld(e.clientX, e.clientY));
      const target = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-node-id]")?.getAttribute("data-node-id") ?? null;
      setConnectHot(target && target !== d.from ? target : null);
    }
  };

  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    const d = dragRef.current;
    dragRef.current = null;
    setGuides([]);
    if (svgRef.current?.hasPointerCapture(e.pointerId)) svgRef.current.releasePointerCapture(e.pointerId);
    if (!d) return;
    if (d.kind === "frame") {
      if (d.moved) h.recordPast(d.startModel);
      return;
    }
    if (d.kind === "node" && d.moved) {
      h.recordPast(d.startModel);
      setDraft((m) => dropNodeIntoLane(m, d.id, d.keep));
      setHotLane(null);
    } else if (d.kind === "artifact" || d.kind === "pool") {
      if (d.moved) h.recordPast(d.startModel);
    } else if (d.kind === "laneStretch") {
      setStretching(false);
      if (d.moved) h.recordPast(d.startModel);
    } else if (d.kind === "laneResize") {
      setResizingLane(null);
      if (d.moved) h.recordPast(d.startModel);
    } else if (d.kind === "flowSeg" || d.kind === "flowCorner") {
      if (d.moved) h.recordPast(d.startModel);
    } else if (d.kind === "flowEnd") {
      const ghost = flowGhost;
      setFlowGhost(null);
      setConnectHot(null);
      if (ghost?.target) {
        const flow = vflows.find((f) => f.id === d.id);
        const r = reconnectFlow(viewRef.current, d.id, d.end, ghost.target, ghost.side ?? undefined, flow?.viaEvent, ghost.pos ?? undefined);
        if (r.error) showHint(r.error);
        else commit(r.model);
      }
    } else if (d.kind === "group") {
      if (d.moved) {
        h.recordPast(d.startModel);
        setDraft((m) => dropGroup(m, d.ids, d.keep));
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
      const under = document.elementFromPoint(e.clientX, e.clientY);
      const target = under?.closest("[data-node-id]")?.getAttribute("data-node-id");
      const poolTarget = under?.closest("[data-pool-id]")?.getAttribute("data-pool-id");
      setConnectTo(null);
      setConnectHot(null);
      if (!target && poolTarget) {
        // ● у шага, отпущенная на внешнем пуле, создаёт поток сообщений «шаг → пул»
        const r = addMessage(viewRef.current, d.from, poolTarget);
        if (r.error) showHint(r.error);
        else commit(r.model, { kind: "message", id: r.id! });
        return;
      }
      if (target && target !== d.from) {
        const r = addFlow(viewRef.current, d.from, target);
        if (r.error) showHint(r.error);
        else commit(r.model, { kind: "flow", id: r.id! });
      }
    }
  };

  /**
   * Двойной щелчок правит текст того, по чему попали: фигура (задача, событие, шлюз) — название, значок-триггер на блоке — его
   * название, стрелка — условие ветки (с Ctrl — добавить излом), излом — убирает его.
   */
  const onDoubleClick = (e: React.MouseEvent<SVGSVGElement>) => {
    // пока указатель захвачен ручкой или фигурой, событие приходит на сам svg: цель определяем по координатам
    const under = document.elementFromPoint?.(e.clientX, e.clientY) ?? null;
    const t = (under && svgRef.current?.contains(under) ? under : e.target) as Element;
    const at = toWorld(e.clientX, e.clientY);
    const frameField = frameOn ? t.closest("[data-frame-field]")?.getAttribute("data-frame-field") : null;
    if (frameField) {
      setEditSpot({ kind: "frame", id: frameField, at });
      return;
    }
    const handle = t.closest("[data-flow-handle]")?.getAttribute("data-flow-handle");
    if (routedId && handle?.startsWith("corner:")) {
      const g = flowGeometry(routedId);
      if (g) commit(removeBend(viewRef.current, routedId, g, Number(handle.slice(7))));
      return;
    }
    // ручка отрезка — часть линии: двойной щелчок по ней то же, что по самой выбранной стрелке
    if (handle && !handle.startsWith("seg:")) return;
    const poolId = handle ? null : t.closest("[data-pool-id]")?.getAttribute("data-pool-id");
    if (poolId) {
      setEditSpot({ kind: "pool", id: poolId, at });
      return;
    }
    const messageId = handle ? (curSel?.kind === "message" ? curSel.id : null) : t.closest("[data-message-id]")?.getAttribute("data-message-id");
    if (messageId) {
      if (e.ctrlKey || e.metaKey) {
        // Ctrl + двойной щелчок по линии потока сообщений — новый излом, как у потока управления
        const g = flowGeometry(`msg:${messageId}`);
        const next = g ? addBend(viewRef.current, `msg:${messageId}`, g, at) : viewRef.current;
        if (next === viewRef.current) showHint("Здесь не получится: отрезок слишком короткий для излома");
        else commit(next);
      } else setEditSpot({ kind: "message", id: messageId, at });
      return;
    }
    const artifactEl = handle ? null : t.closest("[data-artifact]");
    if (artifactEl) {
      setEditSpot({ kind: "artifact", dict: artifactEl.getAttribute("data-artifact-kind") === "store" ? "systems" : "data", id: artifactEl.getAttribute("data-artifact-entity")!, at });
      return;
    }
    const marker = handle ? null : t.closest("[data-marker]")?.getAttribute("data-marker");
    if (marker) {
      setEditSpot({ kind: "marker", id: marker, at });
      return;
    }
    const flowId = handle ? (curSel?.kind === "flow" ? curSel.id : undefined) : t.closest("[data-flow-id]")?.getAttribute("data-flow-id");
    if (flowId) {
      if (e.ctrlKey || e.metaKey) {
        const g = flowGeometry(flowId);
        const next = g ? addBend(viewRef.current, flowId, g, at) : viewRef.current;
        if (next === viewRef.current) showHint("Здесь не получится: отрезок слишком короткий для излома");
        else commit(next);
      } else setEditSpot({ kind: "flow", id: flowId, at });
      return;
    }
    const id = t.closest("[data-node-id]")?.getAttribute("data-node-id");
    if (id) setEditing(id);
  };

  // --- добавление элементов ---

  const addFromPalette = (spec: NewNodeSpec, at?: Pt) => {
    const m = viewRef.current;
    let cx: number, cy: number;
    const from = curSel?.kind === "node" ? m.nodes.find((n) => n.id === curSel.id) : undefined;
    // ожидающий триггер при выбранном блоке прикрепляется к блоку значком, а не рисуется отдельной фигурой со стрелкой
    if (!at && spec.type === "event" && spec.trigger && spec.subtype !== "end" && spec.trigger.direction !== "throw" && BLOCK_TRIGGERS.includes(spec.trigger.type) && from && (from.type === "task" || from.type === "subprocess")) {
      const r = attachTrigger(m, from.id, spec.trigger.type, spec.name);
      if (r.error) showHint(r.error);
      else commit(r.model, { kind: "node", id: r.id! });
      return;
    }
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

  /** Новый внешний пул (другой процесс или участник): общий для всех диаграмм, показывается там, где создан; поток сообщений к нему — перетаскиванием ● шага. */
  const addExternalPool = () => {
    const r = addPool(draftRef.current, "Внешний процесс", null, scopeId ?? "");
    if (h.commit(r.model)) {
      pick({ kind: "pool", id: r.id! });
      showHint("Пул добавлен под диаграммой. Тяните его мышью, двойной щелчок — переименовать; чтобы связать с шагом, протяните ● от шага к пулу.");
    }
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
      if (curSel.kind === "node") commit(triggerView(draft).hidden.has(curSel.id) ? deleteTriggerEvent(draft, curSel.id) : deleteNode(draft, curSel.id), null);
      else if (curSel.kind === "flow") commit(deleteFlow(draft, curSel.id), null);
      else if (curSel.kind === "pool" && h.commit(deletePool(draftRef.current, curSel.id))) setSel(null);
      else if (curSel.kind === "message" && h.commit(deleteMessage(draftRef.current, curSel.id))) setSel(null);
    } else if (e.key === "Escape") {
      setMsgTool(null);
      setMulti([]);
      setSel(null);
      setEditing(null);
    }
  };

  // --- отрисовка ---

  const { h: worldH } = modelExtents(draft);
  const W = diagramWidth(draft);
  // фигуры, значки триггеров, документы, пулы и ВСЕ стрелки считаются вместе (geometry.diagramLayout)
  const { shown, boxes, extras, flows: vflows, markers, routes, info: layoutInfo, bottomUsed } = useMemo(() => diagramLayout(draft), [draft]);
  /** Рамки остальных фигур диаграммы (без перетаскиваемых, их граничных событий и самих граничных событий) — с ними выравнивают фигуру. */
  const otherBoxes = (skip: string[]) => {
    const skipSet = new Set(skip);
    return shown.filter((n) => !skipSet.has(n.id) && !(n.attached_to && skipSet.has(n.attached_to)) && !isBoundary(n, shown)).map((n) => boxes.get(n.id)!);
  };
  /** Линии центров дорожек: фигура, стоящая по центру дорожки, выровнена с остальными. */
  const laneCenters = () => Array.from({ length: laneCount(viewRef.current) }, (_, i) => laneTop(viewRef.current, i) + laneHeight(viewRef.current, i) / 2);
  /** Ломаные остальных стрелок: их изломы — опорные линии для выравнивания правимой стрелки. */
  const otherFlowLines = (id: string) => [...routes].filter(([k]) => k !== id && !k.startsWith("msg:")).map(([, pts]) => pts);
  /** Нарисованная сейчас ломаная стрелки и её стороны — исходные данные для свободной правки маршрута. */
  const flowGeometry = (id: string): FlowGeometry | null => {
    const poly = routes.get(id);
    const inf = layoutInfo.get(id);
    return poly && inf ? { poly, from: inf.from, to: inf.to } : null;
  };
  const selectedNode = curSel?.kind === "node" ? draft.nodes.find((n) => n.id === curSel.id) : undefined;
  const editingNode = editing ? draft.nodes.find((n) => n.id === editing) : undefined;
  // лист: штамп по умолчанию — код и название операции (или процесса), номер листа
  const frameOn = bpmnFrameShown(frame);
  const sheetCode = scopeId ? idef0Codes(h.draft).get(scopeId) ?? "" : processCodeOf(h.draft);
  const sheetName = scopeId ? h.draft.nodes.find((n) => n.id === scopeId)?.name ?? "" : h.draft.process.name;
  const frameGeo = frameGeometry(sheetWorld(draft), frame, bpmnFrameDefaults(sheetCode, sheetName));
  // фигуры за пределами листа, заданного вручную (лист по размеру диаграммы их и так вмещает)
  const outside =
    frameOn && frame?.w !== undefined
      ? shown.filter((n) => {
          const b = boxes.get(n.id);
          return b && (b.x < frameGeo.sheet.x || b.y < frameGeo.sheet.y || b.x + b.w > frameGeo.sheet.x + frameGeo.sheet.w || b.y + b.h > frameGeo.footer.y);
        }).length
      : 0;

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
            <button onClick={() => commit(withLayout(draft, true, undefined, true))} title="Расставить все фигуры заново, подобрав порядок так, чтобы стрелки пересекались меньше (можно отменить)">
              Авто-раскладка
            </button>
            <button className={showMap ? "on" : ""} onClick={() => setShowMap((v) => !v)} title="Миникарта диаграммы">
              Миникарта
            </button>
            <FrameMenu frame={frame} geo={frameGeo} outside={outside} shown={frameOn} onChange={setSheet} />
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
          <button className={msgTool ? "active" : undefined} aria-pressed={!!msgTool} onClick={() => setMsgTool((t) => (t ? null : { from: null }))} title="Стрелка между шагом и внешним пулом: щёлкните по началу, затем по концу">
            Поток сообщений
          </button>
          <button onClick={addExternalPool} title="Пул другого процесса или внешнего участника (поставщик, клиент): к нему идут потоки сообщений">
            Внешний пул
          </button>
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
              {frameOn && <FrameLayer geo={frameGeo} grid={gridShown(frame)} layers="back" />}
              <LanesLayer model={draft} width={W} hotLane={hotLane} selectedLaneId={curSel?.kind === "lane" ? curSel.id : null} />
              {frameOn && <FrameLayer geo={frameGeo} grid={gridShown(frame)} layers="front" />}

              {vflows.map((f) => {
                const points = routes.get(f.id);
                return points ? <FlowShape key={f.id} flow={f} points={points} showLabel={display.labels} selected={curSel?.kind === "flow" && curSel.id === f.id} /> : null;
              })}

              {extras.messages.map(({ message, points }) => (
                <MessageShape key={message.id} id={message.id} points={routes.get(`msg:${message.id}`) ?? points} label={message.name} selected={curSel?.kind === "message" && curSel.id === message.id} />
              ))}
              {extras.pools.map(({ pool, box }) => (
                <PoolShape key={pool.id} pool={pool} box={box} selected={curSel?.kind === "pool" && curSel.id === pool.id} />
              ))}
              {extras.artifacts.map((a) => (
                <ArtifactShape key={a.key} artifact={a} selected={curSel?.kind === "artifact" && curSel.id === a.entityId && curSel.dict === (a.kind === "store" ? "systems" : "data")} />
              ))}

              {shown.map((n) => (
                <NodeShape key={n.id} node={n} style={nodeStyle(draft, n, isBoundary(n, shown))} showLabel={display.labels} code={numbers?.get(n.id)} box={boxes.get(n.id)!} selected={inGroup ? groupIds.includes(n.id) : curSel?.kind === "node" && curSel.id === n.id} hot={connectHot === n.id} boundary={isBoundary(n, shown)} labelLeft={bottomUsed.has(n.id)} hasMarkers={markers.has(n.id)} laneBand={laneBandAt(draft, boxes.get(n.id)!)} />
              ))}

              {inGroup && (() => {
                const b = boundsOf(draft, groupIds);
                return b && <rect data-group-box x={b.x - 8} y={b.y - 8} width={b.w + 16} height={b.h + 16} fill="none" stroke="#4338ca" strokeWidth={1} strokeDasharray="5 4" pointerEvents="none" />;
              })()}
              {marquee && <rect data-marquee x={marquee.x} y={marquee.y} width={marquee.w} height={marquee.h} fill="rgba(67,56,202,0.08)" stroke="#4338ca" strokeDasharray="4 3" pointerEvents="none" />}

              {[...markers].map(([blockId, list]) => (boxes.has(blockId) ? <TriggerMarkers key={blockId} box={boxes.get(blockId)!} markers={list} selectedId={curSel?.kind === "node" ? curSel.id : null} /> : null))}

              <LaneResizeHandles model={draft} width={W} activeLane={resizingLane} stretching={stretching} />

              {routedId &&
                (() => {
                  // ручки выбранной стрелки: концы (на другую сторону или фигуру, вдоль стороны), отрезки (сдвинуть поперёк) и изломы (перенести)
                  const g = flowGeometry(routedId);
                  if (!g) return null;
                  const pts = g.poly;
                  const stroke = "#4338ca";
                  return (
                    <g>
                      {pts.slice(0, -1).map((a, i) => {
                        const b = pts[i + 1];
                        const horizontal = Math.abs(a[1] - b[1]) < 0.5;
                        if (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) < MIN_HANDLE_LEN) return null;
                        const [mx, my] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
                        return (
                          <rect key={`seg${i}`} data-flow-handle={`seg:${i}`} x={mx - (horizontal ? 9 : 3.5)} y={my - (horizontal ? 3.5 : 9)} width={horizontal ? 18 : 7} height={horizontal ? 7 : 18} rx={3} fill="#fff" stroke={stroke} strokeWidth={1.6} style={{ cursor: horizontal ? "ns-resize" : "ew-resize" }}>
                            <title>Потяните, чтобы сдвинуть этот участок стрелки (Alt — без привязки к сетке)</title>
                          </rect>
                        );
                      })}
                      {pts.slice(1, -1).map((p, k) => (
                        <rect key={`corner${k + 1}`} data-flow-handle={`corner:${k + 1}`} x={p[0] - 4} y={p[1] - 4} width={8} height={8} fill={stroke} stroke="#fff" strokeWidth={1.2} style={{ cursor: "move" }}>
                          <title>Потяните излом куда нужно; двойной щелчок — убрать излом</title>
                        </rect>
                      ))}
                      {curSel?.kind === "flow" && <circle data-flow-handle="from" cx={pts[0][0]} cy={pts[0][1]} r={6} fill="#fff" stroke={stroke} strokeWidth={2} style={{ cursor: "grab" }}>
                        <title>Потяните конец на другую сторону фигуры или на другую фигуру</title>
                      </circle>}
                      {curSel?.kind === "flow" && <circle data-flow-handle="to" cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r={6} fill="#fff" stroke={stroke} strokeWidth={2} style={{ cursor: "grab" }}>
                        <title>Потяните конец на другую сторону фигуры или на другую фигуру</title>
                      </circle>}
                    </g>
                  );
                })()}
              {guides.map((gd, i) => (
                <line
                  key={`guide${i}`}
                  data-guide={gd.axis}
                  x1={gd.axis === "y" ? gd.from : gd.at}
                  y1={gd.axis === "y" ? gd.at : gd.from}
                  x2={gd.axis === "y" ? gd.to : gd.at}
                  y2={gd.axis === "y" ? gd.at : gd.to}
                  stroke="#db2777"
                  strokeWidth={1.2}
                  strokeDasharray="6 3"
                  pointerEvents="none"
                />
              ))}
              {flowGhost &&
                (() => {
                  const pts = routes.get(flowGhost.id);
                  if (!pts) return null;
                  const anchor = flowGhost.end === "to" ? pts[0] : pts[pts.length - 1];
                  const tb = flowGhost.target ? boxes.get(flowGhost.target) : undefined;
                  const pos = flowGhost.pos ?? 0.5;
                  const mid = tb && flowGhost.side ? { L: [tb.x, tb.y + pos * tb.h], R: [tb.x + tb.w, tb.y + pos * tb.h], T: [tb.x + pos * tb.w, tb.y], B: [tb.x + pos * tb.w, tb.y + tb.h] }[flowGhost.side] : null;
                  return (
                    <g pointerEvents="none" data-flow-ghost>
                      <path d={`M${anchor[0]} ${anchor[1]} L${(mid ?? flowGhost.pt)[0]} ${(mid ?? flowGhost.pt)[1]}`} stroke="#4338ca" strokeWidth={2} strokeDasharray="6 4" fill="none" />
                      {mid && <circle data-flow-ghost-side={flowGhost.side} cx={mid[0]} cy={mid[1]} r={6} fill="#16a34a" stroke="#fff" strokeWidth={1.5} />}
                    </g>
                  );
                })()}

              {!inGroup && selectedNode && boxes.has(selectedNode.id) && !(selectedNode.type === "event" && selectedNode.subtype === "end") && !editing && (
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
          {editSpot &&
            (() => {
              const box = { x: editSpot.at[0] - 90, y: editSpot.at[1] - 12, w: 180, h: 24 };
              if (editSpot.kind === "frame") {
                const cell = frameGeo.cells.find((c) => c.field === editSpot.id);
                if (!cell) return null;
                return (
                  <RenameOverlay
                    key={`frame-${cell.field}`}
                    name={cell.text}
                    box={{ x: cell.x, y: cell.y + 3, w: Math.max(cell.w, 120), h: cell.h - 6 }}
                    view={view}
                    allowEmpty
                    placeholder="Пусто — надпись по умолчанию"
                    onCommit={(v) => setSheet({ text: { field: cell.field as FrameField, value: v } })}
                    onDone={() => setEditSpot(null)}
                  />
                );
              }
              if (editSpot.kind === "pool") {
                const pool = (viewRef.current.pools ?? []).find((p) => p.id === editSpot.id);
                if (!pool) return null;
                return <RenameOverlay key={`p${pool.id}`} name={pool.name} box={box} view={view} onCommit={(v) => h.commit(updatePool(draftRef.current, pool.id, { name: v }))} onDone={() => setEditSpot(null)} />;
              }
              if (editSpot.kind === "message") {
                const msg = (viewRef.current.messages ?? []).find((x) => x.id === editSpot.id);
                if (!msg) return null;
                return <RenameOverlay key={`s${msg.id}`} name={msg.name ?? ""} box={box} view={view} allowEmpty placeholder="Название сообщения" onCommit={(v) => h.commit(updateMessage(draftRef.current, msg.id, { name: v || null }))} onDone={() => setEditSpot(null)} />;
              }
              if (editSpot.kind === "artifact") {
                // справочник общий для всех диаграмм: правим полную модель, а не вид операции
                const dict = editSpot.dict!;
                const rec = entryOf(draftRef.current, dict, editSpot.id);
                if (!rec) return null;
                return <RenameOverlay key={`a${rec.id}`} name={rec.name} box={box} view={view} onCommit={(v) => h.commit(updateEntry(draftRef.current, dict, rec.id, { name: v }))} onDone={() => setEditSpot(null)} />;
              }
              if (editSpot.kind === "marker") {
                const ev = viewRef.current.nodes.find((n) => n.id === editSpot.id);
                if (!ev) return null;
                return <RenameOverlay key={`m${ev.id}`} name={ev.name} box={box} view={view} onCommit={(v) => commit(updateNode(viewRef.current, ev.id, { name: v }))} onDone={() => setEditSpot(null)} />;
              }
              const fl = viewRef.current.flows.find((f) => f.id === editSpot.id);
              if (!fl) return null;
              const fromGateway = viewRef.current.nodes.find((n) => n.id === fl.from)?.type === "gateway";
              return (
                <RenameOverlay
                  key={`f${fl.id}`}
                  name={fl.condition ?? ""}
                  box={box}
                  view={view}
                  allowEmpty
                  placeholder={fromGateway ? "Условие ветки" : "Условие (необязательно)"}
                  onCommit={(v) => commit(updateFlow(viewRef.current, fl.id, { condition: v || null }))}
                  onDone={() => setEditSpot(null)}
                />
              );
            })()}
          {shown.length === 0 && (
            <div className="bpe-empty">
              <b>Диаграмма пуста</b>
              <span>
                Перетащите фигуру из палитры слева или нажмите на неё — например, «Начало». Выберите фигуру и потяните за ● справа, чтобы провести стрелку.
                {scopeId && " Дорожки — исполнители операции: назначьте их в свойствах операции или добавьте кнопкой «+ Дорожка»."}
              </span>
            </div>
          )}
          {curSel?.kind === "lane" &&
            (() => {
              const index = laneIndexOfRole(draft, curSel.id);
              const current = laneHeight(draft, index);
              const apply = (raw: string) => {
                const v = Number(raw);
                if (!Number.isFinite(v) || raw.trim() === "") return;
                const next = setLaneHeight(draft, index, v);
                if (next !== draft) commit(next);
                else if (Math.round(v / 10) * 10 < laneMinHeight(draft, index)) showHint(`Ниже ${laneMinHeight(draft, index)} px нельзя: дорожка не вместит свои фигуры`);
              };
              const applyWidth = (raw: string) => {
                const v = Number(raw);
                if (!Number.isFinite(v) || raw.trim() === "") return;
                const next = setDiagramWidth(draft, v);
                if (next !== draft) commit(next);
              };
              return (
                <div className="bpe-selbar" role="toolbar" aria-label="Размер дорожки">
                  <label className="muted" htmlFor="lane-height">
                    Высота дорожки, px
                  </label>
                  <input
                    id="lane-height"
                    key={`${curSel.id}:${current}`}
                    type="number"
                    min={MIN_LANE_H}
                    max={MAX_LANE_H}
                    step={10}
                    defaultValue={current}
                    style={{ width: 72 }}
                    onBlur={(e) => apply(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") apply((e.target as HTMLInputElement).value);
                    }}
                  />
                  <button disabled={current === LANE_H} onClick={() => apply(String(LANE_H))} title="Стандартная высота дорожки">
                    Стандартная
                  </button>
                  <button
                    onClick={() => {
                      let next = draft;
                      for (let i = 0; i < laneCount(draft); i++) next = setLaneHeight(next, i, current);
                      if (next !== draft) commit(next);
                    }}
                    title="Сделать все дорожки такой же высоты (дорожка, которой не хватает места для фигур, остаётся выше)"
                  >
                    Всем дорожкам
                  </button>
                  <label className="muted" htmlFor="lane-width">
                    Ширина дорожек, px
                  </label>
                  <input
                    id="lane-width"
                    key={`w:${W}`}
                    type="number"
                    min={diagramMinWidth(draft)}
                    step={10}
                    defaultValue={W}
                    style={{ width: 80 }}
                    onBlur={(e) => applyWidth(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") applyWidth((e.target as HTMLInputElement).value);
                    }}
                  />
                  <button disabled={configuredWidth(draft) === undefined} onClick={() => commit(setDiagramWidth(draft, null))} title="Снять заданную ширину: дорожки по содержимому">
                    По содержимому
                  </button>
                  <span className="muted">границы дорожек можно тянуть мышью: нижнюю — высота ({MIN_LANE_H}–{MAX_LANE_H} px), правую — ширина (не уже, чем нужно фигурам, сейчас от {diagramMinWidth(draft)} px); шаг 10, Alt — точно</span>
                </div>
              );
            })()}
          {curSel?.kind === "flow" &&
            (() => {
              const flow = draft.flows.find((f) => f.id === curSel.id);
              if (!flow) return null;
              return (
                <div className="bpe-selbar" role="toolbar" aria-label="Действия со стрелкой">
                  <span className="muted">{flow.route ? "Маршрут задан вручную" : "Маршрут автоматический"}</span>
                  <button
                    onClick={() => {
                      const g = flowGeometry(flow.id);
                      const next = g ? addBend(draft, flow.id, g) : draft;
                      if (next === draft) showHint("Нет отрезка, на котором можно добавить излом");
                      else commit(next);
                    }}
                    title="Добавить ступеньку на самом длинном отрезке — её можно потянуть куда нужно (то же: Ctrl + двойной щелчок по стрелке)"
                  >
                    Добавить излом
                  </button>
                  <button disabled={!flow.route} onClick={() => commit(setFlowRoute(draft, flow.id, null))} title="Вернуть автоматическую прокладку этой стрелки">
                    Сбросить маршрут
                  </button>
                  <button onClick={() => commit(deleteFlow(draft, flow.id), null)} title="Удалить стрелку (Delete)">
                    Удалить
                  </button>
                  <span className="muted">● — конец (на другую сторону, фигуру или вдоль стороны) · ▮ — сдвинуть участок · ■ — перенести излом · Ctrl + двойной щелчок по линии — новый излом, двойной щелчок по излому — убрать, по линии без Ctrl — править условие · розовая линия — выравнивание, к ней прилипает (Alt — без привязки)</span>
                </div>
              );
            })()}
          {curSel?.kind === "message" &&
            (() => {
              const msg = (draft.messages ?? []).find((x) => x.id === curSel.id);
              if (!msg) return null;
              const rid = `msg:${msg.id}`;
              return (
                <div className="bpe-selbar" role="toolbar" aria-label="Действия с потоком сообщений">
                  <span className="muted">{msg.route ? "Маршрут задан вручную" : "Маршрут автоматический"}</span>
                  <button
                    onClick={() => {
                      const g = flowGeometry(rid);
                      const next = g ? addBend(draft, rid, g) : draft;
                      if (next === draft) showHint("Нет отрезка, на котором можно добавить излом");
                      else commit(next);
                    }}
                    title="Добавить ступеньку на самом длинном отрезке — её можно потянуть (то же: Ctrl + двойной щелчок по линии)"
                  >
                    Добавить излом
                  </button>
                  <button disabled={!msg.route} onClick={() => commit(setFlowRoute(draft, rid, null))} title="Вернуть автоматическую прокладку этой стрелки">
                    Сбросить маршрут
                  </button>
                  <button onClick={() => h.commit(deleteMessage(draftRef.current, msg.id)) && setSel(null)} title="Удалить поток сообщений (Delete)">
                    Удалить
                  </button>
                  <span className="muted">▮ — сдвинуть участок · ■ — перенести излом · двойной щелчок по излому — убрать, по линии — переименовать</span>
                </div>
              );
            })()}
          {curSel?.kind === "artifact" &&
            (() => {
              const sel = curSel;
              const placed = draft.nodes.find((n) => n.id === sel.node)?.artifact_offsets?.[sel.key];
              return (
                <div className="bpe-selbar" role="toolbar" aria-label="Действия со значком">
                  <span className="muted">{placed ? "Положение задано вручную" : "Положение автоматическое"}</span>
                  <button disabled={!placed} onClick={() => commit(setArtifactOffset(draft, sel.node, sel.key, null))} title="Вернуть значок на автоматическое место у задачи">
                    Вернуть на место
                  </button>
                  <span className="muted">Потяните значок, чтобы переставить; двойной щелчок — переименовать.</span>
                </div>
              );
            })()}
          {curSel?.kind === "pool" &&
            (() => {
              const pool = (draft.pools ?? []).find((p) => p.id === curSel.id);
              if (!pool) return null;
              const placed = !!(pool.dx || pool.dy);
              return (
                <div className="bpe-selbar" role="toolbar" aria-label="Действия с пулом">
                  <span className="muted">{placed ? "Положение задано вручную" : "Положение автоматическое"}</span>
                  <button disabled={!placed} onClick={() => h.commit(setPoolOffset(draftRef.current, pool.id, 0, 0))} title="Вернуть пул на автоматическое место под диаграммой">
                    Вернуть на место
                  </button>
                  <button onClick={() => h.commit(deletePool(draftRef.current, pool.id)) && setSel(null)} title="Удалить пул вместе с потоками сообщений (Delete)">
                    Удалить
                  </button>
                </div>
              );
            })()}
          {curSel?.kind !== "flow" && (pickedIds.length > 0 || hasClipboard()) && (
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
              stamp={frameOn ? frameGeo.footer : undefined}
            />
          )}
          <div className="bpe-corner muted">
            {shown.length} элем. · {vflows.length} связей · {Math.round(worldH)}px
          </div>
        </div>
      </div>
    </div>
  );
}
