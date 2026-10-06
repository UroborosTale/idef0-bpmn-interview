import { useRef, useState } from "react";
import type { ProcessLogicModel, ValidationIssue } from "../../types";
import { handleCommonKeys, isTextInput, useBeforeUnload, useDraftPersistence, useHint, useModelHistory, useViewport, type Pt } from "../editor-core/hooks";
import { DraftBanner, RenameOverlay } from "../editor-core/fields";
import EditorToolbar from "../editor-core/EditorToolbar";
import { deleteNode, updateNode } from "../bpmn-editor/model-ops";
import { MIN_POS, ancestorsOf, buildIdef0, idef0Codes, idef0Extents, snap, withIdef0Layout } from "./geometry";
import { addFunction, linkFunctions, moveFunction, removeArrow } from "./ops";
import { ArrowShape, BlockShape, Idef0Defs } from "./shapes";
import Inspector, { type Sel } from "./Inspector";

type M = ProcessLogicModel;
type Zone = "input" | "control";
type Drag =
  | { kind: "pan"; sx: number; sy: number; tx: number; ty: number }
  | { kind: "fn"; id: string; offX: number; offY: number; startModel: M; moved: boolean; sx: number; sy: number }
  | { kind: "connect"; from: string };

/** Верхняя треть блока-цели при протягивании связи — управление, остальное — вход. */
const CONTROL_ZONE = 0.3;

