import { DEFAULT_DISPLAY, type DisplayOptions } from "../editor-core/display";
import { styleOf } from "@shared/shapeStyles";
import { useEffect, useRef, useState } from "react";
import type { ProcessLogicModel } from "../../types";
import { handleCommonKeys, isTextInput, useBeforeUnload, useDraftPersistence, useHint, useModelHistory, useViewport, type Pt } from "../editor-core/hooks";
import { DraftBanner, RenameOverlay } from "../editor-core/fields";
import EditorToolbar from "../editor-core/EditorToolbar";
import { processCodeOf } from "@shared/codes";
import { deleteNode, duplicateNode, updateNode } from "../bpmn-editor/model-ops";
import MiniMap from "../bpmn-editor/MiniMap";
import { GUIDE_SNAP_PX, guideFor, guideTargets, snapAxis, type Guide, type GuideTarget } from "../bpmn-editor/guides";
import { frameGeometry, frameKey, frameShown, gridShown, withFrameHeight, type FrameField } from "@shared/idef0Frame";
import { FrameMenu, dragRect, startFrameDrag, type FrameDrag } from "../editor-core/sheetFrame";
import { MIN_POS, ancestorsOf, buildIdef0, idef0Codes, idef0Extents, labelSpec, snap, withIdef0Layout, type Arrow } from "./geometry";
import { ARROW_GRID, addBend, clampFreeEnd, dragCorner, dragSegment, fractionAlong, hasManualRoute, removeBend, resetArrow, setFreeEnd, setLabelOffset, slideEnd } from "./arrow-edit";
import { addFunction, linkFunctions, moveFunction, reconnectArrow, removeArrow, renameEntity, setArrowIcom, setFrame } from "./ops";
import { alignLeft, alignTop, blocksInRect, boundsOf, copyFragment, deleteGroup, distributeHorizontally, distributeVertically, hasClipboard, hasDecomposition, moveGroup, pasteFragment, selectableIds, setClipboard, takeClipboard } from "./selection-ops";
import { ArrowHandles, ArrowShape, BlockShape, FrameLayer, FreeNoteShape, Idef0Defs, ImageShape } from "./shapes";
import { addNote, deleteNote, moveNote, notesOf, resizeNote, updateNote } from "./notes";
import { IMAGE_MAX_CHARS, addImage, deleteImage, imagesOf, moveImage, resizeImage } from "./images";
import type { Selection } from "../studio/selection";

type M = ProcessLogicModel;
// стрелка выделена по ключу, а если ключ сменился (вход стал управлением) — находится по функции и сущности
type Sel = { kind: "fn"; id: string } | { kind: "arrow"; id: string; nodeId?: string; entityId?: string } | { kind: "note"; id: string } | { kind: "image"; id: string } | null;
const arrowSelOf = (a: Pick<Arrow, "key" | "nodeId" | "entityId">): Sel => ({ kind: "arrow", id: a.key, nodeId: a.nodeId, entityId: a.entityId });
type Zone = "input" | "control";
type Drag =
  | { kind: "pan"; sx: number; sy: number; tx: number; ty: number }
  | { kind: "fn"; id: string; offX: number; offY: number; startModel: M; moved: boolean; sx: number; sy: number }
  | { kind: "marquee"; x0: number; y0: number; add: boolean }
  // лист двигают (edge = "move") или растягивают за край и угол (n, s, e, w, ne…): r0 — лист в начале жеста (x, y, w, h поля без штампа)
  | ({ kind: "frame"; startModel: M } & FrameDrag)
  | { kind: "group"; id: string; ids: string[]; base: M; startModel: M; x0: number; y0: number; moved: boolean }
  // свободный текстовый блок или рисунок двигают (kind "free") или растягивают за угол ("freeSize");
  // target говорит, что именно: у них одинаковый жест, но разные поля модели. w0/h0 — размер в начале жеста
  | { kind: "free"; target: "note" | "image"; id: string; offX: number; offY: number; startModel: M; moved: boolean; sx: number; sy: number }
  | { kind: "freeSize"; target: "note" | "image"; id: string; startModel: M; moved: boolean; x0: number; y0: number; w0: number; h0: number }
  | { kind: "connect"; from: string }
  // правка выбранной стрелки: a — стрелка в начале жеста (от её ломаной пересчитывается каждый шаг), start — модель до жеста
  | { kind: "aseg"; a: Arrow; i: number; axis: "x" | "y"; start: M; x0: number; y0: number; moved: boolean }
  | { kind: "acorner"; a: Arrow; i: number; start: M; x0: number; y0: number; v: Pt; moved: boolean }
  | { kind: "aend"; a: Arrow; end: "block" | "producer" | "free"; start: M; x0: number; y0: number; moved: boolean }
  | { kind: "alabel"; a: Arrow; start: M; x0: number; y0: number; off0: Pt; moved: boolean };

/** Верхняя треть блока-цели при протягивании связи — управление, остальное — вход. */
const CONTROL_ZONE = 0.3;
const DATA_KINDS = new Set(["input", "link", "controlData", "controlLink"]);
const CONTROL_KINDS = new Set(["control", "controlData", "controlLink"]);

