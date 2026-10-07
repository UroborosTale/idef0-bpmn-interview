import { useState } from "react";
import type { ProcessLogicModel, ProcessNode } from "../../types";
import { functionsOf, idef0Codes } from "../idef0-editor/geometry";
import { bpmnHosts, processCodeOf } from "@shared/codes";
import { entriesOf } from "./dict-ops";
import { DICT_TITLES, REPORT_TITLES, type DictKind, type ReportKind, type StudioDoc, bpmnDoc, dictDoc, idef0Doc, reportDoc } from "./docs";

/**
 * Навигатор окна студии (как в Business Studio): дерево процессов с декомпозицией, диаграммы,
 * справочники и отчёты. Клик по функции открывает её диаграмму и выделяет блок; двойной щелчок
 * по функции с декомпозицией — открывает её дочернюю диаграмму.
 */
export default function Navigator({
  model,
  activeKey,
  selectedId,
  onOpenDoc,
  onSelectFn,
  onAddFunction,
  onOpenEntry,
}: {
  model: ProcessLogicModel;
  activeKey: string;
  selectedId: string | null;
  onOpenDoc: (doc: StudioDoc) => void;
  onSelectFn: (id: string) => void;
  onAddFunction: (parentId: string | null) => void;
  /** Открыть справочник с карточкой записи (из результатов поиска). */
  onOpenEntry?: (dict: DictKind, id: string) => void;
}) {
  const codes = idef0Codes(model);
  const hosts = new Set(bpmnHosts(model).map((n) => n.id)); // функции, у которых есть своя диаграмма BPMN
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [closedSections, setClosedSections] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setCollapsed((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const toggleSection = (id: string) =>
    setClosedSections((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const renderFn = (n: ProcessNode, depth: number, seen: Set<string>): React.ReactNode => {
    if (seen.has(n.id)) return null; // защита от циклов в idef0_parent
    const kids = functionsOf(model, n.id);
    const open = !collapsed.has(n.id);
    const nextSeen = new Set(seen).add(n.id);
    return (
      <div key={n.id}>
        <div
          className={`nav-row ${selectedId === n.id ? "selected" : ""}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          data-nav-fn={n.id}
          onClick={() => onSelectFn(n.id)}
          onDoubleClick={() => kids.length > 0 && onOpenDoc(idef0Doc(n.id))}
          title={kids.length > 0 ? "Двойной щелчок — открыть декомпозицию" : n.name}
        >
          <span
            className="nav-twisty"
            onClick={(e) => {
              e.stopPropagation();
              if (kids.length) toggle(n.id);
            }}
          >
            {kids.length ? (open ? "▾" : "▸") : ""}
          </span>
          <span className="nav-code">{codes.get(n.id)}</span>
          <span className="nav-name">{n.name}</span>
          {kids.length > 0 && <span className="nav-badge">⊞</span>}
          {hosts.has(n.id) && (
            <span
              className={`nav-bpmn ${model.nodes.some((s) => s.bpmn_scope === n.id) ? "on" : ""} ${activeKey === `bpmn:${n.id}` ? "active" : ""}`}
              title="Диаграмма BPMN операции"
              data-nav-bpmn={n.id}
              onClick={(e) => {
                e.stopPropagation();
                onOpenDoc(bpmnDoc(n.id));
              }}
            >
              ⬡
            </span>
          )}
        </div>
        {open && kids.map((k) => renderFn(k, depth + 1, nextSeen))}
      </div>
    );
  };

  const top = functionsOf(model, null);
  const section = (id: string, title: string, body: React.ReactNode, action?: React.ReactNode) => (
    <div className="nav-section">
      <div className="nav-section-head" onClick={() => toggleSection(id)}>
        <span>{closedSections.has(id) ? "▸" : "▾"}</span> {title}
        <span className="spacer" />
        {action}
      </div>
      {!closedSections.has(id) && body}
    </div>
  );
  const link = (doc: StudioDoc, label: string, count?: number) => (
    <div key={doc.key} className={`nav-row ${activeKey === doc.key ? "active-doc" : ""}`} style={{ paddingLeft: 22 }} onClick={() => onOpenDoc(doc)}>
      <span className="nav-name">{label}</span>
      {count !== undefined && <span className="nav-count">{count}</span>}
    </div>
  );

  const dictCounts: Record<DictKind, number> = {
    roles: model.roles.length,
    systems: model.systems.length,
    data: model.data.length,
    controls: model.controls.length,
    kpi: model.process.kpi.length,
    risks: model.process.risks.length,
  };

  // поиск по функциям (название и код) и по записям всех справочников
  const q = query.trim().toLowerCase();
  const fnHits = q ? [...codes.entries()].flatMap(([id, code]) => { const n = model.nodes.find((x) => x.id === id); return n && (n.name.toLowerCase().includes(q) || code.toLowerCase() === q) ? [{ n, code }] : []; }) : [];
  const entryHits = q ? (Object.keys(DICT_TITLES) as DictKind[]).flatMap((k) => entriesOf(model, k).filter((e) => e.name.toLowerCase().includes(q)).map((e) => ({ k, e }))) : [];

  return (
    <div className="nav">
      <div className="nav-search">
        <input type="search" placeholder="Найти функцию или запись…" aria-label="Поиск в навигаторе" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setQuery("")} />
      </div>
      {q ? (
        <div className="nav-results">
          {fnHits.length + entryHits.length === 0 && <div className="muted nav-empty">Ничего не найдено</div>}
          {fnHits.map(({ n, code }) => (
            <div key={n.id} className="nav-row" data-nav-hit={n.id} onClick={() => onSelectFn(n.id)} title="Функция">
              <span className="nav-code">{code}</span>
              <span className="nav-name">{n.name}</span>
            </div>
          ))}
          {entryHits.map(({ k, e }) => (
            <div key={`${k}:${e.id}`} className="nav-row" data-nav-hit={`${k}:${e.id}`} onClick={() => onOpenEntry?.(k, e.id)} title={DICT_TITLES[k]}>
              <span className="nav-name">{e.name}</span>
              <span className="nav-count">{DICT_TITLES[k]}</span>
            </div>
          ))}
        </div>
      ) : (
        <>
      {section(
        "processes",
        "Процессы",
        <>
          <div className={`nav-row ${activeKey === "bpmn" ? "active-doc" : ""}`} style={{ paddingLeft: 8 }} onClick={() => onOpenDoc(bpmnDoc())} title="Диаграмма процесса BPMN">
            <span className="nav-twisty" />
            <span className="nav-code">⬡</span>
            <span className="nav-name">{model.process.name}</span>
          </div>
          <div className={`nav-row ${activeKey === "idef0:root" ? "active-doc" : ""}`} style={{ paddingLeft: 22 }} onClick={() => onOpenDoc(idef0Doc(null))} title="Диаграмма IDEF0 верхнего уровня">
            <span className="nav-twisty" />
            <span className="nav-code">{processCodeOf(model)}</span>
            <span className="nav-name">Декомпозиция процесса</span>
          </div>
          {top.map((n) => renderFn(n, 2, new Set()))}
          {top.length === 0 && <div className="muted nav-empty">Функций пока нет</div>}
        </>,
        <button className="nav-mini" title="Добавить функцию на диаграмму A0" onClick={(e) => { e.stopPropagation(); onAddFunction(null); }}>+</button>
      )}
      {section(
        "dicts",
        "Справочники",
        (Object.keys(DICT_TITLES) as DictKind[]).map((k) => link(dictDoc(k), DICT_TITLES[k], dictCounts[k]))
      )}
      {section(
        "reports",
        "Отчёты",
        (Object.keys(REPORT_TITLES) as ReportKind[]).map((k) => link(reportDoc(k), REPORT_TITLES[k]))
      )}
        </>
      )}
    </div>
  );
}
