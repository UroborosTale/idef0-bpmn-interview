import { TUNNEL_KINDS, arrowRouteKey, type ArrowKind } from "@shared/idef0Layout";
import type { ProcessLogicModel } from "../../types";

type M = ProcessLogicModel;

/**
 * Туннели внешних стрелок IDEF0 (скобки у конца стрелки): up — у свободного конца, на диаграмме выше стрелки нет; down — у блока,
 * в декомпозиции функции стрелки нет. Хранятся у функции по ключу «вид:сущность». Туннелированная стрелка не считается
 * нарушением баланса декомпозиции. Туннелируются только входы, выходы, управление и управление-данные.
 */
export type TunnelEnd = "up" | "down";

export const canTunnel = (kind: ArrowKind): boolean => TUNNEL_KINDS.has(kind);

export function tunnelOf(m: M, a: { nodeId: string; kind: ArrowKind; entityId: string }): { up: boolean; down: boolean } {
  const t = m.nodes.find((n) => n.id === a.nodeId)?.tunnels?.[arrowRouteKey(a.kind, a.entityId)];
  return { up: !!t?.up, down: !!t?.down };
}

export function setArrowTunnel(m: M, a: { nodeId: string; kind: ArrowKind; entityId: string }, end: TunnelEnd, on: boolean): M {
  if (!canTunnel(a.kind)) return m;
  const key = arrowRouteKey(a.kind, a.entityId);
  return {
    ...m,
    nodes: m.nodes.map((n) => {
      if (n.id !== a.nodeId) return n;
      const tunnels = { ...(n.tunnels ?? {}) };
      const next = { ...(tunnels[key] ?? {}) };
      if (on) next[end] = true;
      else delete next[end];
      if (Object.keys(next).length === 0) delete tunnels[key];
      else tunnels[key] = next;
      const { tunnels: _old, ...rest } = n;
      return Object.keys(tunnels).length === 0 ? (rest as typeof n) : { ...rest, tunnels };
    }),
  };
}
