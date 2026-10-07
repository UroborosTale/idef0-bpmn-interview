import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

export const HISTORY_LIMIT = 100;
export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
export type Pt = [number, number];

/**
 * Черновик модели с историей: commit — один шаг undo; setDraft без истории нужен для
 * промежуточных состояний жеста (перетаскивание), а recordPast фиксирует его начало.
 * dirty сравнивает ссылки, поэтому откат к сохранённой версии снимает пометку.
 */
export function useModelHistory<M>(initial: () => M) {
  const [init] = useState(initial);
  const [draft, setDraft] = useState<M>(init);
  const [baseline, setBaseline] = useState<M>(init);
  const [past, setPast] = useState<M[]>([]);
  const [future, setFuture] = useState<M[]>([]);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const recordPast = useCallback((m: M) => {
    setPast((p) => [...p.slice(-(HISTORY_LIMIT - 1)), m]);
    setFuture([]);
  }, []);

  /** Возвращает false, если модель не изменилась. */
  const commit = useCallback(
    (next: M): boolean => {
      if (next === draftRef.current) return false;
      recordPast(draftRef.current);
      setDraft(next);
      return true;
    },
    [recordPast]
  );

  const undo = () => {
    if (past.length === 0) return;
    setFuture((f) => [draft, ...f]);
    setDraft(past[past.length - 1]);
    setPast((p) => p.slice(0, -1));
  };
  const redo = () => {
    if (future.length === 0) return;
    setPast((p) => [...p, draft]);
    setDraft(future[0]);
    setFuture((f) => f.slice(1));
  };

  /** Отбросить все правки и вернуться к сохранённой версии. */
  const discard = () => {
    setDraft(baseline);
    setPast([]);
    setFuture([]);
  };

  return {
    draft,
    draftRef,
    setDraft,
    commit,
    recordPast,
    undo,
    redo,
    discard,
    canUndo: past.length > 0,
    canRedo: future.length > 0,
    dirty: draft !== baseline,
    markSaved: setBaseline,
  };
}

/**
 * Черновик в localStorage: несохранённые правки переживают переход на другую вкладку/страницу.
 * Восстанавливается сам, только если модель на сервере не менялась с момента записи (base — её версия);
 * иначе черновик «устарел»: его можно применить поверх новой модели вручную (restoreStale) или отбросить.
 * Хранилище может быть недоступно — тогда всё работает без него.
 */