export default function Idef0Editor({
  model,
  validation,
  busy,
  onSave,
  draftId,
  draftBase,
}: {
  model: M;
  validation: ValidationIssue[];
  busy: boolean;
  onSave: (m: M) => Promise<boolean>;
  /** Ключ черновика (сессия + редактор) и версия модели, на которой он основан. */
  draftId: string;
  draftBase: string;
}) {
  const h = useModelHistory<M>(() => withIdef0Layout(model));
  const { draft, draftRef, setDraft } = h;
  const persisted = useDraftPersistence<M>({ id: draftId, base: draftBase, draft, dirty: h.dirty, restore: (m) => h.setDraft(m) });
  const [parentId, setParentId] = useState<string | null>(null); // какая диаграмма открыта: null — A0
  const [sel, setSel] = useState<Sel>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [connectTo, setConnectTo] = useState<Pt | null>(null);
  const [connectHot, setConnectHot] = useState<{ id: string; zone: Zone } | null>(null);
  const { hint, showHint } = useHint();

  const rootRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<Drag | null>(null);

  // открытая диаграмма могла исчезнуть (удалили родителя, отменили правку) — тогда показываем A0
  const cur = parentId && draft.nodes.some((n) => n.id === parentId) ? parentId : null;
  const layout = buildIdef0(draft, cur);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const { view, setView, fit, toWorld, zoomBy } = useViewport(svgRef, wrapRef, () => idef0Extents(layoutRef.current), { fitKey: cur ?? "root" });
  useBeforeUnload(h.dirty);

  const codes = idef0Codes(draft);
  const blocks = new Map(layout.functions.map((f) => [f.node.id, f] as const));
  const curSel: Sel =
    sel && ((sel.kind === "fn" && blocks.has(sel.id)) || (sel.kind === "arrow" && layout.arrows.some((a) => a.key === sel.id))) ? sel : null;

  const commit = (next: M, nextSel?: Sel) => {
    if (h.commit(next) && nextSel !== undefined) setSel(nextSel);
  };
  const save = async () => {
    const snapshot = draftRef.current;
    if (await onSave(snapshot)) h.markSaved(snapshot);
  };

  const openDiagram = (id: string | null) => {
    setParentId(id);
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
    const connectEl = t.closest("[data-connect]");
    const fnEl = t.closest("[data-fn-id]");
    const arrowEl = t.closest("[data-arrow-key]");
    const onEmpty = !connectEl && !fnEl && !arrowEl;

    if (e.button === 1 || (e.button === 0 && onEmpty)) {
      e.preventDefault();
      if (e.button === 0) setSel(null);
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
      setSel({ kind: "fn", id });
      dragRef.current = { kind: "fn", id, offX: wx - f.box.x, offY: wy - f.box.y, startModel: draft, moved: false, sx: e.clientX, sy: e.clientY };
      svgRef.current!.setPointerCapture(e.pointerId);
    } else if (arrowEl) {
      setSel({ kind: "arrow", id: arrowEl.getAttribute("data-arrow-key")! });
    }
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const d = dragRef.current;
    if (!d) return;
    if (d.kind === "pan") {
      setView((v) => ({ ...v, tx: d.tx + e.clientX - d.sx, ty: d.ty + e.clientY - d.sy }));
    } else if (d.kind === "fn") {
      if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 4) return;
      d.moved = true;
      const [wx, wy] = toWorld(e.clientX, e.clientY);
      setDraft((m) => moveFunction(m, d.id, Math.max(MIN_POS, snap(wx - d.offX)), Math.max(MIN_POS, snap(wy - d.offY))));
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
    } else if (d.kind === "connect") {
      const target = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-fn-id]")?.getAttribute("data-fn-id");
      setConnectTo(null);
      setConnectHot(null);
      if (target && target !== d.from && blocks.has(target)) {
        const [, wy] = toWorld(e.clientX, e.clientY);
        const r = linkFunctions(draftRef.current, d.from, target, zoneAt(target, wy));
        if (r.error) showHint(r.error);
        else commit(r.model, { kind: "arrow", id: r.key! });
      }
    }
  };

  const onDoubleClick = (e: React.MouseEvent<SVGSVGElement>) => {
    const t = e.target as Element;
    const id = t.closest("[data-fn-id]")?.getAttribute("data-fn-id");
    if (t.closest("[data-open]")) return;
    if (id) setEditing(id);
    else if (!t.closest("[data-arrow-key]") && !t.closest("[data-connect]")) addAt(toWorld(e.clientX, e.clientY));
  };

  const addFromPalette = () => {
    const r = svgRef.current!.getBoundingClientRect();
    const [cx, cy] = toWorld(r.left + r.width / 2, r.top + r.height / 2);
    addAt([cx, cy]);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.getData("application/x-idef0-new")) addAt(toWorld(e.clientX, e.clientY));
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (isTextInput(e.target)) return;
    if (handleCommonKeys(e, { undo: h.undo, redo: h.redo, save: () => h.dirty && !busy && void save() })) return;
    if ((e.key === "Delete" || e.key === "Backspace") && curSel) {
      e.preventDefault();
      if (curSel.kind === "fn") commit(deleteNode(draft, curSel.id), null);
      else {
        const a = layout.arrows.find((x) => x.key === curSel.id);
        if (a) commit(removeArrow(draft, a), null);
      }
    } else if (e.key === "Escape") {
      setSel(null);
      setEditing(null);
    }
  };

  const selectedFn = curSel?.kind === "fn" ? blocks.get(curSel.id) : undefined;
  const editingFn = editing ? blocks.get(editing) : undefined;
  const { w: worldW, h: worldH } = idef0Extents(layout);
  const parentNode = cur ? draft.nodes.find((n) => n.id === cur) : undefined;
  const crumbs: { id: string | null; label: string }[] = [
    { id: null, label: "A0" },
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
        dirty={h.dirty}
        busy={busy}
        hint={hint}
        onSave={() => void save()}
        extra={
          <>
            <button onClick={() => commit(withIdef0Layout(draft, true, cur))} title="Расставить блоки этой диаграммы по диагонали (можно отменить)">
              По диагонали
            </button>
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
              <text x={16} y={24} fontSize={14} fontWeight="bold" fontFamily="Arial, sans-serif" fill="#1f2937" pointerEvents="none">
                {cur ? `${codes.get(cur) ?? ""} — ${parentNode?.name ?? ""}` : `A0 — ${draft.process.name}`}
              </text>
              {layout.functions.length === 0 && (
                <text x={16} y={60} fontSize={13} fontFamily="Arial, sans-serif" fill="#64748b" pointerEvents="none">
                  Диаграмма пуста: добавьте функцию — двойным щелчком или из палитры слева.
                </text>
              )}
              {layout.arrows.map((a) => (
                <ArrowShape key={a.key} arrow={a} selected={curSel?.kind === "arrow" && curSel.id === a.key} />
              ))}
              {layout.functions.map((f) => (
                <BlockShape key={f.node.id} fn={f} selected={curSel?.kind === "fn" && curSel.id === f.node.id} hot={connectHot?.id === f.node.id} />
              ))}

              {connectHot && blocks.get(connectHot.id) && (
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

              {selectedFn && !editing && (
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
          <div className="bpe-corner muted">
            {layout.functions.length} функц. · {layout.arrows.length} стрелок · {Math.round(worldW)}×{Math.round(worldH)}
          </div>
        </div>

        <div className="bpe-inspector">
          <Inspector
            model={draft}
            sel={curSel}
            arrows={layout.arrows}
            codes={codes}
            validation={validation}
            onChange={commit}
            onSelect={(s) => (s?.kind === "fn" ? selectFn(s.id) : setSel(s))}
            onOpen={openDiagram}
          />
        </div>
      </div>
    </div>
  );
}
