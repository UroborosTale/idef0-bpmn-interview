import { useEffect, useRef, useState } from "react";
import type { ProcessLogicModel, ProcessNode } from "../../types";
import { functionsOf, idef0Codes } from "../idef0-editor/geometry";
import { blockNumbers, bpmnHosts, functionDepth, isStructured, processCodeOf } from "@shared/codes";
import NavIcon from "./NavIcon";
import { entriesOf } from "./dict-ops";
import { moveProblem, previewMove, shiftFunction, type MoveTarget } from "./structure-ops";
import { DICT_TITLES, REPORT_TITLES, type DictKind, type ReportKind, type StudioDoc, bpmnDoc, dictDoc, idef0Doc, reportDoc } from "./docs";

/**
 * Навигатор окна студии (как в Business Studio 6): дерево процессов, справочники и отчёты.
 *
 * Модель с кодом процесса — иерархия по кодам Соглашения: группа → процесс B002.00.00 → подпроцессы B002.01.00 → операции
 * B002.01.01 → диаграмма BPMN операции (тот же код). Уровни и подписи — сами коды, без номеров блоков.
 * Модель без кода — прежняя схема с номерами блоков: процесс → диаграмма A0 → A1 → A1.1 → диаграмма BPMN, плюс общая схема.
 *
 * Клик по функции открывает её диаграмму и выделяет блок; двойной щелчок по функции с декомпозицией — её дочернюю диаграмму;
 * строка диаграммы BPMN открывает диаграмму операции; строка процесса в модели с кодом открывает IDEF0 процесса.
 *
 * Структуру можно править: функции перетаскиваются (между равными — порядок, на подпроцесс — перенос операции; новые коды видны
 * при наведении), у строк есть контекстное меню (добавить операцию, заготовка диаграммы, вверх/вниз, дублировать, удалить).
 */
