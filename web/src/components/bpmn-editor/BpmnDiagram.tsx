import { useMemo, useRef } from "react";
import type { ProcessLogicModel } from "../../types";
import { useViewport } from "../editor-core/hooks";
import { diagramLayout, isBoundary, modelExtents, positionsFromBpmnXml, withLayout } from "./geometry";
import { ArrowDefs, ArtifactShape, FlowShape, LanesLayer, MessageShape, NodeShape, PoolShape, TriggerMarkers } from "./shapes";

/**
 * Просмотр BPMN только для чтения: те же фигуры, что в редакторе, без сторонних библиотек.
 * Рисует по JSON-модели (позиции node.layout, иначе авто-раскладка редактора).
 */
export default function BpmnDiagram({
  model,
  selectedId,
  onSelect,
  height = 560,
  bpmnXml,
}: {
  model: ProcessLogicModel | null;
  selectedId?: string | null;
  onSelect?: (nodeId: string | null) => void;
  height?: number;
  /** Сгенерированный сервером BPMN — источник позиций фигур, которые не двигали вручную. */
  bpmnXml?: string | null;
}) {
  const laid = useMemo(() => (model ? withLayout(model, false, positionsFromBpmnXml(bpmnXml)) : null), [model, bpmnXml]);
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const panRef = useRef<{ sx: number; sy: number; tx: number; ty: number; moved: boolean; nodeId: string | null } | null>(null);

  // «вписать» при первом показе и при смене числа элементов, но не при каждом клике
  const fitKey = laid ? `${laid.nodes.length}:${laid.roles.length}` : "";
  const { view, setView, fit, zoomBy } = useViewport(svgRef, wrapRef, () => modelExtents(laid!), { active: !!laid, fitKey });

  if (!laid) return <p className="muted">Диаграмма BPMN ещё не сгенерирована.</p>;

  const { shown, boxes, extras, flows, markers, routes, bottomUsed } = diagramLayout(laid);
  const W = Math.max(modelExtents(laid).w, 1400);

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    // id фигуры запоминаем сразу: после setPointerCapture target у pointerup — сам svg
    const nodeId = (e.target as Element).closest("[data-node-id]")?.getAttribute("data-node-id") ?? null;
    panRef.current = { sx: e.clientX, sy: e.clientY, tx: view.tx, ty: view.ty, moved: false, nodeId };
    svgRef.current!.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const p = panRef.current;
    if (!p) return;
    if (!p.moved && Math.hypot(e.clientX - p.sx, e.clientY - p.sy) < 4) return;
    p.moved = true;
    setView((v) => ({ ...v, tx: p.tx + e.clientX - p.sx, ty: p.ty + e.clientY - p.sy }));
  };
  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    const p = panRef.current;
    panRef.current = null;
    if (svgRef.current?.hasPointerCapture(e.pointerId)) svgRef.current.releasePointerCapture(e.pointerId);
    // клик без перетаскивания: фигура — выбрать, пустое место — снять выбор
    if (p && !p.moved && onSelect) onSelect(p.nodeId);
  };

  return (
    <div className="bpe-canvas bpe-readonly" ref={wrapRef} style={{ height }}>
      <svg ref={svgRef} className="bpe-svg" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
        <ArrowDefs />
        <g transform={`translate(${view.tx} ${view.ty}) scale(${view.k})`}>
          <LanesLayer model={laid} width={W} />
          {flows.map((f) => {
            const points = routes.get(f.id);
            return points ? <FlowShape key={f.id} flow={f} points={points} selected={false} /> : null;
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
            <NodeShape key={n.id} node={n} box={boxes.get(n.id)!} selected={selectedId === n.id} hot={false} boundary={isBoundary(n, shown)} labelLeft={bottomUsed.has(n.id)} hasMarkers={markers.has(n.id)} />
          ))}
          {[...markers].map(([blockId, list]) => (boxes.has(blockId) ? <TriggerMarkers key={blockId} box={boxes.get(blockId)!} markers={list} selectedId={selectedId} /> : null))}
        </g>
      </svg>
      <div className="bpe-zoom">
        <button onClick={() => zoomBy(1 / 1.2)}>−</button>
        <button onClick={() => zoomBy(1.2)}>+</button>
        <button onClick={fit}>Вписать</button>
      </div>
    </div>
  );
}
