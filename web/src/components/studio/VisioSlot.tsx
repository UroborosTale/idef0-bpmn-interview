import { useEffect, useRef, useState } from "react";
import { postToShell, type VisioDiagram } from "../../desktop";
import RibbonIcon from "./RibbonIcon";
import ShapePalette from "./ShapePalette";

const ZOOMS = [25, 50, 75, 100, 150, 200] as const;

/** Панель инструментов окна диаграммы, как в Business Studio: свойства, сохранить, обновить, масштаб, действия, закрыть. */
export interface VisioToolbar {
  propsOpen: boolean;
  onToggleProps: () => void;
  onFind: () => void;
  /** Закрыть вкладку диаграммы; не задан, если вкладка последняя. */
  onClose?: () => void;
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
          <button className="tb-zoom-drop" aria-label="Список масштабов" aria-haspopup="listbox" aria-expanded={zoomList} onClick={() => setZoomList(!zoomList)}>
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
        <span className="tb-sep" />
        <div className="tb-menu">
          <button className={`tb-menu-head ${menu ? "open" : ""}`} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>
            <RibbonIcon name="actions" />
            Действия
          </button>
          {menu && (
            <div className="tb-menu-list" role="menu">
              <button role="menuitem" onClick={pick(() => postToShell({ t: "grid" }))}>
                Сетка: показать или скрыть
              </button>
              <button role="menuitem" onClick={pick(() => changeZoom("fit"))}>
                Вписать страницу в окно
              </button>
              <button role="menuitem" onClick={pick(toolbar.onFind)}>
                Найти в навигаторе
              </button>
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
        {diagram.kind === "bpmn" && <ShapePalette />}
        <div ref={ref} className="visio-slot" data-visio-slot>
          Visio открывается на этом месте…
        </div>
      </div>
    </div>
  );
}
