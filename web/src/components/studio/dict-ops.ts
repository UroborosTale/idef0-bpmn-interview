import type { ProcessLogicModel, ProcessNode } from "../../types";
import { addRole, deleteRole, nextId, renameRole, setNodeRole } from "../bpmn-editor/model-ops";
import type { DictKind } from "./docs";

type M = ProcessLogicModel;

export interface UsageItem {
  nodeId: string;
  nodeName: string;
  /** Как элемент справочника используется: «исполнитель», «вход», «выход», «управление», «механизм». */
  how: string;
}

/** Значения поля «Вид» у справочников, где оно есть. */
export const KIND_OPTIONS: Partial<Record<DictKind, [string, string][]>> = {
  roles: [["internal", "внутренний"], ["external", "внешний"]],
  data: [["document", "документ"], ["data", "данные"]],
  controls: [["regulation", "регламент"], ["rule", "правило"], ["norm", "норма"]],
};

/** Название вида записи в единственном числе — заголовок карточки. */
export const ENTRY_TITLES: Record<DictKind, string> = {
  roles: "Исполнитель",
  systems: "Информационная система",
  data: "Документ / данные",
  controls: "Регламент / норма",
  kpi: "Показатель (KPI)",
  risks: "Риск",
};

export const LEVEL_OPTIONS: [string, string][] = [["low", "низкий"], ["medium", "средний"], ["high", "высокий"]];

const isFn = (n: ProcessNode) => n.type === "task" || n.type === "subprocess";
const items = (m: M, kind: DictKind): { id: string; name: string }[] =>
  kind === "roles" ? m.roles : kind === "systems" ? m.systems : kind === "data" ? m.data : kind === "controls" ? m.controls : kind === "kpi" ? m.process.kpi : m.process.risks;

export const entriesOf = items;

/** Запись справочника по id. */
export const entryOf = (m: M, kind: DictKind, id: string) => items(m, kind).find((e) => e.id === id);

/** Где используется запись справочника (по шагам и функциям модели). KPI и риски относятся ко всему процессу. */
export function usageOf(m: M, kind: DictKind, id: string): UsageItem[] {
  const out: UsageItem[] = [];
  for (const n of m.nodes) {
    const add = (how: string) => out.push({ nodeId: n.id, nodeName: n.name, how });
    if (kind === "roles" && n.role_id === id) add("исполнитель");
    if (kind === "systems" && n.system_ids.includes(id)) add("механизм");
    if (kind === "data") {
      if (n.inputs.includes(id)) add("вход");
      if (n.outputs.includes(id)) add("выход");
      if ((n.control_data_ids ?? []).includes(id)) add("управление");
    }
    if (kind === "controls" && n.controls.includes(id)) add("управление");
  }
  return out;
}

export function addEntry(m: M, kind: DictKind, name: string): { model: M; id: string } {
  switch (kind) {
    case "roles": {
      const r = addRole(m);
      return { model: renameRole(r.model, r.id!, name), id: r.id! };
    }
    case "systems": {
      const id = nextId("sys", m.systems.map((s) => s.id));
      return { model: { ...m, systems: [...m.systems, { id, name, source: [] }] }, id };
    }
    case "data": {
      const id = nextId("data", m.data.map((d) => d.id));
      return { model: { ...m, data: [...m.data, { id, name, kind: "document", source: [] }] }, id };
    }
    case "controls": {
      const id = nextId("ctl", m.controls.map((c) => c.id));
      return { model: { ...m, controls: [...m.controls, { id, name, kind: "rule", source: [] }] }, id };
    }
    case "kpi": {
      const id = nextId("kpi", m.process.kpi.map((k) => k.id));
      return { model: { ...m, process: { ...m.process, kpi: [...m.process.kpi, { id, name, target: null, unit: null, source: [] }] } }, id };
    }
    case "risks": {
      const id = nextId("risk", m.process.risks.map((r) => r.id));
      return { model: { ...m, process: { ...m.process, risks: [...m.process.risks, { id, name, mitigation: null, source: [] }] } }, id };
    }
  }
}

/** Изменить поля записи справочника (название, вид, целевое значение…). Название роли меняет подпись дорожки. */
export function updateEntry(m: M, kind: DictKind, id: string, patch: Record<string, unknown>): M {
  const upd = <T extends { id: string }>(xs: T[]) => xs.map((x) => (x.id === id ? { ...x, ...patch } : x));
  switch (kind) {
    case "roles": {
      let next = m;
      if (typeof patch.name === "string") next = renameRole(next, id, patch.name);
      const { name: _name, ...rest } = patch;
      return Object.keys(rest).length ? { ...next, roles: upd(next.roles) } : next;
    }
    case "systems":
      return { ...m, systems: upd(m.systems) };
    case "data":
      return { ...m, data: upd(m.data) };
    case "controls":
      return { ...m, controls: upd(m.controls) };
    case "kpi":
      return { ...m, process: { ...m.process, kpi: upd(m.process.kpi) } };
    case "risks":
      return { ...m, process: { ...m.process, risks: upd(m.process.risks) } };
  }
}

/** Удалить запись вместе со ссылками на неё: шаги остаются, но теряют исполнителя, систему, документ или регламент. */
export function removeEntry(m: M, kind: DictKind, id: string): M {
  const without = (xs: string[] | undefined) => (xs ? xs.filter((x) => x !== id) : xs);
  switch (kind) {
    case "roles": {
      // шаги уходят в дорожку «Без исполнителя» (с переносом фигур), затем удаляется сама дорожка
      let next = m;
      for (const n of m.nodes) if (n.role_id === id) next = setNodeRole(next, n.id, null);
      next = deleteRole(next, id).model;
      // респондент мультиинтервью остаётся, но без ссылки на удалённую роль
      return next.respondents.some((r) => r.role_id === id) ? { ...next, respondents: next.respondents.map((r) => (r.role_id === id ? { ...r, role_id: null } : r)) } : next;
    }
    case "systems":
      return { ...m, systems: m.systems.filter((s) => s.id !== id), nodes: m.nodes.map((n) => (n.system_ids.includes(id) ? { ...n, system_ids: n.system_ids.filter((x) => x !== id) } : n)) };
    case "data":
      return {
        ...m,
        data: m.data.filter((d) => d.id !== id),
        interfaces: m.interfaces.filter((i) => i.data_id !== id),
        nodes: m.nodes.map((n) => ({ ...n, inputs: without(n.inputs)!, outputs: without(n.outputs)!, control_data_ids: without(n.control_data_ids) })),
      };
    case "controls":
      return { ...m, controls: m.controls.filter((c) => c.id !== id), nodes: m.nodes.map((n) => (n.controls.includes(id) ? { ...n, controls: n.controls.filter((x) => x !== id) } : n)) };
    case "kpi":
      return { ...m, process: { ...m.process, kpi: m.process.kpi.filter((k) => k.id !== id) } };
    case "risks":
      return { ...m, process: { ...m.process, risks: m.process.risks.filter((r) => r.id !== id) } };
  }
}

/** Количество функций, у которых не заполнена связь со справочником, — для подсказки в заголовке окна. */
export function unlinkedCount(m: M, kind: DictKind): number {
  const fns = m.nodes.filter(isFn);
  switch (kind) {
    case "roles":
      return fns.filter((n) => !n.role_id).length;
    case "systems":
      return fns.filter((n) => n.system_ids.length === 0).length;
    default:
      return 0;
  }
}
