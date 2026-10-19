import { TUNNEL_KINDS, arrowRouteKey, type ArrowKind } from "@shared/idef0Layout";
import type { ProcessLogicModel } from "../../types";

type M = ProcessLogicModel;

/**
 * Туннели внешних стрелок IDEF0 (скобки у конца стрелки): up — у свободного конца, на диаграмме выше стрелки нет; down — у блока,
 * в декомпозиции функции стрелки нет. Хранятся у функции по ключу «вид:сущность». Туннелированная стрелка не считается
 * нарушением баланса декомпозиции. Туннелируются только входы, выходы, управление и управление-данные.
 */
export type TunnelEnd = "up" | "down";
/** Вид помеченного конца стрелки: «none» — конец прикреплён, «tunnel» — скобки туннеля, «boundary» — штрих «Граница»,
 *  «offpage» — ссылка на диаграмму: значок страницы у конца (В11, стрелка показана на другой диаграмме). */
export type ArrowMark = "none" | "tunnel" | "boundary" | "offpage";

export const canTunnel = (kind: ArrowKind): boolean => TUNNEL_KINDS.has(kind);

export function tunnelOf(m: M, a: { nodeId: string; kind: ArrowKind; entityId: string }): { up: boolean; down: boolean } {
  const t = m.nodes.find((n) => n.id === a.nodeId)?.tunnels?.[arrowRouteKey(a.kind, a.entityId)];
  return { up: !!t?.up, down: !!t?.down };
}

/** Что стоит на конце стрелки: прикреплён / скобки туннеля / штрих «Граница» / значок «ссылка на диаграмму». */
export function markOf(m: M, a: { nodeId: string; kind: ArrowKind; entityId: string }, end: TunnelEnd): ArrowMark {
  const t = m.nodes.find((n) => n.id === a.nodeId)?.tunnels?.[arrowRouteKey(a.kind, a.entityId)];
  const kind = end === "up" ? t?.upKind : t?.downKind;
  if (kind === "boundary" || kind === "offpage") return kind;
  return (end === "up" ? t?.up : t?.down) ? "tunnel" : "none";
}

export function setArrowMark(m: M, a: { nodeId: string; kind: ArrowKind; entityId: string }, end: TunnelEnd, mark: ArrowMark): M {
  if (!canTunnel(a.kind)) return m;
  const kindField = end === "up" ? "upKind" : "downKind";
  return {
    ...m,
    nodes: m.nodes.map((n) => {
      if (n.id !== a.nodeId) return n;
      const tunnels = { ...(n.tunnels ?? {}) };
      const next: Record<string, boolean | string> = { ...(tunnels[arrowRouteKey(a.kind, a.entityId)] ?? {}) };
      if (mark === "none") {
        delete next[end];
        delete next[kindField];
      } else if (mark === "tunnel") {
        next[end] = true;
        delete next[kindField];
      } else {
        delete next[end];
        next[kindField] = mark; // «boundary» или «offpage»
      }
      if (Object.keys(next).length === 0) delete tunnels[arrowRouteKey(a.kind, a.entityId)];
      else tunnels[arrowRouteKey(a.kind, a.entityId)] = next as { up?: boolean; down?: boolean };
      const { tunnels: _old, ...rest } = n;
      return Object.keys(tunnels).length === 0 ? (rest as typeof n) : { ...rest, tunnels };
    }),
  };
}
