import { useEffect, useRef, useState } from "react";
import { postToShell, shellHasMenus, showShellMenu, type ShellMenuItem, type VisioDiagram } from "../../desktop";
import RibbonIcon from "./RibbonIcon";
import ShapePalette, { type ExistingKind } from "./ShapePalette";

const ZOOMS = [25, 50, 75, 100, 150, 200] as const;

/** Панель инструментов окна диаграммы, как в Business Studio: свойства, сохранить, обновить, масштаб, действия, закрыть. */
export interface VisioToolbar {
  propsOpen: boolean;
  onToggleProps: () => void;
  onFind: () => void;
  /** Закрыть вкладку диаграммы; не задан, если вкладка последняя. */
  onClose?: () => void;
  /** Переходы, как в Business Studio: вверх по декомпозиции, вниз (выбранная функция), предыдущая и следующая открытая диаграмма; undefined — недоступно. */
  onUp?: () => void;
  onDown?: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  /** Синхронизация навигатора с выбранной фигурой диаграммы (переключатель). */
  syncNav?: boolean;
  onToggleSync?: () => void;
  /** Существующий объект справочника к выбранному шагу (вторая группа палитры). */
  onExisting?: (kind: ExistingKind, anchor: Element) => void;
  /** Лист диаграммы (рамка со штампом), как «Параметры страницы» Visio: формат, поворот, авторазмер, рамка и сетка. */
  sheet?: { items: ShellMenuItem[]; onPick: (id: string) => void };
}

/**
 * Место холста диаграммы в настольном приложении: над ним панель инструментов, а на самом месте оболочка кладёт окно Visio.
 * Положение и размер места (в CSS-пикселях окна) отправляются оболочке при каждом изменении; при уходе со вкладки Visio прячется.
 */