export default function Idef0Editor({
  model,
  busy,
  onSave,
  draftId,
  draftBase,
  history,
  focus,
  parentId: parentProp,
  onParentChange,
  onSelectionChange,
  display = DEFAULT_DISPLAY,
}: {
  /** Вид на экране: слой подписей и номера блоков. */
  display?: DisplayOptions;
  model: M;
  busy: boolean;
  onSave: (m: M) => Promise<boolean>;
  /** Ключ черновика (сессия + редактор) и версия модели, на которой он основан. */
  draftId: string;
  draftBase: string;
  /** Общая история окна студии: если задана, редактор работает с ней, а черновик и сохранение ведёт студия. */
  history?: ReturnType<typeof useModelHistory<M>>;
  /** Перейти к функции по запросу извне (навигатор, список проверок); nonce меняется при каждом запросе. */
  focus?: { id: string; nonce: number } | null;
  /** Открытая диаграмма (null — A0), если её выбирает студия; onParentChange сообщает о переходах по декомпозиции. */
  parentId?: string | null;
  onParentChange?: (id: string | null) => void;
  /** Выделение сообщается окну студии — по нему панель «Свойства» показывает карточку функции или стрелки. */
  onSelectionChange?: (sel: Selection) => void;
}) {
  const local = useModelHistory<M>(() => withIdef0Layout(model));
  const h = history ?? local;
  const embedded = !!history;
  const { draft, draftRef, setDraft } = h;
  const persisted = useDraftPersistence<M>({ id: draftId, base: draftBase, draft, dirty: h.dirty, restore: (m) => h.setDraft(m), enabled: !embedded });
  const [localParent, setLocalParent] = useState<string | null>(null); // какая диаграмма открыта: null — A0
  const parentId = parentProp !== undefined ? parentProp : localParent;
  const setParentId = (id: string | null) => {
    setLocalParent(id);
    onParentChange?.(id);
  };
  const [sel, setSel] = useState<Sel>(null);
  /** Несколько выделенных блоков (от двух); один выделенный блок — это обычный sel. */
  const [multi, setMulti] = useState<string[]>([]);
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [showMap, setShowMap] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [connectTo, setConnectTo] = useState<Pt | null>(null);
  // цель при переносе стрелки или протягивании связи; zone — только когда зона блока что-то решает (вход или управление)
  const [connectHot, setConnectHot] = useState<{ id: string; zone: Zone | null } | null>(null);
  const hotRef = useRef<{ id: string; zone: Zone | null } | null>(null);
  /** Направляющие выравнивания при правке стрелки и «призрак» переносимого конца. */
  const [guides, setGuides] = useState<Guide[]>([]);
  const [ghost, setGhost] = useState<{ from: Pt; to: Pt } | null>(null);
  const arrowHinted = useRef(false);
  const { hint, showHint } = useHint();

  const rootRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<Drag | null>(null);

  // открытая диаграмма могла исчезнуть (удалили родителя, отменили правку) — тогда показываем A0
  const cur = parentId && draft.nodes.some((n) => n.id === parentId) ? parentId : null;
  const layout = buildIdef0(draft, cur);
  const blockStyle = styleOf(draft, "idef0_block");
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const frame = draft.idef0_frames?.[frameKey(cur)];
  const frameRef = useRef(frame);
  frameRef.current = frame;
  const { view, setView, fit, toWorld, zoomBy, centerOn } = useViewport(svgRef, wrapRef, () => withFrameHeight(idef0Extents(layoutRef.current), frameRef.current), { fitKey: cur ?? "root" });
  useBeforeUnload(h.dirty && !embedded);

  const codes = idef0Codes(draft);
  const blocks = new Map(layout.functions.map((f) => [f.node.id, f] as const));
  const arrowOf = (s: Extract<Sel, { kind: "arrow" }>) =>
    layout.arrows.find((a) => a.key === s.id) ?? (s.nodeId ? layout.arrows.find((a) => a.nodeId === s.nodeId && a.entityId === s.entityId) : undefined);
  const curSel: Sel = !sel ? null : sel.kind === "fn" ? (blocks.has(sel.id) ? sel : null) : sel.kind === "note" || sel.kind === "image" ? sel : ((a) => (a ? arrowSelOf(a) : null))(arrowOf(sel));

  /** Выбранная стрелка в её сегодняшнем виде (с ручным маршрутом, если он есть). */
  const arrowSel = curSel?.kind === "arrow" ? layout.arrows.find((a) => a.key === curSel.id) : undefined;

  const groupIds = multi.filter((id) => blocks.has(id));
  const inGroup = groupIds.length >= 2;
  /** Что сейчас выделено: группа блоков, один блок или ничего. */
  const pickedIds = inGroup ? groupIds : curSel?.kind === "fn" ? [curSel.id] : [];

  const toSelection = (s: Sel): Selection => {
    if (!s) return null;
    if (s.kind === "fn") return { kind: "node", id: s.id };
    if (s.kind === "note" || s.kind === "image") return null; // у свободного блока и рисунка нет карточки в панели
    const arrow = layout.arrows.find((a) => a.key === s.id);
    return arrow ? { kind: "arrow", arrow } : null;
  };
  /** Выбор мышью: сообщаем студии всегда, даже если выделен тот же элемент (панель могла уйти к другой записи). */
  const pick = (s: Sel) => {
    setSel(s);
    onSelectionChange?.(toSelection(s));
    if (s?.kind === "arrow" && !arrowHinted.current) {
      arrowHinted.current = true;
      showHint("Ручки стрелки: ○ конец (потяните вдоль стороны или на другую функцию), ▭ отрезок, ■ излом; двойной щелчок по линии — править название, Ctrl + двойной щелчок — излом");
    }
  };
  // выделение изменилось не мышью (переход из навигатора, новая функция, удаление) — тоже сообщаем
  useEffect(() => {
    onSelectionChange?.(toSelection(curSel));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curSel?.kind, curSel?.id]);

  const commit = (next: M, nextSel?: Sel) => {
    if (h.commit(next) && nextSel !== undefined) setSel(nextSel);
  };
  const save = async () => {
    const snapshot = draftRef.current;
    if (await onSave(snapshot)) h.markSaved(snapshot);
  };

  const openDiagram = (id: string | null) => {
    setParentId(id);
    setMulti([]);
    setSel(null);
    setEditing(null);
  };
  /** Выбрать функцию, при необходимости перейдя на её диаграмму (например, из списка замечаний). */
  const selectFn = (id: string) => {
    const n = draft.nodes.find((x) => x.id === id);
    if (!n) return;
    const home = n.idef0_parent ?? null;
    if (home !== cur && !(cur === null && layout.functions.some((f) => f.node.id === id))) setParentId(home);
    setSel({ kind: "fn", id });
  };

  // переход к функции по запросу извне; диаграмму при необходимости открывает студия, поэтому ждём, пока блок появится
  const handledFocus = useRef(-1);
  useEffect(() => {
    if (!focus || handledFocus.current === focus.nonce) return;
    const f = layoutRef.current.functions.find((x) => x.node.id === focus.id);
    if (f) {
      handledFocus.current = focus.nonce;
      setSel({ kind: "fn", id: f.node.id });
      centerOn(f.box);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.nonce, cur]);

  const addAt = (at: Pt) => {
    const added = addFunction(draftRef.current, cur, at[0], at[1]);
    commit(added.model, { kind: "fn", id: added.id! });
    setEditing(added.id!);
  };

  /** Зона блока под курсором: управление — верхняя треть. */
  const zoneAt = (id: string, wy: number): Zone => {
    const b = blocks.get(id)!.box;
    return wy < b.y + b.h * CONTROL_ZONE ? "control" : "input";
  };

  // --- правка выбранной стрелки ---

  /** Опорные линии для выравнивания: границы блоков и вершины других стрелок. */
  const alignBoxes = () => layout.functions.map((f) => f.box);
  const otherArrowLines = (key: string) => layout.arrows.filter((x) => x.key !== key).map((x) => x.points);

  const arrowMove = (d: Extract<Drag, { kind: "aseg" | "acorner" | "aend" | "alabel" }>, e: React.PointerEvent) => {
    const [wx, wy] = toWorld(e.clientX, e.clientY);
    const free = e.altKey; // Alt — без сетки и направляющих
    const tol = GUIDE_SNAP_PX / view.k;
    const tooEarly = (dx: number, dy: number) => !d.moved && Math.hypot(dx, dy) * view.k < 4;

    if (d.kind === "aseg") {
      // отрезок сдвигается поперёк себя: к сетке или к направляющей (граница блока, вершина этой или другой стрелки)
      const raw = d.axis === "y" ? wy - d.y0 : wx - d.x0;
      if (tooEarly(raw, 0)) return;
      d.moved = true;
      const [p, q] = [d.a.points[d.i], d.a.points[d.i + 1]];
      const base = d.axis === "y" ? p[1] : p[0];
      let value = base + (free ? raw : Math.round(raw / ARROW_GRID) * ARROW_GRID);
      let guide: Guide | null = null;
      if (!free) {
        const last = d.a.points.length - 1;
        const s = snapAxis(base + raw, guideTargets(d.axis, alignBoxes(), d.a.points, [d.i, d.i + 1].filter((j) => j > 0 && j < last), otherArrowLines(d.a.key)), tol);
        if (s.hit.length > 0) {
          value = s.value;
          guide = guideFor(d.axis, value, s.hit, d.axis === "y" ? [p[0], q[0]] : [p[1], q[1]]);
        }
      }
      setGuides(guide ? [guide] : []);
      setDraft(() => dragSegment(d.start, d.a, d.i, value - base));
    } else if (d.kind === "acorner") {
      if (tooEarly(wx - d.x0, wy - d.y0)) return;
      d.moved = true;
      const [rx, ry] = [d.v[0] + wx - d.x0, d.v[1] + wy - d.y0];
      let [x, y] = free ? [rx, ry] : [Math.round(rx / ARROW_GRID) * ARROW_GRID, Math.round(ry / ARROW_GRID) * ARROW_GRID];
      const found: { axis: "x" | "y"; hit: GuideTarget[] }[] = [];
      if (!free) {
        const sx = snapAxis(rx, guideTargets("x", alignBoxes(), d.a.points, [d.i], otherArrowLines(d.a.key)), tol);
        const sy = snapAxis(ry, guideTargets("y", alignBoxes(), d.a.points, [d.i], otherArrowLines(d.a.key)), tol);
        if (sx.hit.length > 0) (x = sx.value, found.push({ axis: "x", hit: sx.hit }));
        if (sy.hit.length > 0) (y = sy.value, found.push({ axis: "y", hit: sy.hit }));
      }
      setGuides(found.map((f) => guideFor(f.axis, f.axis === "x" ? x : y, f.hit, f.axis === "x" ? [y - 12, y + 12] : [x - 12, x + 12])));
      setDraft(() => dragCorner(d.start, d.a, d.i, [x, y]));
    } else if (d.kind === "alabel") {
      if (tooEarly(wx - d.x0, wy - d.y0)) return;
      d.moved = true;
      const g = (v: number) => (free ? v : Math.round(v / 5) * 5);
      setDraft(() => setLabelOffset(d.start, d.a, g(d.off0[0] + wx - d.x0), g(d.off0[1] + wy - d.y0)));
    } else {
      if (tooEarly(wx - d.x0, wy - d.y0)) return;
      d.moved = true;
      const a = d.a;
      const own = d.end === "producer" ? a.fromId : a.nodeId;
      // куда указывает конец: другая функция — перенос стрелки; свой блок с другой зоной — вход становится управлением (и наоборот)
      const over = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-fn-id]")?.getAttribute("data-fn-id") ?? null;
      let hot: { id: string; zone: Zone | null } | null = null;
      if (d.end !== "free" && over && blocks.has(over)) {
        const data = d.end === "block" && DATA_KINDS.has(a.kind);
        const zone = zoneAt(over, wy);
        if (over !== own) hot = { id: over, zone: data ? zone : null };
        else if (data && zone !== (CONTROL_KINDS.has(a.kind) ? "control" : "input")) hot = { id: over, zone };
      }
      hotRef.current = hot;
      setConnectHot(hot);
      if (hot) {
        // неподвижный конец стрелки: у конца у блока (не у выхода) — её начало, в остальных случаях — конец
        const fixed = d.end === "block" && a.kind !== "output" ? a.points[0] : a.points[a.points.length - 1];
        setGhost({ from: fixed, to: [wx, wy] });
        setGuides([]);
        setDraft(() => d.start); // пока цель выбрана, стрелка стоит на месте
        return;
      }
      setGhost(null);
      if (d.end === "free") {
        // свободный конец: к сетке и направляющим по обеим осям, не ближе MIN_FREE к блоку
        let [x, y] = [wx, wy];
        const found: { axis: "x" | "y"; hit: GuideTarget[] }[] = [];
        // оси, где положение уже точное: встало на направляющую (порт, блок, другая стрелка) или зажат Alt — к сетке не округляется
        const exact = { x: free, y: free };
        if (!free) {
          const sx = snapAxis(x, guideTargets("x", alignBoxes(), a.points, [], otherArrowLines(a.key)), tol);
          const sy = snapAxis(y, guideTargets("y", alignBoxes(), a.points, [], otherArrowLines(a.key)), tol);
          if (sx.hit.length > 0) (x = sx.value, (exact.x = true), found.push({ axis: "x", hit: sx.hit }));
          if (sy.hit.length > 0) (y = sy.value, (exact.y = true), found.push({ axis: "y", hit: sy.hit }));
        }
        const box = blocks.get(a.nodeId)!.box;
        const end = clampFreeEnd(box, a.kind, [x, y], exact);
        setGuides(found.map((f) => guideFor(f.axis, f.axis === "x" ? end[0] : end[1], f.hit, f.axis === "x" ? [end[1] - 12, end[1] + 12] : [end[0] - 12, end[0] + 12])));
        setDraft(() => setFreeEnd(d.start, a, end));
      } else {
        // конец у блока едет вдоль его стороны
        const box = blocks.get(own!)?.box;
        if (!box) return;
        setGuides([]);
        setDraft(() => slideEnd(d.start, a, fractionAlong(box, a, [wx, wy], d.end === "producer"), d.end === "producer"));
      }
    }
  };

  /** Отпускание ручки: перенос на другую функцию меняет связь в модели, остальное — шаг истории. */
  const arrowUp = (d: Extract<Drag, { kind: "aseg" | "acorner" | "aend" | "alabel" }>) => {
    setGuides([]);
    setGhost(null);
    const hot = hotRef.current;
    hotRef.current = null;
    setConnectHot(null);
    if (d.kind === "aend" && hot) {
      const r = reconnectArrow(d.start, d.a, d.end === "producer" ? "producer" : "block", hot.id, hot.zone ?? "input");
      if (r.error) {
        showHint(r.error);
        setDraft(() => d.start);
        return;
      }
      h.recordPast(d.start);
      setDraft(() => r.model);
      const next = buildIdef0(r.model, cur).arrows.find((x) => x.nodeId === r.nodeId && x.entityId === r.entityId);
      if (next) setSel(arrowSelOf(next));
      return;
    }
    if (d.moved) h.recordPast(d.start);
  };

  // --- указатель ---

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    rootRef.current?.focus();
    if (editing) return;
    const t = e.target as Element;
    const openEl = t.closest("[data-open]");
    if (openEl && e.button === 0) {
      openDiagram(openEl.getAttribute("data-open"));
      return;
    }
    // лист: край или угол растягивают, штамп двигает (щелчок по надписи без движения — только выбор для двойного щелчка)
    const frameDrag = e.button === 0 ? startFrameDrag(t, toWorld(e.clientX, e.clientY), frameGeo) : null;
    if (frameDrag) {
      dragRef.current = { kind: "frame", ...frameDrag, startModel: draftRef.current };
      svgRef.current!.setPointerCapture(e.pointerId);
      return;
    }
    // ручки выбранной стрелки
    const handleEl = t.closest("[data-ah]");
    if (handleEl && e.button === 0 && arrowSel) {
      const [what, idx] = handleEl.getAttribute("data-ah")!.split("|");
      const [wx, wy] = toWorld(e.clientX, e.clientY);
      const start = draftRef.current;
      const a = arrowSel;
      if (what === "seg") {
        const i = Number(idx);
        const horizontal = Math.abs(a.points[i][1] - a.points[i + 1][1]) < 0.5;
        dragRef.current = { kind: "aseg", a, i, axis: horizontal ? "y" : "x", start, x0: wx, y0: wy, moved: false };
      } else if (what === "corner") {
        const i = Number(idx);
        dragRef.current = { kind: "acorner", a, i, start, x0: wx, y0: wy, v: a.points[i], moved: false };
      } else if (what === "end") {
        dragRef.current = { kind: "aend", a, end: idx as "block" | "producer" | "free", start, x0: wx, y0: wy, moved: false };
      } else {
        dragRef.current = { kind: "alabel", a, start, x0: wx, y0: wy, off0: a.labelOffset ?? [0, 0], moved: false };
      }
      e.preventDefault();
      svgRef.current!.setPointerCapture(e.pointerId);
      return;
    }
    const connectEl = t.closest("[data-connect]");
    const fnEl = t.closest("[data-fn-id]");
    const arrowEl = t.closest("[data-arrow-key]");
    const onEmpty = !connectEl && !fnEl && !arrowEl;

    if (e.button === 0 && e.shiftKey && onEmpty) {
      // Shift + рамка: выделить несколько блоков (с Ctrl — добавить к уже выделенным)
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
    } else if (fnEl) {
      const id = fnEl.getAttribute("data-fn-id")!;
      const f = blocks.get(id);
      if (!f) return;
      const [wx, wy] = toWorld(e.clientX, e.clientY);
      if (e.shiftKey) {
        // Shift + щелчок: добавить блок в выделение или убрать из него
        selectIds(pickedIds.includes(id) ? pickedIds.filter((x) => x !== id) : [...pickedIds, id]);
        return;
      }
      if (inGroup && groupIds.includes(id)) {
        // потянули блок из выделенной группы — едет вся группа
        dragRef.current = { kind: "group", id, ids: groupIds, base: draftRef.current, startModel: draftRef.current, x0: wx, y0: wy, moved: false };
        svgRef.current!.setPointerCapture(e.pointerId);
        return;
      }
      setMulti([]);
      pick({ kind: "fn", id });
      dragRef.current = { kind: "fn", id, offX: wx - f.box.x, offY: wy - f.box.y, startModel: draft, moved: false, sx: e.clientX, sy: e.clientY };
      svgRef.current!.setPointerCapture(e.pointerId);
    } else if (arrowEl) {
      setMulti([]);
      const clicked = layout.arrows.find((a) => a.key === arrowEl.getAttribute("data-arrow-key"));
      if (clicked) pick(arrowSelOf(clicked));
    }
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const d = dragRef.current;
    if (!d) return;
    if (d.kind === "frame") {
      const [wx, wy] = toWorld(e.clientX, e.clientY);
      if (!d.moved && Math.hypot(wx - d.x0, wy - d.y0) * view.k < 3) return;
      d.moved = true;
      setDraft((m) => setFrame(m, frameKey(cur), { rect: dragRect(d, wx - d.x0, wy - d.y0) }));
      return;
    }
    if (d.kind === "pan") {
      setView((v) => ({ ...v, tx: d.tx + e.clientX - d.sx, ty: d.ty + e.clientY - d.sy }));
    } else if (d.kind === "fn") {
      if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 4) return;
      d.moved = true;
      const [wx, wy] = toWorld(e.clientX, e.clientY);
      setDraft((m) => moveFunction(m, d.id, Math.max(MIN_POS, snap(wx - d.offX)), Math.max(MIN_POS, snap(wy - d.offY))));
    } else if (d.kind === "marquee") {
      const [wx, wy] = toWorld(e.clientX, e.clientY);
      setMarquee({ x: Math.min(d.x0, wx), y: Math.min(d.y0, wy), w: Math.abs(wx - d.x0), h: Math.abs(wy - d.y0) });
    } else if (d.kind === "group") {
      const [wx, wy] = toWorld(e.clientX, e.clientY);
      if (!d.moved && Math.hypot(wx - d.x0, wy - d.y0) * view.k < 4) return;
      d.moved = true;
      setDraft(() => moveGroup(d.base, cur, d.ids, wx - d.x0, wy - d.y0));
    } else if (d.kind === "free") {
      if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 4) return;
      d.moved = true;
      const [wx, wy] = toWorld(e.clientX, e.clientY);
      setDraft((m) => (d.target === "note" ? moveNote(m, d.id, snap(wx - d.offX), snap(wy - d.offY)) : moveImage(m, d.id, snap(wx - d.offX), snap(wy - d.offY))));
    } else if (d.kind === "freeSize") {
      const [wx, wy] = toWorld(e.clientX, e.clientY);
      d.moved = true;
      setDraft((m) => (d.target === "note" ? resizeNote(m, d.id, d.w0 + wx - d.x0, d.h0 + wy - d.y0) : resizeImage(m, d.id, d.w0 + wx - d.x0, d.h0 + wy - d.y0)));
    } else if (d.kind === "aseg" || d.kind === "acorner" || d.kind === "aend" || d.kind === "alabel") {
      arrowMove(d, e);
    } else {
      const [wx, wy] = toWorld(e.clientX, e.clientY);
      setConnectTo([wx, wy]);
      const target = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-fn-id]")?.getAttribute("data-fn-id") ?? null;
      setConnectHot(target && target !== d.from && blocks.has(target) ? { id: target, zone: zoneAt(target, wy) } : null);
    }
  };

  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (svgRef.current?.hasPointerCapture(e.pointerId)) svgRef.current.releasePointerCapture(e.pointerId);
    if (!d) return;
    if (d.kind === "fn" && d.moved) {
      h.recordPast(d.startModel);
    } else if (d.kind === "frame") {
      if (d.moved) h.recordPast(d.startModel);
    } else if (d.kind === "group") {
      if (d.moved) h.recordPast(d.startModel);
      else {
        // щелчок без движения по члену группы — оставляем только этот блок
        setMulti([]);
        pick({ kind: "fn", id: d.id });
      }
    } else if ((d.kind === "free" || d.kind === "freeSize") && d.moved) {
      h.recordPast(d.startModel);
    } else if (d.kind === "marquee") {
      const rect = marquee;
      setMarquee(null);
      if (!rect || (rect.w < 3 && rect.h < 3)) return;
      const hit = blocksInRect(draftRef.current, cur, rect);
      selectIds(d.add ? [...new Set([...pickedIds, ...hit])] : hit);
    } else if (d.kind === "aseg" || d.kind === "acorner" || d.kind === "aend" || d.kind === "alabel") {
      arrowUp(d);
    } else if (d.kind === "connect") {
      const target = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-fn-id]")?.getAttribute("data-fn-id");
      setConnectTo(null);
      setConnectHot(null);
      if (target && target !== d.from && blocks.has(target)) {
        const [, wy] = toWorld(e.clientX, e.clientY);
        const r = linkFunctions(draftRef.current, d.from, target, zoneAt(target, wy));
        if (r.error) showHint(r.error);
        else commit(r.model, { kind: "arrow", id: r.key!, nodeId: target, entityId: r.id });
      }
    }
  };

  const onDoubleClick = (e: React.MouseEvent<SVGSVGElement>) => {
    // пока указатель захвачен ручкой или блоком, событие приходит на сам svg: цель определяем по координатам
    const under = document.elementFromPoint?.(e.clientX, e.clientY) ?? null;
    const t = (under && svgRef.current?.contains(under) ? under : e.target) as Element;
    const id = t.closest("[data-fn-id]")?.getAttribute("data-fn-id");
    if (t.closest("[data-open]")) return;
    const frameField = t.closest("[data-frame-field]")?.getAttribute("data-frame-field");
    if (frameField) {
      setEditing(`frame:${frameField}`);
      return;
    }
    // двойной щелчок: по излому — убрать его; по стрелке — править название (с Ctrl — добавить излом); по функции — править название;
    // по пустому месту ничего не происходит, а с Ctrl — создаётся функция
    const ctrl = e.ctrlKey || e.metaKey;
    const handle = t.closest("[data-ah]")?.getAttribute("data-ah") ?? "";
    if (handle.startsWith("corner|") && arrowSel) {
      commit(removeBend(draftRef.current, arrowSel, Number(handle.split("|")[1])));
      return;
    }
    // ручка отрезка — часть линии: двойной щелчок по ней то же, что по самой стрелке
    if (handle && !handle.startsWith("seg|")) return;
    const arrowKey = handle ? arrowSel?.key : t.closest("[data-arrow-key]")?.getAttribute("data-arrow-key");
    if (arrowKey) {
      const a = layout.arrows.find((x) => x.key === arrowKey);
      if (!a) return;
      if (ctrl) {
        const [wx, wy] = toWorld(e.clientX, e.clientY);
        const next = addBend(draftRef.current, a, [wx, wy]);
        if (next === draftRef.current) showHint("Отрезок слишком короткий для излома");
        else commit(next, arrowSelOf(a));
      } else {
        setSel(arrowSelOf(a));
        setEditing(`arrow:${a.key}`);
      }
      return;
    }
    if (id) {
      setEditing(id);
      return;
    }
    if (t.closest("[data-connect]")) return;
    if (ctrl) addAt(toWorld(e.clientX, e.clientY));
    else showHint("Функция создаётся по Ctrl + двойной щелчок или перетаскиванием «Функции» из палитры");
  };

  const addFromPalette = () => {
    const r = svgRef.current!.getBoundingClientRect();
    const [cx, cy] = toWorld(r.left + r.width / 2, r.top + r.height / 2);
    addAt([cx, cy]);
  };

  /** В12: свободный текстовый блок — справа от диаграммы, с правкой текста сразу после создания. */
  const addFreeNote = () => {
    const right = Math.max(640, ...layout.functions.map((f) => f.box.x + f.box.w));
    const r = addNote(draftRef.current, cur, right + 40, 40);
    commit(r.model, { kind: "note", id: r.id });
    setEditing(`note:${r.id}`);
  };

  /** Рисунок встаёт под текстовыми блоками справа от диаграммы, чтобы не накрыть блоки функций. */
  const addFreeImage = () => fileRef.current?.click();
  const onPickImage = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // тот же файл можно выбрать снова
    if (!file) return;
    if (!/^image\/(png|jpeg)$/.test(file.type)) return showHint("Рисунок: подходят только PNG и JPEG");
    const reader = new FileReader();
    reader.onload = () => {
      const data = String(reader.result ?? "");
      if (data.length > IMAGE_MAX_CHARS) return showHint(`Рисунок больше ${Math.round(IMAGE_MAX_CHARS / 1000)} тыс. знаков — уменьшите файл`);
      const probe = new Image();
      probe.onload = () => {
        const right = Math.max(640, ...layout.functions.map((f) => f.box.x + f.box.w), ...notes.map((n) => n.x + n.w));
        const r = addImage(draftRef.current, cur, { name: file.name, data, w: probe.naturalWidth, h: probe.naturalHeight }, right + 40, 40);
        commit(r.model, { kind: "image", id: r.id });
      };
      probe.onerror = () => showHint("Не удалось прочитать рисунок");
      probe.src = data;
    };
    reader.readAsDataURL(file);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.getData("application/x-idef0-new")) addAt(toWorld(e.clientX, e.clientY));
  };

  // --- группа: копирование, вставка, выравнивание ---

  /** Выделить набор блоков: два и больше — группа, один — обычное выделение. */
  function selectIds(ids: string[]) {
    setMulti(ids.length >= 2 ? ids : []);
    pick(ids.length === 0 ? null : { kind: "fn", id: ids[ids.length - 1] });
  }
  const copySelected = () => {
    const frag = copyFragment(draftRef.current, cur, pickedIds);
    if (!frag) return showHint("Сначала выделите блоки");
    setClipboard(frag);
    showHint(`Скопировано: ${frag.nodes.length} (Ctrl+V — вставить, можно на другой уровень; вложенные функции не копируются)`);
  };
  const pasteFrom = (frag: NonNullable<ReturnType<typeof copyFragment>>, off: number) => {
    const r = pasteFragment(draftRef.current, cur, frag, off, off);
    commit(r.model);
    selectIds(r.ids);
  };
  const pasteClipboard = () => {
    const c = takeClipboard();
    if (!c) return showHint("Буфер пуст: выделите блоки и нажмите Ctrl+C");
    pasteFrom(c.fragment, 40 * c.n);
  };
  const duplicateSelected = () => {
    const frag = copyFragment(draftRef.current, cur, pickedIds);
    if (frag) pasteFrom(frag, 40);
  };
  const deleteSelected = () => {
    if (pickedIds.length === 0) return;
    commit(deleteGroup(draftRef.current, pickedIds), null);
    setMulti([]);
  };
  const zoomToSelection = () => {
    const b = boundsOf(draftRef.current, cur, pickedIds);
    const el = wrapRef.current;
    if (!b || !el) return showHint("Сначала выделите блоки");
    const k = Math.min(1.5, Math.max(0.3, Math.min(el.clientWidth / (b.w + 120), el.clientHeight / (b.h + 120))));
    setView({ k, tx: el.clientWidth / 2 - (b.x + b.w / 2) * k, ty: el.clientHeight / 2 - (b.y + b.h / 2) * k });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (isTextInput(e.target)) return;
    if (handleCommonKeys(e, { undo: h.undo, redo: h.redo, save: () => h.dirty && !busy && void save() })) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = (l: string) => e.key.toLowerCase() === l || e.code === `Key${l.toUpperCase()}`; // в русской раскладке key — другая буква
    if (mod && key("a")) {
      e.preventDefault();
      selectIds(selectableIds(draftRef.current, cur));
      return;
    }
    if (mod && key("c")) {
      e.preventDefault();
      copySelected();
      return;
    }
    if (mod && key("x")) {
      e.preventDefault();
      // вырезание = копия + удаление, а копия не берёт вложенные функции: блок с декомпозицией так потерял бы её
      if (hasDecomposition(draftRef.current, pickedIds)) return showHint("Вырезать нельзя: у блока есть вложенные функции. Скопируйте или перенесите блок");
      copySelected();
      deleteSelected();
      return;
    }
    if (mod && key("v")) {
      e.preventDefault();
      pasteClipboard();
      return;
    }
    if (mod && key("d") && inGroup) {
      e.preventDefault();
      duplicateSelected();
      return;
    }
    if (e.key.startsWith("Arrow") && inGroup) {
      e.preventDefault();
      const step = e.shiftKey ? 50 : 10;
      const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
      const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
      commit(moveGroup(draftRef.current, cur, groupIds, dx, dy));
      return;
    }
    if ((e.key === "Delete" || e.key === "Backspace") && inGroup) {
      e.preventDefault();
      deleteSelected();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === "d" || e.code === "KeyD") && curSel?.kind === "fn") {
      e.preventDefault(); // иначе браузер добавит страницу в закладки
      const r = duplicateNode(draft, curSel.id);
      if (!r.error) commit(r.model, { kind: "fn", id: r.id! });
    } else if (e.key.startsWith("Arrow") && curSel?.kind === "fn") {
      // стрелки сдвигают выбранный блок на шаг сетки (Shift — на 5 шагов)
      e.preventDefault();
      const f = blocks.get(curSel.id);
      if (!f) return;
      const step = e.shiftKey ? 5 * 10 : 10;
      const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
      const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
      commit(moveFunction(draft, f.node.id, Math.max(MIN_POS, f.box.x + dx), Math.max(MIN_POS, f.box.y + dy)));
    } else if ((e.key === "Delete" || e.key === "Backspace") && curSel) {
      e.preventDefault();
      if (curSel.kind === "fn") commit(deleteNode(draft, curSel.id), null);
      else {
        const a = layout.arrows.find((x) => x.key === curSel.id);
        if (a) commit(removeArrow(draft, a), null);
      }
    } else if (e.key === "Escape") {
      setMulti([]);
      setSel(null);
      setEditing(null);
    }
  };

  const selectedFn = curSel?.kind === "fn" ? blocks.get(curSel.id) : undefined;
  // В12: свободные текстовые блоки текущей диаграммы
  const notes = notesOf(draft, cur);
  const images = imagesOf(draft, cur);
  const editingNote = editing?.startsWith("note:") ? notes.find((n) => n.id === editing.slice(5)) : undefined;
  const editingFn = editing ? blocks.get(editing) : undefined;
  /** Правка названия стрелки (редактируется запись документа, регламента, системы или исполнителя: подпись меняется у всех стрелок). */
  const editingArrow = editing?.startsWith("arrow:") ? layout.arrows.find((a) => a.key === editing.slice(6)) : undefined;
  const { w: worldW, h: worldH } = idef0Extents(layout);
  const parentNode = cur ? draft.nodes.find((n) => n.id === cur) : undefined;
  const frameOn = frameShown(frame);
  // надписи штампа по умолчанию: узел, название и номер листа
  const frameGeo = frameGeometry({ w: worldW, h: worldH }, frame, {
    node: cur ? codes.get(cur) ?? "A?" : "A0",
    title: cur ? `${codes.get(cur) ?? ""} ${parentNode?.name ?? ""}`.trim() : `${processCodeOf(draft)} ${draft.process.name}`.trim(),
    no: "1.0",
  });
  // функции, не помещающиеся на лист: лист заданный вручную не подгоняется под диаграмму
  const outside = frameOn && frame?.w !== undefined ? layout.functions.filter((f) => f.box.x < frameGeo.sheet.x || f.box.y < frameGeo.sheet.y || f.box.x + f.box.w > frameGeo.sheet.x + frameGeo.sheet.w || f.box.y + f.box.h > frameGeo.footer.y).length : 0;
  const editingFrame = editing?.startsWith("frame:") ? frameGeo.cells.find((c) => c.field === (editing.slice(6) as FrameField)) : undefined;
  const crumbs: { id: string | null; label: string }[] = [
    { id: null, label: processCodeOf(draft) },
    ...(cur ? [...ancestorsOf(draft, cur), cur] : []).map((id) => ({ id, label: codes.get(id) ?? "A?" })),
  ];

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
            <button className={showMap ? "on" : ""} onClick={() => setShowMap((v) => !v)} title="Миникарта диаграммы">
              Миникарта
            </button>
            <FrameMenu frame={frame} geo={frameGeo} outside={outside} onChange={(patch) => commit(setFrame(draftRef.current, frameKey(cur), patch))} />
            <button onClick={() => commit(withIdef0Layout(draft, true, cur))} title="Расставить блоки этой диаграммы по диагонали (можно отменить)">
              По диагонали
            </button>
            <button onClick={addFreeNote} title="Добавить свободный текстовый блок на диаграмму">
              Примечание
            </button>
            <button onClick={addFreeImage} title="Вставить рисунок PNG или JPEG на диаграмму">
              Рисунок
            </button>
            <input ref={fileRef} type="file" accept="image/png,image/jpeg" onChange={onPickImage} style={{ display: "none" }} data-image-input />
            <span className="bpe-sep" />
            <span className="bpe-crumbs" title="Уровень декомпозиции">
              {crumbs.map((c, i) => (
                <span key={c.id ?? "root"}>
                  {i > 0 && <span className="muted"> › </span>}
                  <button className={i === crumbs.length - 1 ? "primary" : ""} onClick={() => openDiagram(c.id)}>
                    {c.label}
                  </button>
                </span>
              ))}
            </span>
          </>
        }
      />

      <div className="bpe-body">
        <div className="bpe-palette">
          <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>
            Перетащите на холст или нажмите
          </div>
          <button draggable onDragStart={(e) => e.dataTransfer.setData("application/x-idef0-new", "1")} onClick={addFromPalette}>
            Функция
          </button>
          <div className="muted" style={{ fontSize: 11, marginTop: 14, lineHeight: 1.45 }}>
            Входы, управление, выходы и механизмы задаются в панели справа или протягиванием связи между функциями.
          </div>
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
            <Idef0Defs />
            <g transform={`translate(${view.tx} ${view.ty}) scale(${view.k})`}>
              {frameOn && <FrameLayer geo={frameGeo} grid={gridShown(frame)} />}
              {!frameOn && <text x={16} y={24} fontSize={14} fontWeight="bold" fontFamily="Arial, sans-serif" fill="#1f2937" pointerEvents="none">
                {cur ? `${codes.get(cur) ?? ""} — ${parentNode?.name ?? ""}` : `${processCodeOf(draft)} — ${draft.process.name}`}
              </text>}
              {layout.functions.length === 0 && (
                <text x={16} y={60} fontSize={13} fontFamily="Arial, sans-serif" fill="#64748b" pointerEvents="none">
                  Диаграмма пуста: добавьте функцию — Ctrl + двойной щелчок или перетащите её из палитры слева.
                </text>
              )}
              {layout.arrows.map((a) => (
                <ArrowShape key={a.key} arrow={a} showLabel={display.labels} showCode={display.idef0Icom} selected={curSel?.kind === "arrow" && curSel.id === a.key} />
              ))}
              {layout.functions.map((f) => (
                <BlockShape key={f.node.id} fn={f} style={blockStyle} showCode={display.idef0Numbers} selected={inGroup ? groupIds.includes(f.node.id) : curSel?.kind === "fn" && curSel.id === f.node.id} hot={connectHot?.id === f.node.id} />
              ))}
              {/* В12: рисунки (под текстовыми блоками) и свободные текстовые блоки (жёлтые) поверх блоков */}
              {images.map((im) => (
                <ImageShape
                  key={im.id}
                  image={im}
                  selected={curSel?.kind === "image" && curSel.id === im.id}
                  onSelect={() => pick({ kind: "image", id: im.id })}
                  onDelete={() => commit(deleteImage(draftRef.current, im.id), null)}
                  onGrab={(e) => {
                    const [wx, wy] = toWorld(e.clientX, e.clientY);
                    dragRef.current = { kind: "free", target: "image", id: im.id, offX: wx - im.x, offY: wy - im.y, startModel: draftRef.current, moved: false, sx: e.clientX, sy: e.clientY };
                    svgRef.current?.setPointerCapture(e.pointerId);
                  }}
                  onGrabSize={(e) => {
                    const [wx, wy] = toWorld(e.clientX, e.clientY);
                    dragRef.current = { kind: "freeSize", target: "image", id: im.id, startModel: draftRef.current, moved: false, x0: wx, y0: wy, w0: im.w, h0: im.h };
                    svgRef.current?.setPointerCapture(e.pointerId);
                  }}
                />
              ))}
              {notes.map((nt) => (
                <FreeNoteShape
                  key={nt.id}
                  note={nt}
                  selected={curSel?.kind === "note" && curSel.id === nt.id}
                  onSelect={() => pick({ kind: "note", id: nt.id })}
                  onEdit={() => {
                    pick({ kind: "note", id: nt.id });
                    setEditing(`note:${nt.id}`);
                  }}
                  onDelete={() => commit(deleteNote(draftRef.current, nt.id), null)}
                  onGrab={(e) => {
                    const [wx, wy] = toWorld(e.clientX, e.clientY);
                    dragRef.current = { kind: "free", target: "note", id: nt.id, offX: wx - nt.x, offY: wy - nt.y, startModel: draftRef.current, moved: false, sx: e.clientX, sy: e.clientY };
                    svgRef.current?.setPointerCapture(e.pointerId);
                  }}
                  onGrabSize={(e) => {
                    const [wx, wy] = toWorld(e.clientX, e.clientY);
                    dragRef.current = { kind: "freeSize", target: "note", id: nt.id, startModel: draftRef.current, moved: false, x0: wx, y0: wy, w0: nt.w, h0: nt.h };
                    svgRef.current?.setPointerCapture(e.pointerId);
                  }}
                />
              ))}

              {arrowSel && !editing && <ArrowHandles arrow={arrowSel} labelAt={labelSpec(arrowSel)} k={view.k} />}
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
              {ghost && <path d={`M${ghost.from[0]} ${ghost.from[1]} L${ghost.to[0]} ${ghost.to[1]}`} stroke="#4338ca" strokeWidth={2} strokeDasharray="6 4" fill="none" pointerEvents="none" />}

              {connectHot && blocks.get(connectHot.id) && connectHot.zone && (
                // подсказка зоны: зелёная полоса сверху — управление, слева — вход
                <rect
                  x={blocks.get(connectHot.id)!.box.x}
                  y={blocks.get(connectHot.id)!.box.y}
                  width={connectHot.zone === "control" ? blocks.get(connectHot.id)!.box.w : 6}
                  height={connectHot.zone === "control" ? 8 : blocks.get(connectHot.id)!.box.h}
                  fill="#16a34a"
                  opacity={0.7}
                  pointerEvents="none"
                />
              )}

              {inGroup && (() => {
                const b = boundsOf(draft, cur, groupIds);
                return b && <rect data-group-box x={b.x - 8} y={b.y - 8} width={b.w + 16} height={b.h + 16} fill="none" stroke="#4338ca" strokeWidth={1} strokeDasharray="5 4" pointerEvents="none" />;
              })()}
              {marquee && <rect data-marquee x={marquee.x} y={marquee.y} width={marquee.w} height={marquee.h} fill="rgba(67,56,202,0.08)" stroke="#4338ca" strokeDasharray="4 3" pointerEvents="none" />}

              {selectedFn && !inGroup && !editing && (
                <g data-connect={selectedFn.node.id} style={{ cursor: "crosshair" }}>
                  <circle cx={selectedFn.box.x + selectedFn.box.w + 12} cy={selectedFn.box.y + selectedFn.box.h + 12} r={9} fill="#4338ca" />
                  <path
                    d={`M${selectedFn.box.x + selectedFn.box.w + 8} ${selectedFn.box.y + selectedFn.box.h + 12} h8 m-3 -3 l3 3 l-3 3`}
                    stroke="#fff"
                    strokeWidth={1.8}
                    fill="none"
                    pointerEvents="none"
                  />
                </g>
              )}

              {connectTo && dragRef.current?.kind === "connect" && (() => {
                const f = blocks.get((dragRef.current as { from: string }).from);
                if (!f) return null;
                return <path d={`M${f.box.x + f.box.w} ${f.box.y + f.box.h / 2} L${connectTo[0]} ${connectTo[1]}`} stroke="#4338ca" strokeWidth={2} strokeDasharray="6 4" fill="none" pointerEvents="none" />;
              })()}
            </g>
          </svg>

          {editingFn && (
            <RenameOverlay
              key={editingFn.node.id}
              name={editingFn.node.name}
              box={editingFn.box}
              view={view}
              onCommit={(v) => commit(updateNode(draftRef.current, editingFn.node.id, { name: v }))}
              onDone={() => setEditing(null)}
            />
          )}
          {editingNote && (
            <RenameOverlay
              key={editingNote.id}
              name={editingNote.text}
              box={editingNote}
              view={view}
              allowEmpty
              placeholder="Текст примечания"
              onCommit={(v) => commit(updateNote(draftRef.current, editingNote.id, { text: v }))}
              onDone={() => setEditing(null)}
            />
          )}
          {editingFrame && (
            <RenameOverlay
              key={`frame-${editingFrame.field}`}
              name={editingFrame.text}
              box={{ x: editingFrame.x, y: editingFrame.y + 3, w: Math.max(editingFrame.w, 120), h: editingFrame.h - 6 }}
              view={view}
              allowEmpty
              placeholder="Пусто — вернуть автоматическую надпись"
              onCommit={(v) => commit(setFrame(draftRef.current, frameKey(cur), { text: { field: editingFrame.field, value: v } }))}
              onDone={() => setEditing(null)}
            />
          )}
          {editingArrow &&
            (() => {
              const lab = labelSpec(editingArrow);
              const cx = lab.anchor === "start" ? lab.x + 60 : lab.anchor === "end" ? lab.x - 60 : lab.x;
              return (
                <RenameOverlay
                  key={editingArrow.key}
                  name={editingArrow.label}
                  box={{ x: cx - 80, y: lab.y - 14, w: 160, h: 20 }}
                  view={view}
                  onCommit={(v) => {
                    commit(renameEntity(draftRef.current, editingArrow.kind === "control" ? "control" : editingArrow.kind === "system" ? "system" : editingArrow.kind === "role" ? "role" : "data", editingArrow.entityId, v));
                    showHint("Название общее для всех стрелок этой записи справочника");
                  }}
                  onDone={() => setEditing(null)}
                />
              );
            })()}
          {arrowSel && !editing && (
            <div className="bpe-selbar" role="toolbar" aria-label="Действия со стрелкой">
              <span className="muted">
                Стрелка «{arrowSel.label}»{arrowSel.manual ? " · маршрут вручную" : ""}
              </span>
              <button onClick={() => { const next = addBend(draftRef.current, arrowSel); if (next === draftRef.current) showHint("Отрезок слишком короткий для излома"); else commit(next); }} title="Добавить излом на самом длинном отрезке (или Ctrl + двойной щелчок по линии)">
                Добавить излом
              </button>
              <button disabled={!hasManualRoute(draft, arrowSel)} onClick={() => commit(resetArrow(draftRef.current, arrowSel))} title="Вернуть автоматическую прокладку">
                Сбросить маршрут
              </button>
              {DATA_KINDS.has(arrowSel.kind) && (
                <button
                  onClick={() => {
                    const control = CONTROL_KINDS.has(arrowSel.kind);
                    const r = setArrowIcom(draftRef.current, arrowSel, control ? "input" : "control");
                    if (r.error) return showHint(r.error);
                    h.commit(r.model);
                    const next = buildIdef0(r.model, cur).arrows.find((x) => x.nodeId === r.nodeId && x.entityId === r.entityId);
                    if (next) setSel(arrowSelOf(next));
                  }}
                  title="Тот же документ становится входом или управлением этой функции"
                >
                  {CONTROL_KINDS.has(arrowSel.kind) ? "Сделать входом" : "Сделать управлением"}
                </button>
              )}
            </div>
          )}
          {!arrowSel && (pickedIds.length > 0 || hasClipboard()) && (
            <div className="bpe-selbar" role="toolbar" aria-label="Действия с выделением">
              {pickedIds.length > 0 && <span className="muted">Выделено: {pickedIds.length}</span>}
              <button disabled={pickedIds.length === 0} onClick={copySelected} title="Копировать (Ctrl+C)">
                Копировать
              </button>
              <button disabled={!hasClipboard()} onClick={pasteClipboard} title="Вставить (Ctrl+V); блоки можно вставить на другой уровень">
                Вставить
              </button>
              <button disabled={pickedIds.length === 0} onClick={zoomToSelection} title="Показать выделенное крупно">
                Приблизить
              </button>
              {inGroup && (
                <>
                  <button onClick={() => commit(alignLeft(draft, cur, groupIds))} title="Выровнять по левому краю">
                    ⇤ Влево
                  </button>
                  <button onClick={() => commit(alignTop(draft, cur, groupIds))} title="Выровнять по верхнему краю">
                    ⇥ Вверх
                  </button>
                  <button disabled={groupIds.length < 3} onClick={() => commit(distributeHorizontally(draft, cur, groupIds))} title="Равные промежутки по горизонтали (нужно три блока)">
                    ⇹ Поровну
                  </button>
                  <button disabled={groupIds.length < 3} onClick={() => commit(distributeVertically(draft, cur, groupIds))} title="Равные промежутки по вертикали (нужно три блока)">
                    ⇳ Поровну
                  </button>
                </>
              )}
              <button disabled={pickedIds.length === 0} onClick={deleteSelected} title="Удалить выделенное (Delete)">
                Удалить
              </button>
            </div>
          )}
          {showMap && layout.functions.length > 0 && (
            <MiniMap
              nodes={layout.functions.map((f) => ({ id: f.node.id, box: f.box, type: "task", selected: pickedIds.includes(f.node.id) }))}
              world={{ w: worldW, h: worldH }}
              view={view}
              size={{ w: wrapRef.current?.clientWidth ?? 800, h: wrapRef.current?.clientHeight ?? 400 }}
              onCenter={(wx, wy) => centerOn({ x: wx, y: wy, w: 0, h: 0 })}
              stamp={frameOn ? frameGeo.footer : undefined}
            />
          )}
          <div className="bpe-corner muted">
            {layout.functions.length} функц. · {layout.arrows.length} стрелок · {Math.round(worldW)}×{Math.round(worldH)}
          </div>
        </div>
      </div>
    </div>
  );
}
