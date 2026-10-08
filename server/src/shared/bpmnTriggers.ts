/**
 * Триггеры блока действия. Ожидающее событие (сообщение, таймер, условие, сигнал), которое ведёт прямо в задачу или
 * подпроцесс, на диаграмме не рисуется отдельной фигурой: оно прикреплено к блоку значком, а стрелки «событие → блок» нет.
 * Это только вид диаграммы: в модели и в BPMN-файле остаются настоящее событие и настоящие стрелки (так файл остаётся
 * валидным BPMN), а редактор, выгрузка в Visio и раскладка работают с «свёрнутым» видом.
 *
 * Событие сворачивается в блок, когда оно:
 *  • начальное или промежуточное, ждёт (не выбрасывает) и имеет триггер: сообщение, таймер, условие, сигнал, «несколько»;
 *  • не граничное (граничное остаётся на границе задачи и ведёт ветку исключения);
 *  • ведёт ровно одной стрелкой в задачу или подпроцесс (не в шлюз и не в другое событие);
 *  • имеет не больше одной входящей стрелки (начало — ни одной), и источник входящей не сворачивается сам.
 * Входящая стрелка «X → событие» на диаграмме становится стрелкой «X → блок» (это та же стрелка модели: её id и условие).
 */

import { eventSpec, type EventSpec, type TriggerType } from "./events.js";
import { isBoundaryNode } from "./bpmnArtifacts.js";

/** Триггеры, которые рисуются значком на блоке. */
export const MARKER_TRIGGERS = new Set<TriggerType>(["message", "timer", "conditional", "signal", "multiple", "parallel_multiple"]);

interface NodeLike {
  id: string;
  type: string;
  subtype?: string | null;
  trigger?: unknown;
  attached_to?: string | null;
  name: string;
  inputs?: string[];
  outputs?: string[];
  system_ids?: string[];
}
interface FlowLike {
  id: string;
  from: string;
  to: string;
  condition?: string | null;
}

export interface TriggerMarker {
  /** Событие модели, которое рисуется значком. */
  eventId: string;
  /** Блок, к которому прикреплён значок. */
  blockId: string;
  name: string;
  spec: EventSpec;
  /** Начальное событие (одинарное кольцо) или промежуточное (двойное). */
  start: boolean;
}

export interface TriggerView<F extends FlowLike> {
  /** События, свёрнутые в значки. */
  hidden: Set<string>;
  /** Значки по блокам, в порядке событий в модели. */
  markers: Map<string, TriggerMarker[]>;
  /** Стрелки диаграммы: без стрелок «событие → блок»; «X → событие» стала «X → блок» (viaEvent — свёрнутое событие). */
  flows: (F & { viaEvent?: string })[];
  /** Для свёрнутого события: его входящая и исходящая стрелки модели. */
  links: Map<string, { incoming?: F; outgoing: F }>;
}

export function collapseTriggers<N extends NodeLike, F extends FlowLike>(nodes: N[], flows: F[]): TriggerView<F> {
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const outs = new Map<string, F[]>();
  const ins = new Map<string, F[]>();
  for (const f of flows) {
    outs.set(f.from, [...(outs.get(f.from) ?? []), f]);
    ins.set(f.to, [...(ins.get(f.to) ?? []), f]);
  }

  const candidates = new Map<string, { spec: EventSpec; incoming?: F; outgoing: F }>();
  for (const n of nodes) {
    if (n.type !== "event" || isBoundaryNode(n as never, nodes as never)) continue;
    const spec = eventSpec(n as never, false);
    if (spec.position === "end" || spec.throwing || !MARKER_TRIGGERS.has(spec.trigger)) continue;
    const out = outs.get(n.id) ?? [];
    const into = ins.get(n.id) ?? [];
    if (out.length !== 1 || into.length > 1) continue;
    const target = byId.get(out[0].to);
    if (!target || (target.type !== "task" && target.type !== "subprocess")) continue;
    if (into.length === 1 && !byId.has(into[0].from)) continue;
    candidates.set(n.id, { spec, incoming: into[0], outgoing: out[0] });
  }
  // цепочка событий подряд: второе остаётся событием, иначе стрелка «событие → блок» потеряла бы источник
  for (const [id, c] of [...candidates]) if (c.incoming && candidates.has(c.incoming.from)) candidates.delete(id);

  const hidden = new Set(candidates.keys());
  const markers = new Map<string, TriggerMarker[]>();
  for (const n of nodes) {
    const c = candidates.get(n.id);
    if (!c) continue;
    const blockId = c.outgoing.to;
    markers.set(blockId, [...(markers.get(blockId) ?? []), { eventId: n.id, blockId, name: n.name, spec: c.spec, start: c.spec.position === "start" }]);
  }

  const shown: (F & { viaEvent?: string })[] = [];
  for (const f of flows) {
    if (hidden.has(f.from)) continue; // «событие → блок» не рисуется
    if (hidden.has(f.to)) shown.push({ ...f, to: candidates.get(f.to)!.outgoing.to, viaEvent: f.to });
    else shown.push(f);
  }
  const links = new Map([...candidates].map(([id, c]) => [id, { incoming: c.incoming, outgoing: c.outgoing }] as const));
  return { hidden, markers, flows: shown, links };
}

/** Положение значков на блоке: у левого края сверху, затем вдоль верхней границы (центры значков). */
export function markerCenters(box: { x: number; y: number; w: number; h: number }, count: number): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < count; i++) out.push(i === 0 ? [box.x, box.y + 16] : [box.x + 18 + (i - 1) * 25, box.y]);
  return out;
}
export const MARKER_R = 11;
