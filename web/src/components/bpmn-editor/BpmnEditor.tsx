import { useEffect, useMemo, useRef, useState } from "react";
import { mergeScope, scopeView } from "@shared/scope";
import type { ProcessLogicModel } from "../../types";
import { handleCommonKeys, isTextInput, useBeforeUnload, useDraftPersistence, useHint, useModelHistory, useViewport, type Pt } from "../editor-core/hooks";
import { DraftBanner, RenameOverlay } from "../editor-core/fields";
import EditorToolbar from "../editor-core/EditorToolbar";
import { MIN_X, boxMap, boxOf, diagramExtras, isBoundary, laneIndexAtY, modelExtents, positionsFromBpmnXml, snap, visibleNodes, withLayout } from "./geometry";
import { PALETTE, addBoundaryEvent, addFlow, addNodeAt, addRole, addScopeLane, deleteFlow, deleteNode, dropNodeIntoLane, duplicateNode, moveNode, updateNode, type NewNodeSpec } from "./model-ops";
import { ArrowDefs, ArtifactShape, FlowShape, LanesLayer, MessageShape, NodeShape, PoolShape, UNASSIGNED_LANE } from "./shapes";
import type { Selection } from "../studio/selection";

type M = ProcessLogicModel;
type Sel = { kind: "node" | "flow" | "lane"; id: string } | null;
type Drag =
  | { kind: "pan"; sx: number; sy: number; tx: number; ty: number }
  | { kind: "node"; id: string; offX: number; offY: number; startModel: M; moved: boolean; sx: number; sy: number }
  | { kind: "connect"; from: string };

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

    if (e.button === 1 || (e.button === 0 && onEmpty)) {
      e.preventDefault();
      if (e.button === 0) pick(null);
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
      pick({ kind: "node", id: artifactEl.getAttribute("data-artifact")! });
    } else if (flowEl) {
      pick({ kind: "flow", id: flowEl.getAttribute("data-flow-id")! });
    } else if (laneEl) {
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
      setDraft((m) => moveNode(m, d.id, Math.max(MIN_X, snap(wx - d.offX)), snap(wy - d.offY)));
      setHotLane(laneIndexAtY(viewRef.current, wy));
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

  // --- клавиатура ---

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (isTextInput(e.target)) return;
    if (handleCommonKeys(e, { undo: h.undo, redo: h.redo, save: () => h.dirty && !busy && void save() })) return;
    if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === "d" || e.code === "KeyD") && curSel?.kind === "node") {
      e.preventDefault(); // иначе браузер добавит страницу в закладки
      const r = duplicateNode(draft, curSel.id);
      if (!r.error) commit(r.model, { kind: "node", id: r.id! });
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
    } else if ((e.key === "Delete" || e.key === "Backspace") && curSel) {
      e.preventDefault();
      if (curSel.kind === "node") commit(deleteNode(draft, curSel.id), null);
      else if (curSel.kind === "flow") commit(deleteFlow(draft, curSel.id), null);
    } else if (e.key === "Escape") {
      setSel(null);
      setEditing(null);
    }
  };

  // --- отрисовка ---

  const { w: worldW, h: worldH } = modelExtents(draft);
  const W = Math.max(worldW, 1400);
  const shown = visibleNodes(draft);
  const boxes = boxMap(shown);
  const extras = diagramExtras(draft, shown, boxes);
  const selectedNode = curSel?.kind === "node" ? draft.nodes.find((n) => n.id === curSel.id) : undefined;
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
          <button onClick={() => commit(withLayout(draft, true))} title="Расставить все фигуры заново (можно отменить)">
            Авто-раскладка
          </button>
        }
      />

      <div className="bpe-body">
        <div className="bpe-palette">
          <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>
            Перетащите на холст или нажмите
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
                const a = boxes.get(f.from);
                const b = boxes.get(f.to);
                if (!a || !b) return null;
                const others = shown.filter((n) => n.id !== f.from && n.id !== f.to).map((n) => boxes.get(n.id)!);
                return <FlowShape key={f.id} flow={f} from={a} to={b} obstacles={others} selected={curSel?.kind === "flow" && curSel.id === f.id} />;
              })}

              {extras.messages.map(({ message, points }) => (
                <MessageShape key={message.id} points={points} label={message.name} />
              ))}
              {extras.pools.map(({ pool, box }) => (
                <PoolShape key={pool.id} pool={pool} box={box} />
              ))}
              {extras.artifacts.map((a) => (
                <ArtifactShape key={a.key} artifact={a} />
              ))}

              {shown.map((n) => (
                <NodeShape key={n.id} node={n} box={boxes.get(n.id)!} selected={curSel?.kind === "node" && curSel.id === n.id} hot={connectHot === n.id} boundary={isBoundary(n, shown)} />
              ))}

              {selectedNode && !(selectedNode.type === "event" && selectedNode.subtype === "end") && !editing && (
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
          <div className="bpe-corner muted">
            {shown.length} элем. · {draft.flows.length} связей · {Math.round(worldH)}px
          </div>
        </div>
      </div>
    </div>
  );
}