export default function VisioSlot({ sessionId, updatedAt, diagram, toolbar }: { sessionId: string; updatedAt: string; diagram: VisioDiagram; toolbar: VisioToolbar }) {
  const ref = useRef<HTMLDivElement>(null);
  const diagramKey = JSON.stringify(diagram);
  const [zoom, setZoom] = useState<string>("fit");
  const [menu, setMenu] = useState(false);
  const [zoomList, setZoomList] = useState(false);
  const [zoomText, setZoomText] = useState("По странице");
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let last = "";
    const send = (visible = true) => {
      const r = el.getBoundingClientRect();
      const rect = { x: r.left, y: r.top, w: r.width, h: r.height };
      const msg = JSON.stringify({ visible, rect });
      if (visible && msg === last) return;
      last = msg;
      postToShell({ t: "slot", visible, session: sessionId, updatedAt, diagram, rect });
    };
    send();
    // положение меняется и без изменения размера (ширина навигатора, высота ленты) — сверяем по таймеру
    const timer = window.setInterval(() => send(), 200);
    return () => {
      window.clearInterval(timer);
      send(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, updatedAt, diagramKey]);

  // меню «Действия» закрывается щелчком вне панели
  useEffect(() => {
    if (!menu && !zoomList) return;
    const away = (e: MouseEvent) => {
      if (!barRef.current?.contains(e.target as Node)) (setMenu(false), setZoomList(false));
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [menu, zoomList]);

  const pick = (run: () => void) => () => {
    setMenu(false);
    run();
  };
  /** Команда Visio из меню «Действия» (выравнивание, параметры страницы…): её выполняет оболочка. */
  const cmd = (name: string) => postToShell({ t: "cmd", name });
  /** Меню «Действия», как в Business Studio: команды самого Visio выполняет оболочка. */
  const actions: ({ group: string } | { id: string; label: string; kbd?: string; run: () => void })[] = [
    { id: "open-visio", label: "Открыть диаграмму в MS Visio", run: () => postToShell({ t: "open-visio" }) },
    { id: "print", label: "Печать…", run: () => cmd("print") },
    { group: "Страница" },
    { id: "pagesetup", label: "Параметры страницы…", kbd: "Shift+F5", run: () => cmd("pagesetup") },
    { id: "fitcontent", label: "Изменить размеры по содержимому", run: () => cmd("fitcontent") },
    { id: "grid", label: "Сетка: показать или скрыть", run: () => postToShell({ t: "grid" }) },
    { group: "Положение фигур" },
    { id: "align", label: "Выравнивание фигур…", kbd: "F8", run: () => cmd("align") },
    { id: "distribute", label: "Распределение фигур…", run: () => cmd("distribute") },
    { id: "snapglue", label: "Привязка фигур…", kbd: "Alt+F9", run: () => cmd("snapglue") },
    { id: "formatpainter", label: "Формат по образцу", kbd: "Shift+Ctrl+P", run: () => cmd("formatpainter") },
    { group: "Дополнительно" },
    { id: "panzoom", label: "Панорама и масштаб", run: () => cmd("panzoom") },
    { id: "sizepos", label: "Размер и положение", run: () => cmd("sizepos") },
    { id: "fit", label: "Вписать страницу в окно", run: () => changeZoom("fit") },
    { id: "find", label: "Найти в навигаторе", run: toolbar.onFind },
  ];
  /** В окне приложения меню показывает оболочка (меню Windows поверх Visio): HTML-меню над холстом закрыло бы окно Visio. */
  const openActions = (anchor: Element) => {
    if (!shellHasMenus()) return setMenu(!menu);
    void showShellMenu(anchor, actions.map((a) => ("group" in a ? a : { id: a.id, label: a.label, kbd: a.kbd }))).then((picked) => {
      const a = actions.find((x) => "id" in x && x.id === picked);
      if (a && "run" in a) a.run();
    });
  };
  const openZoomList = (anchor: Element) => {
    if (!shellHasMenus()) return setZoomList(!zoomList);
    const items = [{ id: "fit", label: "По странице", checked: zoom === "fit" }, ...ZOOMS.map((z) => ({ id: String(z), label: `${z}%`, checked: zoom === String(z) }))];
    void showShellMenu(anchor, items).then((picked) => picked && changeZoom(picked));
  };
  const changeZoom = (value: string) => {
    setZoom(value);
    setZoomText(value === "fit" ? "По странице" : `${value}%`);
    setZoomList(false);
    postToShell(value === "fit" ? { t: "fit" } : { t: "zoom", value: Number(value) / 100 });
  };

  return (
    <div className="visio-host">
      <div className="diagram-toolbar" role="toolbar" aria-label="Панель инструментов диаграммы" ref={barRef}>
        <button className={`tb-btn tb-text ${toolbar.propsOpen ? "toggled" : ""}`} onClick={toolbar.onToggleProps} title="Показать или скрыть окно свойств" aria-pressed={toolbar.propsOpen}>
          <RibbonIcon name="properties" />
          Свойства
        </button>
        <span className="tb-sep" />
        <button className="tb-btn" onClick={() => postToShell({ t: "apply" })} aria-label="Записать правки Visio" title="Записать правки диаграммы в модель процесса">
          <RibbonIcon name="save" />
        </button>
        <button className="tb-btn" onClick={() => postToShell({ t: "reload" })} aria-label="Перечитать диаграмму" title="Перечитать диаграмму из модели: непринятые правки Visio будут отброшены">
          <RibbonIcon name="refresh" />
        </button>
        <span className="tb-sep" />
        <button className="tb-btn" onClick={() => changeZoom("fit")} aria-label="Вписать в окно" title="Вписать страницу в окно">
          <RibbonIcon name="fullscreen" />
        </button>
        <div className="tb-zoombox">
          <input
            className="tb-zoom"
            aria-label="Масштаб диаграммы"
            value={zoomText}
            onChange={(e) => setZoomText(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              const n = Number(zoomText.replace(/[^\d.,]/g, "").replace(",", "."));
              if (n >= 5 && n <= 400) changeZoom(String(n));
              else setZoomText(zoom === "fit" ? "По странице" : `${zoom}%`);
            }}
            title="Масштаб: введите значение и нажмите Enter"
          />
          <button className="tb-zoom-drop" aria-label="Список масштабов" aria-haspopup="listbox" aria-expanded={zoomList} onClick={(e) => openZoomList(e.currentTarget)}>
            ▾
          </button>
          {zoomList && (
            <div className="tb-menu-list tb-zoom-list" role="listbox">
              <button role="option" aria-selected={zoom === "fit"} onClick={() => changeZoom("fit")}>
                По странице
              </button>
              {ZOOMS.map((z) => (
                <button key={z} role="option" aria-selected={zoom === String(z)} onClick={() => changeZoom(String(z))}>
                  {z}%
                </button>
              ))}
            </div>
          )}
        </div>
        <button className="tb-btn" onClick={() => changeZoom("100")} aria-label="Масштаб по умолчанию" title="Масштаб по умолчанию (100 %)">
          <RibbonIcon name="zoom100" />
        </button>
        <span className="tb-sep" />
        <button className="tb-btn" disabled={!toolbar.onUp} onClick={toolbar.onUp} aria-label="Вверх" title="Вверх: диаграмма, на которой стоит функция этой диаграммы">
          <RibbonIcon name="up" />
        </button>
        <button className="tb-btn" disabled={!toolbar.onDown} onClick={toolbar.onDown} aria-label="Вниз" title="Вниз: декомпозиция выбранной функции или диаграмма BPMN её операции">
          <RibbonIcon name="down" />
        </button>
        <button className="tb-btn" disabled={!toolbar.onPrev} onClick={toolbar.onPrev} aria-label="Предыдущая диаграмма" title="Предыдущая диаграмма (Alt+←)">
          <RibbonIcon name="prev" />
        </button>
        <button className="tb-btn" disabled={!toolbar.onNext} onClick={toolbar.onNext} aria-label="Следующая диаграмма" title="Следующая диаграмма (Alt+→)">
          <RibbonIcon name="next" />
        </button>
        {toolbar.onToggleSync && (
          <button className={`tb-btn ${toolbar.syncNav ? "toggled" : ""}`} onClick={toolbar.onToggleSync} aria-label="Синхронизировать с текущей фигурой" aria-pressed={!!toolbar.syncNav} title="Синхронизировать навигатор с текущей фигурой диаграммы">
            <RibbonIcon name="sync" />
          </button>
        )}
        {toolbar.sheet && (
          <button
            className="tb-btn tb-text"
            aria-haspopup="menu"
            title="Лист: формат (A4, A3, A2), поворот, авторазмер, рамка и сетка. Размер листа можно менять и прямо в Visio: потяните за угол рамки и нажмите «Записать правки»"
            onClick={(e) => {
              const sheet = toolbar.sheet!;
              void showShellMenu(e.currentTarget, sheet.items).then((picked) => picked && sheet.onPick(picked));
            }}
          >
            Лист
          </button>
        )}
        <span className="tb-sep" />
        <div className="tb-menu">
          <button className={`tb-menu-head ${menu ? "open" : ""}`} aria-haspopup="menu" aria-expanded={menu} onClick={(e) => openActions(e.currentTarget)}>
            <RibbonIcon name="actions" />
            Действия
          </button>
          {menu && (
            <div className="tb-menu-list" role="menu">
              {actions.map((a, i) =>
                "group" in a ? (
                  <div key={`g${i}`} className="tb-menu-group">
                    {a.group}
                  </div>
                ) : (
                  <button key={a.id} role="menuitem" onClick={pick(a.run)}>
                    {a.label}
                    {a.kbd && <span className="tb-kbd">{a.kbd}</span>}
                  </button>
                )
              )}
            </div>
          )}
        </div>
        <span className="spacer" />
        {toolbar.onClose && (
          <button className="tb-btn tb-text" onClick={toolbar.onClose} title="Закрыть вкладку диаграммы">
            ✕ Закрыть
          </button>
        )}
      </div>
      <div className="visio-body">
        {diagram.kind === "bpmn" && <ShapePalette onExisting={toolbar.onExisting} />}
        <div ref={ref} className="visio-slot" data-visio-slot>
          Visio открывается на этом месте…
        </div>
      </div>
    </div>
  );
}
