import { useEffect, useRef, useState } from "react";
import type { ProcessLogicModel, ProcessNode } from "../../types";
import { functionsOf, idef0Codes } from "../idef0-editor/geometry";
import { blockNumbers, bpmnHosts, functionDepth, isStructured, processCodeOf } from "@shared/codes";
import NavIcon from "./NavIcon";
import { entriesOf } from "./dict-ops";
import { moveProblem, previewMove, shiftFunction, type MoveTarget } from "./structure-ops";
import { setMembers, setVisible } from "@shared/objectSets";
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
 *
 * Выбранный на диаграмме элемент показывается в дереве сам: раскрываются свёрнутые родители, строка прокручивается в видимую
 * часть. Команда «Найти в навигаторе» (reveal) делает то же для выбранного элемента или текущей диаграммы, в том числе
 * сбрасывает поиск и открывает свёрнутый раздел.
 *
 * Клавиши (фокус в навигаторе, выбрана функция): F2 — переименовать на месте, Delete — удалить (с подтверждением),
 * Ctrl+↑ и Ctrl+↓ — переместить среди равных; Ctrl+F — в строку поиска. Раскрытые ветки и разделы запоминаются (storageKey).
 */

/** Действие над наборами объектов из навигатора; выполняет студия. */
export type SetOp =
  | { kind: "create"; name: string; fnId?: string }
  | { kind: "rename"; id: string; name: string }
  | { kind: "delete"; id: string }
  | { kind: "add"; setId: string; fnId: string }
  | { kind: "remove"; setId: string; fnId: string }
  | { kind: "add-entry"; setId: string; dict: DictKind; id: string }
  | { kind: "remove-entry"; setId: string; dict: DictKind; id: string };