export default function Navigator({
  model,
  activeKey,
  selectedId,
  onOpenDoc,
  onSelectFn,
  onAddFunction,
  onOpenEntry,
  onMoveFunction,
  onFunctionAction,
  onWizard,
}: {
  model: ProcessLogicModel;
  activeKey: string;
  selectedId: string | null;
  onOpenDoc: (doc: StudioDoc) => void;
  onSelectFn: (id: string) => void;
  onAddFunction: (parentId: string | null) => void;
  /** Открыть справочник с карточкой записи (из результатов поиска). */
  onOpenEntry?: (dict: DictKind, id: string) => void;
  /** Перенести функцию (перетаскиванием или кнопками «вверх/вниз»); без обработчика перетаскивание отключено. */
  onMoveFunction?: (id: string, target: MoveTarget) => void;
  /** Действие из контекстного меню функции. */
  onFunctionAction?: (action: "add-child" | "skeleton" | "duplicate" | "delete", id: string) => void;
  /** Открыть мастер структуры. */
  onWizard?: () => void;
}) {
  const codes = idef0Codes(model);
  const nums = blockNumbers(model);
  const structured = isStructured(model);
  const hosts = new Set(bpmnHosts(model).map((n) => n.id)); // функции, у которых есть своя диаграмма BPMN
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [closedSections, setClosedSections] = useState<Set<string>>(new Set());
  // перетаскивание и контекстное меню
  const dragId = useRef<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; kind: MoveTarget["kind"]; preview: string | null } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; id: string | null } | null>(null);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);
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

  /** Код строки: по Соглашению — «B002.02.01» рядом с номером блока; без кода процесса номер блока (A2.1) и есть обозначение. */
  const labelOf = (id: string) => (structured ? codes.get(id) : nums.get(id));

  const renderFn = (n: ProcessNode, depth: number, seen: Set<string>): React.ReactNode => {
    if (seen.has(n.id)) return null; // защита от циклов в idef0_parent
    const kids = functionsOf(model, n.id);
    const isHost = hosts.has(n.id);
    const expandable = kids.length > 0 || isHost;
    const open = !collapsed.has(n.id);
    const nextSeen = new Set(seen).add(n.id);
    const num = nums.get(n.id) ?? "";
    const hasSteps = model.nodes.some((s) => s.bpmn_scope === n.id);
    const dropHere = drop?.id === n.id ? drop : null;
    return (
      <div key={n.id}>
        <div
          className={`nav-row ${selectedId === n.id ? "selected" : ""} ${dropHere ? `drop-${dropHere.kind}` : ""}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          data-nav-fn={n.id}
          data-drop-preview={dropHere?.preview ?? undefined}
          draggable={!!onMoveFunction}
          onDragStart={(e) => {
            dragId.current = n.id;
            try {
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/plain", n.id);
            } catch {
              /* окружение без dataTransfer */
            }
          }}
          onDragEnd={() => {
            dragId.current = null;
            setDrop(null);
          }}
          onDragOver={(e) => {
            const from = dragId.current;
            if (!from || from === n.id) return;
            const rect = e.currentTarget.getBoundingClientRect();
            const h = rect.height || 20;
            const y = e.clientY - rect.top;
            let kind: MoveTarget["kind"] = y < h * 0.3 ? "before" : y > h * 0.7 ? "after" : "into";
            if (kind === "into" && moveProblem(model, from, { kind, id: n.id })) kind = y < h / 2 ? "before" : "after";
            if (moveProblem(model, from, { kind, id: n.id })) {
              if (drop) setDrop(null);
              return;
            }
            e.preventDefault();
            const preview = previewMove(model, from, { kind, id: n.id });
            const text = preview && structured && preview.from !== preview.to ? `${preview.from} → ${preview.to}` : null;
            if (drop?.id !== n.id || drop.kind !== kind || drop.preview !== text) setDrop({ id: n.id, kind, preview: text });
          }}
          onDrop={(e) => {
            const from = dragId.current;
            if (!from || !drop || drop.id !== n.id) return;
            e.preventDefault();
            const target: MoveTarget = { kind: drop.kind, id: n.id };
            dragId.current = null;
            setDrop(null);
            onMoveFunction?.(from, target);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu({ x: e.clientX, y: e.clientY, id: n.id });
          }}
          onClick={() => onSelectFn(n.id)}
          onDoubleClick={() => kids.length > 0 && onOpenDoc(idef0Doc(n.id))}
          title={kids.length > 0 ? "Двойной щелчок — открыть декомпозицию" : n.name}
        >
          <span
            className="nav-twisty"
            onClick={(e) => {
              e.stopPropagation();
              if (expandable) toggle(n.id);
            }}
          >
            {expandable ? (open ? "▾" : "▸") : ""}
          </span>
          <NavIcon kind={n.idef0_parent ? "operation" : "subprocess"} />
          <span className="nav-code">{labelOf(n.id)}</span>
          <span className="nav-name">{n.name}</span>
        </div>
        {open && kids.map((k) => renderFn(k, depth + 1, nextSeen))}
        {open && isHost && (
          <div
            className={`nav-row nav-bpmn-row ${hasSteps ? "on" : ""} ${activeKey === `bpmn:${n.id}` ? "active-doc" : ""}`}
            style={{ paddingLeft: 8 + (depth + 1) * 14 }}
            data-nav-bpmn={n.id}
            onClick={() => onOpenDoc(bpmnDoc(n.id))}
            title={hasSteps ? "Диаграмма BPMN операции" : "Диаграмма BPMN операции ещё пуста — откройте и опишите шаги"}
          >
            <span className="nav-twisty" />
            <NavIcon kind="bpmn" />
            <span className="nav-code">{structured ? codes.get(n.id) : `${num}.1`}</span>
            <span className="nav-name">{n.name}</span>
          </div>
        )}
      </div>
    );
  };
  const top = functionsOf(model, null);
  // Дерево процессов как в Business Studio 6: [группа] → процесс → диаграмма A0 → подпроцессы → операции → диаграмма BPMN
  const group = model.process.group?.trim();
  const processCode = structured ? processCodeOf(model) : "";
  const base = group ? 1 : 0;
  const pad = (d: number) => ({ paddingLeft: 8 + d * 14 });
  const twisty = (id: string, show = true) => (
    <span
      className="nav-twisty"
      onClick={(e) => {
        e.stopPropagation();
        if (show) toggle(id);
      }}
    >
      {show ? (collapsed.has(id) ? "▸" : "▾") : ""}
    </span>
  );
  const tree = (
    <>
      {group && (
        <div className="nav-row nav-group" style={pad(0)} data-nav-group onClick={() => toggle("~group")} title="Группа процессов">
          {twisty("~group")}
          <NavIcon kind="folder" />
          {structured && <span className="nav-code">{processCode}</span>}
          <span className="nav-name">{group}</span>
        </div>
      )}
      {!collapsed.has("~group") && (
        <>
          <div
            className={`nav-row ${activeKey === (structured ? "idef0:root" : "report:passport") ? "active-doc" : ""}`}
            style={pad(base)}
            data-nav-process
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY, id: null });
            }}
            onClick={() => onOpenDoc(structured ? idef0Doc(null) : reportDoc("passport"))}
            title={structured ? "Диаграмма IDEF0 процесса" : "Паспорт процесса"}
          >
            {twisty("~process", structured ? top.length > 0 : true)}
            <NavIcon kind="process" />
            {structured && <span className="nav-code">{processCode}</span>}
            <span className="nav-name">{model.process.name}</span>
          </div>
          {!collapsed.has("~process") && structured && (
            <>
              {top.map((n) => renderFn(n, base + 1, new Set()))}
              {top.length === 0 && (
                <div className="muted nav-empty">
                  Функций пока нет
                  {onWizard && (
                    <>
                      {" — "}
                      <button className="link-button" onClick={onWizard}>
                        Мастер структуры
                      </button>
                    </>
                  )}
                </div>
              )}
            </>
          )}
          {!collapsed.has("~process") && !structured && (
            <>
              <div
                className={`nav-row ${activeKey === "idef0:root" ? "active-doc" : ""}`}
                style={pad(base + 1)}
                data-nav-a0
                onClick={() => onOpenDoc(idef0Doc(null))}
                title="Диаграмма IDEF0 верхнего уровня (A0)"
              >
                {twisty("~a0", top.length > 0)}
                <NavIcon kind="diagram" />
                <span className="nav-num">A0</span>
                <span className="nav-name">{model.process.name}</span>
              </div>
              {!collapsed.has("~a0") && top.map((n) => renderFn(n, base + 2, new Set()))}
              {top.length === 0 && (
                <div className="muted nav-empty">
                  Функций пока нет
                  {onWizard && (
                    <>
                      {" — "}
                      <button className="link-button" onClick={onWizard}>
                        Мастер структуры
                      </button>
                    </>
                  )}
                </div>
              )}
              <div
                className={`nav-row ${activeKey === "bpmn" ? "active-doc" : ""}`}
                style={pad(base + 1)}
                data-nav-scheme
                onClick={() => onOpenDoc(bpmnDoc())}
                title="Общая схема процесса BPMN"
              >
                <span className="nav-twisty" />
                <NavIcon kind="bpmn" />
                <span className="nav-name">Схема процесса (BPMN)</span>
              </div>
            </>
          )}        </>
      )}
    </>
  );
  const menuFn = menu?.id ? model.nodes.find((x) => x.id === menu.id) : undefined;
  const menuItem = (label: string, run: () => void, disabled = false) => (
    <button key={label} role="menuitem" className="nav-menu-item" disabled={disabled} onClick={() => (setMenu(null), run())}>
      {label}
    </button>
  );
  const contextMenu = menu && (
    <div className="nav-menu" role="menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()}>
      {menuFn ? (
        (() => {
          const depth = functionDepth(model, menuFn.id);
          const siblings = model.nodes.filter((x) => (x.type === "task" || x.type === "subprocess") && !x.bpmn_scope && (x.idef0_parent ?? null) === (menuFn.idef0_parent ?? null));
          const at = siblings.findIndex((x) => x.id === menuFn.id);
          const hasKids = functionsOf(model, menuFn.id).length > 0;
          const host = hosts.has(menuFn.id);
          const canAddChild = structured ? depth === 1 : true;
          return (
            <>
              {hasKids && menuItem("Открыть декомпозицию", () => onOpenDoc(idef0Doc(menuFn.id)))}
              {host && menuItem("Открыть диаграмму BPMN", () => onOpenDoc(bpmnDoc(menuFn.id)))}
              {canAddChild && onFunctionAction && menuItem(structured ? "Добавить операцию" : "Добавить подфункцию", () => onFunctionAction("add-child", menuFn.id))}
              {host && !model.nodes.some((x) => x.bpmn_scope === menuFn.id) && onFunctionAction && menuItem("Создать заготовку диаграммы BPMN", () => onFunctionAction("skeleton", menuFn.id))}
              {onMoveFunction && menuItem("Переместить вверх", () => onMoveFunction(menuFn.id, { kind: "before", id: siblings[at - 1]?.id ?? menuFn.id }), at <= 0)}
              {onMoveFunction && menuItem("Переместить вниз", () => onMoveFunction(menuFn.id, { kind: "after", id: siblings[at + 1]?.id ?? menuFn.id }), at < 0 || at >= siblings.length - 1)}
              {onFunctionAction && menuItem("Дублировать", () => onFunctionAction("duplicate", menuFn.id))}
              {onFunctionAction && menuItem("Удалить…", () => onFunctionAction("delete", menuFn.id))}
            </>
          );
        })()
      ) : (
        <>
          {menuItem(structured ? "Добавить подпроцесс" : "Добавить функцию", () => onAddFunction(null))}
          {onWizard && menuItem("Мастер структуры…", onWizard)}
        </>
      )}
    </div>
  );
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
      {contextMenu}
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
        tree,
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