export function useDraftPersistence<M>(opts: { id: string; base: string; draft: M; dirty: boolean; restore: (m: M) => void; enabled?: boolean }) {
  const { id, base, draft, dirty, restore, enabled = true } = opts;
  const key = `process-editor-draft:${id}`;
  const [restored, setRestored] = useState(false);
  const [stale, setStale] = useState(false);
  const restoreRef = useRef(restore);
  restoreRef.current = restore;
  const skipFirst = useRef(true);
  const staleModel = useRef<M | null>(null);

  useEffect(() => {
    if (!enabled) return;
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return;
      const saved = JSON.parse(raw) as { base: string; model: M };
      if (saved.base === base) {
        restoreRef.current(saved.model);
        setRestored(true);
      } else {
        localStorage.removeItem(key);
        staleModel.current = saved.model;
        setStale(true);
      }
    } catch {
      /* повреждённый черновик или нет доступа к хранилищу — игнорируем */
    }
    // только при открытии редактора: после сохранения base меняется, и это не повод считать черновик устаревшим
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // правки сохранены или отменены — плашка «восстановлено» больше не нужна
  useEffect(() => {
    if (restored && !dirty) setRestored(false);
  }, [restored, dirty]);

  useEffect(() => {
    if (!enabled) return;
    // первый прогон — до того, как восстановленный черновик попал в состояние: ничего не трогаем
    if (skipFirst.current) {
      skipFirst.current = false;
      return;
    }
    const t = window.setTimeout(() => {
      try {
        if (dirty) localStorage.setItem(key, JSON.stringify({ base, model: draft }));
        else localStorage.removeItem(key);
      } catch {
        /* переполнено/запрещено — работаем без черновика */
      }
    }, 300);
    return () => window.clearTimeout(t);
  }, [key, base, draft, dirty]);

  return {
    restored,
    stale,
    dismiss: () => {
      setRestored(false);
      setStale(false);
      staleModel.current = null;
    },
    /** Применить устаревший черновик поверх текущей модели (правки, сделанные в другом месте, будут перезаписаны при сохранении). */
    restoreStale: () => {
      if (staleModel.current) restoreRef.current(staleModel.current);
      staleModel.current = null;
      setStale(false);
      setRestored(true);
    },
    forget: () => {
      try {
        localStorage.removeItem(key);
      } catch {
        /* ignore */
      }
      setRestored(false);
      setStale(false);
    },
  };
}

export interface View {
  k: number;
  tx: number;
  ty: number;
}

/** Масштаб колесом мыши (к курсору), «вписать» и перевод экранных координат в мировые. */
export function useViewport(
  svgRef: RefObject<SVGSVGElement>,
  wrapRef: RefObject<HTMLDivElement>,
  getExtents: () => { w: number; h: number },
  opts: { active?: boolean; fitKey?: string } = {}
) {
  const { active = true, fitKey = "" } = opts;
  const [view, setView] = useState<View>({ k: 1, tx: 10, ty: 10 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const extentsRef = useRef(getExtents);
  extentsRef.current = getExtents;

  const fit = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    const { w, h } = extentsRef.current();
    setView({ k: clamp(Math.min(el.clientWidth / w, el.clientHeight / h), 0.3, 1.2), tx: 10, ty: 10 });
  }, [wrapRef]);

  useEffect(() => {
    if (!active) return;
    const id = requestAnimationFrame(fit);
    return () => cancelAnimationFrame(id);
  }, [fit, fitKey, active]);

  // обработчик колеса не пассивный, чтобы остановить прокрутку страницы
  useEffect(() => {
    const el = svgRef.current;
    if (!active || !el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const px = e.clientX - r.left;
      const py = e.clientY - r.top;
      const v = viewRef.current;
      const k = clamp(v.k * (e.deltaY < 0 ? 1.1 : 1 / 1.1), 0.2, 2.5);
      const wx = (px - v.tx) / v.k;
      const wy = (py - v.ty) / v.k;
      setView({ k, tx: px - wx * k, ty: py - wy * k });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [svgRef, active]);

  const toWorld = (cx: number, cy: number): Pt => {
    const r = svgRef.current!.getBoundingClientRect();
    const v = viewRef.current;
    return [(cx - r.left - v.tx) / v.k, (cy - r.top - v.ty) / v.k];
  };
  const zoomBy = (f: number) => setView((v) => ({ ...v, k: clamp(v.k * f, 0.2, 2.5) }));
  /** Показать прямоугольник мира в центре холста (масштаб сохраняется) — например, при переходе к элементу из навигатора. */
  const centerOn = useCallback(
    (box: { x: number; y: number; w: number; h: number }) => {
      const el = wrapRef.current;
      if (!el) return;
      setView((v) => ({ ...v, tx: el.clientWidth / 2 - (box.x + box.w / 2) * v.k, ty: el.clientHeight / 2 - (box.y + box.h / 2) * v.k }));
    },
    [wrapRef]
  );

  return { view, setView, viewRef, fit, toWorld, zoomBy, centerOn };
}

/** Короткое сообщение об отказе операции; гаснет само. */
export function useHint() {
  const [hint, setHint] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const showHint = useCallback((text: string) => {
    setHint(text);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setHint(null), 3500);
  }, []);
  return { hint, showHint };
}

/** Предупреждение браузера при закрытии страницы с несохранёнными правками. */
export function useBeforeUnload(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [active]);
}

/** Клавиши, общие для редакторов; false — клавиша не обработана. */
export function handleCommonKeys(
  e: React.KeyboardEvent,
  a: { undo: () => void; redo: () => void; save: () => void }
): boolean {
  const mod = e.ctrlKey || e.metaKey;
  // в русской раскладке key — «я», «н», «ы»: клавишу узнаём ещё и по физическому коду
  const is = (letter: string) => e.key.toLowerCase() === letter || e.code === `Key${letter.toUpperCase()}`;
  if (mod && is("z")) {
    e.preventDefault();
    e.shiftKey ? a.redo() : a.undo();
    return true;
  }
  if (mod && is("y")) {
    e.preventDefault();
    a.redo();
    return true;
  }
  if (mod && is("s")) {
    e.preventDefault();
    a.save();
    return true;
  }
  return false;
}

export const isTextInput = (el: EventTarget | null) => {
  const tag = (el as HTMLElement | null)?.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
};