/** Состояние дерева между открытиями: свёрнутые ветки и закрытые разделы. */
function loadNavState(key: string | undefined): { collapsed: string[]; closed: string[] } {
  try {
    const raw = key ? localStorage.getItem(`nav-state:${key}`) : null;
    const v = raw ? JSON.parse(raw) : null;
    const strings = (a: unknown) => (Array.isArray(a) ? a.filter((x): x is string => typeof x === "string") : []);
    return { collapsed: strings(v?.collapsed), closed: strings(v?.closed) };
  } catch {
    return { collapsed: [], closed: [] };
  }
}

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
  reveal,
  storageKey,
  onRenameFunction,
  clipboard,
  onCopy,
  onCut,
  onPaste,
  activeSet,
  onActiveSet,
  onSetOp,
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
  /** Запрос «Найти в навигаторе»: id функции (шаг диаграммы операции — её операция) или null — текущая диаграмма; n растёт с каждым запросом. */
  reveal?: { id: string | null; n: number };
  /** Ключ для запоминания свёрнутых веток и закрытых разделов (например, id сессии); без него состояние не сохраняется. */
  storageKey?: string;
  /** Переименовать функцию на месте (F2 и пункт меню); без обработчика переименования нет. */
  onRenameFunction?: (id: string, name: string) => void;
  /** Буфер обмена дерева: что скопировано или вырезано (вырезанное при вставке переносится, скопированное — копируется с вложенным). */
  clipboard?: { id: string; mode: "copy" | "cut" } | null;
  onCopy?: (id: string) => void;
  onCut?: (id: string) => void;
  /** Вставить из буфера в функцию targetId (null — на верхний уровень). */
  onPaste?: (targetId: string | null) => void;
  /** Набор объектов, по которому отфильтровано дерево (null — без фильтра); выбор набора — onActiveSet. */
  activeSet?: string | null;
  onActiveSet?: (id: string | null) => void;
  /** Создание, переименование, удаление наборов и состав; без обработчика наборы только фильтруют. */
  onSetOp?: (op: SetOp) => void;
}) {
  const codes = idef0Codes(model);
  const nums = blockNumbers(model);
  const structured = isStructured(model);
  const hosts = new Set(bpmnHosts(model).map((n) => n.id)); // функции, у которых есть своя диаграмма BPMN
  const [query, setQuery] = useState("");
  const [initial] = useState(() => loadNavState(storageKey));
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(initial.collapsed));
  const [closedSections, setClosedSections] = useState<Set<string>>(() => new Set(initial.closed));
  useEffect(() => {
    if (!storageKey) return;
    try {
      localStorage.setItem(`nav-state:${storageKey}`, JSON.stringify({ collapsed: [...collapsed], closed: [...closedSections] }));
    } catch {
      /* хранилище недоступно — состояние просто не запоминается */
    }
  }, [collapsed, closedSections, storageKey]);
  const [renaming, setRenaming] = useState<string | null>(null);
  const renameDone = useRef(false); // Enter, Escape и потеря фокуса не должны завершать одно переименование дважды
  const searchRef = useRef<HTMLInputElement>(null);
  const startRename = (id: string) => {
    renameDone.current = false;
    setRenaming(id);
  };
  const finishRename = (id: string, value: string | null) => {
    if (renameDone.current) return;
    renameDone.current = true;
    setRenaming(null);
    const name = value?.trim();
    if (name && name !== model.nodes.find((n) => n.id === id)?.name) onRenameFunction?.(id, name);
  };
  // перетаскивание и контекстное меню
  const dragId = useRef<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; kind: MoveTarget["kind"]; preview: string | null } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; id: string | null; setId?: string } | null>(null);
  // наборы объектов: фильтр дерева, создание и переименование
  const sets = model.object_sets ?? [];
  const filterId = activeSet && sets.some((s) => s.id === activeSet) ? activeSet : null;
  const visibleIds = filterId ? setVisible(model, filterId) : null;
  const filterSet = filterId ? sets.find((s) => s.id === filterId) : undefined;
  const [creatingSet, setCreatingSet] = useState<string | null>(null);
  const [renamingSet, setRenamingSet] = useState<string | null>(null);
  const setDone = useRef(false);
  const finishSet = (commit: () => void) => {
    if (setDone.current) return;
    setDone.current = true;
    commit();
  };
  const selectedFnId = (() => {
    const n = selectedId ? model.nodes.find((x) => x.id === selectedId) : undefined;
    return n && (n.type === "task" || n.type === "subprocess") && !n.bpmn_scope ? n.id : undefined;
  })();

  // показать выбранное в дереве: раскрыть путь и прокрутить строку в видимую часть
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollNonce = useRef(0);
  const [scrollTo, setScrollTo] = useState<{ q: string; n: number } | null>(null);
  const without = <T,>(s: Set<T>, keys: T[]) => {
    const n = new Set(s);
    for (const k of keys) n.delete(k);
    return n;
  };
  // выбор сделан щелчком в самом навигаторе: строка уже под курсором, прокрутка сдвинула бы её из-под второго щелчка двойного
  const pickedHere = useRef(false);
  const pickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const markPicked = () => {
    pickedHere.current = true;
    if (pickTimer.current) clearTimeout(pickTimer.current);
    pickTimer.current = setTimeout(() => (pickedHere.current = false), 400);
  };
  useEffect(() => () => void (pickTimer.current && clearTimeout(pickTimer.current)), []);
  const revealFn = (id: string, clearSearch: boolean, scroll = true) => {
    const byId = (x: string | null | undefined) => model.nodes.find((n) => n.id === x);
    const node = byId(id);
    if (!node) return;
    const target = node.bpmn_scope ?? id; // шаг диаграммы операции в дереве не показан — открывается его операция
    if (clearSearch) setQuery("");
    setClosedSections((s) => (s.has("processes") ? without(s, ["processes"]) : s));
    const path: string[] = ["~group", "~process", "~a0"];
    for (let cur = byId(target), guard = 0; cur?.idef0_parent && guard < 50; guard++) {
      path.push(cur.idef0_parent);
      cur = byId(cur.idef0_parent);
    }
    setCollapsed((s) => without(s, path));
    if (scroll) setScrollTo({ q: `[data-nav-fn="${target}"]`, n: ++scrollNonce.current });
  };
  const revealActiveDoc = () => {
    setQuery("");
    const section = activeKey.startsWith("dict:") ? "dicts" : activeKey.startsWith("report:") ? "reports" : "processes";
    setClosedSections((s) => (s.has(section) ? without(s, [section]) : s));
    if (section === "processes") setCollapsed((s) => without(s, ["~group", "~process", "~a0"]));
    setScrollTo({ q: ".active-doc", n: ++scrollNonce.current });
  };
  /* eslint-disable react-hooks/exhaustive-deps */
  useEffect(() => {
    if (selectedId) revealFn(selectedId, false, !pickedHere.current);
  }, [selectedId]);
  useEffect(() => {
    if (!reveal || reveal.n === 0) return;
    if (reveal.id) revealFn(reveal.id, true);
    else revealActiveDoc();
  }, [reveal?.n]);
  /* eslint-enable react-hooks/exhaustive-deps */
  useEffect(() => {
    if (!scrollTo) return;
    (rootRef.current?.querySelector(scrollTo.q) as HTMLElement | null | undefined)?.scrollIntoView?.({ block: "nearest" });
  }, [scrollTo]);

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
    if (visibleIds && !visibleIds.has(n.id)) return null; // фильтр по набору: только члены набора и путь к ним
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
          className={`nav-row ${selectedId === n.id ? "selected" : ""} ${clipboard?.mode === "cut" && clipboard.id === n.id ? "nav-cut" : ""} ${dropHere ? `drop-${dropHere.kind}` : ""}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          data-nav-fn={n.id}
          data-drop-preview={dropHere?.preview ?? undefined}
          tabIndex={selectedId === n.id ? 0 : -1}
          draggable={!!onMoveFunction && renaming !== n.id}
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
          {renaming === n.id ? (
            <input
              className="nav-rename"
              aria-label="Название функции"
              autoFocus
              defaultValue={n.name}
              onFocus={(e) => e.currentTarget.select()}
              onClick={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === "Enter") finishRename(n.id, e.currentTarget.value);
                else if (e.key === "Escape") finishRename(n.id, null);
                e.stopPropagation();
              }}
              onBlur={(e) => finishRename(n.id, e.currentTarget.value)}
            />
          ) : (
            <span className="nav-name">{n.name}</span>
          )}
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
  const top = functionsOf(model, null).filter((n) => !visibleIds || visibleIds.has(n.id));
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
              {top.length === 0 && !filterId && (
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
              {top.length === 0 && !filterId && (
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
  const menuItem = (label: string, run: () => void, disabled = false, hint?: string) => (
    <button key={label} role="menuitem" className="nav-menu-item" disabled={disabled} onClick={() => (setMenu(null), run())}>
      {label}
      {hint && <span className="nav-kbd">{hint}</span>}
    </button>
  );
  /** Функции того же уровня, среди которых переставляется функция (как в меню «вверх/вниз»). */
  const siblingsOf = (fn: ProcessNode) => model.nodes.filter((x) => (x.type === "task" || x.type === "subprocess") && !x.bpmn_scope && (x.idef0_parent ?? null) === (fn.idef0_parent ?? null));
  const moveBy = (fn: ProcessNode, dir: -1 | 1) => {
    const sib = siblingsOf(fn);
    const at = sib.findIndex((x) => x.id === fn.id);
    const to = sib[at + dir];
    if (at >= 0 && to) onMoveFunction?.(fn.id, { kind: dir < 0 ? "before" : "after", id: to.id });
  };
  const onNavKey = (e: React.KeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key.toLowerCase() === "f" || e.code === "KeyF")) {
      e.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
      return;
    }
    const tag = (e.target as HTMLElement).tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    const key = (letter: string) => mod && !e.altKey && (e.key.toLowerCase() === letter || e.code === `Key${letter.toUpperCase()}`);
    if (key("v") && onPaste && clipboard) {
      e.preventDefault();
      const target = selectedId ? model.nodes.find((n) => n.id === selectedId && (n.type === "task" || n.type === "subprocess") && !n.bpmn_scope) : undefined;
      onPaste(target ? target.id : null);
      return;
    }
    if (!selectedId) return;
    const fn = model.nodes.find((n) => n.id === selectedId && (n.type === "task" || n.type === "subprocess") && !n.bpmn_scope);
    if (!fn) return;
    if (key("c") && onCopy) {
      e.preventDefault();
      onCopy(fn.id);
    } else if (key("x") && onCut) {
      e.preventDefault();
      onCut(fn.id);
    } else if (e.key === "F2" && onRenameFunction) {
      e.preventDefault();
      startRename(fn.id);
    } else if (e.key === "Delete" && onFunctionAction) {
      e.preventDefault();
      onFunctionAction("delete", fn.id);
    } else if (mod && (e.key === "ArrowUp" || e.key === "ArrowDown") && onMoveFunction) {
      e.preventDefault();
      moveBy(fn, e.key === "ArrowUp" ? -1 : 1);
    }
  };
  const menuSet = menu?.setId ? sets.find((s) => s.id === menu.setId) : undefined;
  const contextMenu = menu && (
    <div className="nav-menu" role="menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()}>
      {menuSet ? (
        <>
          {onActiveSet && menuItem(filterId === menuSet.id ? "Снять фильтр" : "Фильтровать по набору", () => onActiveSet(filterId === menuSet.id ? null : menuSet.id))}
          {onSetOp && menuItem("Переименовать", () => (setDone.current = false, setRenamingSet(menuSet.id)))}
          {onSetOp && menuItem("Удалить набор…", () => onSetOp({ kind: "delete", id: menuSet.id }))}
        </>
      ) : menuFn ? (
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
              {onRenameFunction && menuItem("Переименовать", () => startRename(menuFn.id), false, "F2")}
              {onSetOp &&
                sets.slice(0, 12).map((s) => {
                  const listed = s.members.includes(menuFn.id);
                  if (listed) return menuItem(`Убрать из набора «${s.name}»`, () => onSetOp({ kind: "remove", setId: s.id, fnId: menuFn.id }));
                  return setMembers(model, s.id).has(menuFn.id) ? null : menuItem(`В набор «${s.name}»`, () => onSetOp({ kind: "add", setId: s.id, fnId: menuFn.id }));
                })}
              {onCopy && menuItem("Копировать", () => onCopy(menuFn.id), false, "Ctrl+C")}
              {onCut && menuItem("Вырезать", () => onCut(menuFn.id), false, "Ctrl+X")}
              {onPaste && menuItem("Вставить", () => onPaste(menuFn.id), !clipboard, "Ctrl+V")}
              {onMoveFunction && menuItem("Переместить вверх", () => onMoveFunction(menuFn.id, { kind: "before", id: siblings[at - 1]?.id ?? menuFn.id }), at <= 0, "Ctrl+↑")}
              {onMoveFunction && menuItem("Переместить вниз", () => onMoveFunction(menuFn.id, { kind: "after", id: siblings[at + 1]?.id ?? menuFn.id }), at < 0 || at >= siblings.length - 1, "Ctrl+↓")}
              {onFunctionAction && menuItem("Дублировать", () => onFunctionAction("duplicate", menuFn.id))}
              {onFunctionAction && menuItem("Удалить…", () => onFunctionAction("delete", menuFn.id), false, "Del")}
            </>
          );
        })()
      ) : (
        <>
          {menuItem(structured ? "Добавить подпроцесс" : "Добавить функцию", () => onAddFunction(null))}
          {onPaste && menuItem("Вставить на верхний уровень", () => onPaste(null), !clipboard, "Ctrl+V")}
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
  const fnHits = q ? [...codes.entries()].flatMap(([id, code]) => { const n = model.nodes.find((x) => x.id === id); return n && (!visibleIds || visibleIds.has(id)) && (n.name.toLowerCase().includes(q) || code.toLowerCase() === q) ? [{ n, code }] : []; }) : [];
  const entryHits = q ? (Object.keys(DICT_TITLES) as DictKind[]).flatMap((k) => entriesOf(model, k).filter((e) => e.name.toLowerCase().includes(q)).map((e) => ({ k, e }))) : [];

  return (
    <div className="nav" ref={rootRef} onKeyDown={onNavKey} onMouseDownCapture={markPicked}>
      {contextMenu}
      <div className="nav-search">
        <input ref={searchRef} type="search" placeholder="Найти функцию или запись…" aria-label="Поиск в навигаторе" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setQuery("")} />
      </div>
      {filterSet && (
        <div className="nav-filter" data-nav-filter>
          <span>
            Фильтр: <b>{filterSet.name}</b>
          </span>
          <button className="link-button" onClick={() => onActiveSet?.(null)} title="Показать все функции">
            Снять
          </button>
        </div>
      )}
      {filterSet && visibleIds && selectedId && (() => {
        const sel = model.nodes.find((x) => x.id === selectedId);
        const host = sel?.bpmn_scope ?? sel?.id;
        const fn = host ? model.nodes.find((x) => x.id === host && (x.type === "task" || x.type === "subprocess") && !x.bpmn_scope) : undefined;
        return fn && !visibleIds.has(fn.id) ? (
          <div className="nav-filter-miss muted" data-nav-filter-miss>
            «{fn.name}» не входит в набор «{filterSet.name}» и в дереве скрыта.
          </div>
        ) : null;
      })()}
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
          {tree}
          {filterId && top.length === 0 && <div className="muted nav-empty">В наборе нет функций</div>}
        </>,
        <button className="nav-mini" title="Добавить функцию на диаграмму A0" onClick={(e) => { e.stopPropagation(); onAddFunction(null); }}>+</button>
      )}
      {(sets.length > 0 || onSetOp) &&
        section(
          "sets",
          "Наборы",
          <>
            {sets.map((s) => (
              <div
                key={s.id}
                className={`nav-row nav-set ${filterId === s.id ? "active-doc" : ""}`}
                style={{ paddingLeft: 22 }}
                data-nav-set={s.id}
                onClick={() => renamingSet !== s.id && onActiveSet?.(filterId === s.id ? null : s.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ x: e.clientX, y: e.clientY, id: null, setId: s.id });
                }}
                title="Щелчок — показать в дереве только функции набора"
              >
                <NavIcon kind="folder" />
                {renamingSet === s.id ? (
                  <input
                    className="nav-rename"
                    aria-label="Название набора"
                    autoFocus
                    defaultValue={s.name}
                    onFocus={(e) => e.currentTarget.select()}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") finishSet(() => (setRenamingSet(null), e.currentTarget.value.trim() && onSetOp?.({ kind: "rename", id: s.id, name: e.currentTarget.value.trim() })));
                      else if (e.key === "Escape") finishSet(() => setRenamingSet(null));
                      e.stopPropagation();
                    }}
                    onBlur={(e) => finishSet(() => (setRenamingSet(null), e.currentTarget.value.trim() && e.currentTarget.value.trim() !== s.name && onSetOp?.({ kind: "rename", id: s.id, name: e.currentTarget.value.trim() })))}
                  />
                ) : (
                  <span className="nav-name">{s.name}</span>
                )}
                <span className="nav-count" title={`функций: ${setMembers(model, s.id).size}, записей справочников: ${s.entries?.length ?? 0}`}>
                  {setMembers(model, s.id).size + (s.entries?.length ?? 0)}
                </span>
              </div>
            ))}
            {creatingSet !== null && (
              <div className="nav-row" style={{ paddingLeft: 22 }}>
                <NavIcon kind="folder" />
                <input
                  className="nav-rename"
                  aria-label="Название нового набора"
                  autoFocus
                  value={creatingSet}
                  placeholder="Название набора"
                  onChange={(e) => setCreatingSet(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") finishSet(() => (setCreatingSet(null), creatingSet.trim() && onSetOp?.({ kind: "create", name: creatingSet.trim(), fnId: selectedFnId })));
                    else if (e.key === "Escape") finishSet(() => setCreatingSet(null));
                    e.stopPropagation();
                  }}
                  onBlur={() => finishSet(() => (setCreatingSet(null), creatingSet.trim() && onSetOp?.({ kind: "create", name: creatingSet.trim(), fnId: selectedFnId })))}
                />
              </div>
            )}
            {sets.length === 0 && creatingSet === null && <div className="muted nav-empty">Наборов нет: «+» создаёт набор из выбранной функции.</div>}
          </>,
          onSetOp && (
            <button
              className="nav-mini"
              title="Новый набор (с выбранной функцией)"
              onClick={(e) => {
                e.stopPropagation();
                setDone.current = false;
                setCreatingSet("");
              }}
            >
              +
            </button>
          )
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
