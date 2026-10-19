import { useEffect, useState } from "react";
import { PARAMS, PARAM_SLOTS, PARAM_SLOT_LABELS, type ParamDisplay, type ParamSlot, type ParamSlotId } from "@shared/paramDisplay";
import type { ConnectionIssue } from "@shared/connectionCheck";
import type { ProcessNode } from "../../types";

type Link = NonNullable<ProcessNode["hyperlinks"]>[number];

/** Окно поверх студии: Esc — закрыть. Оболочка прячет Visio, пока окно открыто (иначе его закрыло бы окно Visio). */
function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal obj-dialog${wide ? " wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  );
}

/**
 * «Проверка соединения» (В10): проблемные концы стрелок диаграммы IDEF0 — дубль сущности у блока,
 * одна запись как вход и выход, ссылка на запись, которой нет в справочнике.
 */
export function ConnectionCheckDialog({ issues, onClose }: { issues: ConnectionIssue[]; onClose: () => void }) {
  return (
    <Modal title="Проверка соединения" onClose={onClose} wide>
      {issues.length === 0 ? (
        <p className="muted">Проблемных концов не найдено: у каждого блока сущности указаны один раз и есть в справочниках.</p>
      ) : (
        <>
          <p className="muted">
            Замечаний: {issues.length}. Исправьте концы стрелок в панели «Свойства» или в справочниках.
          </p>
          <ul className="modal-list" aria-label="Проблемные концы стрелок">
            {issues.map((i) => (
              <li key={i.id} data-issue-kind={i.kind}>
                {i.message}
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="obj-actions">
        <button onClick={onClose}>Закрыть</button>
      </div>
    </Modal>
  );
}

/** «Гиперссылки», как в Business Studio: адрес, субадрес, описание; список ссылок объекта с созданием, удалением и выбором основной. */
export function HyperlinksDialog({ links, onApply, onClose }: { links: Link[]; onApply: (links: Link[]) => void; onClose: () => void }) {
  const [list, setList] = useState<Link[]>(links.length ? links : [{ address: "" }]);
  const [cur, setCur] = useState(0);
  const link = list[cur] ?? { address: "" };
  const edit = (patch: Partial<Link>) => setList((l) => l.map((x, i) => (i === cur ? { ...x, ...patch } : x)));
  const name = (l: Link, i: number) => l.description?.trim() || l.address.trim() || `Гиперссылка${i + 1}`;
  return (
    <Modal title="Гиперссылки" onClose={onClose}>
      <label className="obj-row">
        <span>Адрес</span>
        <input aria-label="Адрес" value={link.address} onChange={(e) => edit({ address: e.target.value })} autoFocus />
      </label>
      <label className="obj-row">
        <span>Субадрес</span>
        <input aria-label="Субадрес" value={link.subaddress ?? ""} onChange={(e) => edit({ subaddress: e.target.value || undefined })} />
      </label>
      <label className="obj-row">
        <span>Описание</span>
        <input aria-label="Описание" value={link.description ?? ""} onChange={(e) => edit({ description: e.target.value || undefined })} />
      </label>
      <div className="obj-links">
        <ul className="modal-list" role="listbox" aria-label="Гиперссылки объекта">
          {list.map((l, i) => (
            <li key={i} role="option" aria-selected={i === cur} className={i === cur ? "selected" : ""} onClick={() => setCur(i)}>
              {i === 0 ? <b>{name(l, i)}</b> : name(l, i)}
              {i === 0 && <span className="muted"> · по умолчанию</span>}
            </li>
          ))}
        </ul>
        <div className="obj-links-actions">
          <button
            onClick={() => {
              setList((l) => [...l, { address: "" }]);
              setCur(list.length);
            }}
          >
            Создать
          </button>
          <button
            disabled={list.length === 0}
            onClick={() => {
              setList((l) => l.filter((_, i) => i !== cur));
              setCur(0);
            }}
          >
            Удалить
          </button>
          <button
            disabled={cur === 0}
            onClick={() => {
              setList((l) => [l[cur], ...l.filter((_, i) => i !== cur)]);
              setCur(0);
            }}
          >
            По умолчанию
          </button>
        </div>
      </div>
      <div className="modal-actions">
        <button onClick={onClose}>Отмена</button>
        <button className="primary" onClick={() => onApply(list.filter((l) => l.address.trim() || l.subaddress?.trim()))}>
          ОК
        </button>
      </div>
    </Modal>
  );
}

const EMPTY: ParamSlot = { param: "" };

/** «Настройка показа параметров объекта»: одиннадцать мест вокруг фигуры (параметры 1–6, сноски 1–4, параметр 7 после названия). */
export function ParamsDialog({ display, onApply, onClose }: { display: ParamDisplay; onApply: (display: ParamDisplay, allOfType: boolean) => void; onClose: () => void }) {
  const [pd, setPd] = useState<ParamDisplay>(display);
  const [slot, setSlot] = useState<ParamSlotId>("p3");
  const [all, setAll] = useState(false);
  const cur = pd[slot] ?? EMPTY;
  const def = PARAMS.find((p) => p.key === cur.param);
  const edit = (patch: Partial<ParamSlot>) => setPd((d) => ({ ...d, [slot]: { ...(d[slot] ?? EMPTY), ...patch } }));
  const radio = (id: ParamSlotId) => (
    <label key={id} className={`obj-slot s-${id}${pd[id]?.param ? " set" : ""}`}>
      <input type="radio" name="slot" aria-label={PARAM_SLOT_LABELS[id]} checked={slot === id} onChange={() => setSlot(id)} />
      {PARAM_SLOT_LABELS[id]}
    </label>
  );
  return (
    <Modal title="Настройка показа параметров объекта" onClose={onClose} wide>
      <div className="obj-slots">
        {PARAM_SLOTS.filter((id) => id !== "p7").map(radio)}
        <div className="obj-shape">{radio("p7")}</div>
      </div>
      <label className="obj-row">
        <span>Параметр для отображения</span>
        <select aria-label="Параметр для отображения" value={cur.param} onChange={(e) => edit({ param: e.target.value })}>
          <option value="">— не показывать —</option>
          {PARAMS.map((p) => (
            <option key={p.key} value={p.key}>
              {p.title}
            </option>
          ))}
        </select>
      </label>
      <label className="obj-row">
        <span>Число выводимых строк</span>
        <input aria-label="Число выводимых строк" type="number" min={1} max={20} disabled={!def?.list} value={cur.rows ?? 5} onChange={(e) => edit({ rows: Math.max(1, Number(e.target.value) || 1) })} />
      </label>
      <label className="obj-row check">
        <input type="checkbox" aria-label="Отображать заголовок параметра" checked={!!cur.title} onChange={(e) => edit({ title: e.target.checked })} />
        <span>Отображать заголовок параметра</span>
      </label>
      <label className="obj-row">
        <span>Выравнивание</span>
        <select aria-label="Выравнивание" value={cur.align ?? ""} onChange={(e) => edit({ align: (e.target.value || undefined) as ParamSlot["align"] })}>
          <option value="">По месту</option>
          <option value="left">Слева</option>
          <option value="center">По центру</option>
          <option value="right">Справа</option>
        </select>
      </label>
      <div className="obj-row two">
        <label>
          <span>Префикс</span>
          <input aria-label="Префикс" value={cur.prefix ?? ""} onChange={(e) => edit({ prefix: e.target.value || undefined })} />
        </label>
        <label>
          <span>Постфикс</span>
          <input aria-label="Постфикс" value={cur.postfix ?? ""} onChange={(e) => edit({ postfix: e.target.value || undefined })} />
        </label>
      </div>
      <div className="obj-row">
        <button onClick={() => setPd({})}>Очистить все настройки</button>
      </div>
      <label className="obj-row check">
        <input type="checkbox" aria-label="Применить ко всем фигурам данного типа" checked={all} onChange={(e) => setAll(e.target.checked)} />
        <span>Применить ко всем фигурам данного типа</span>
      </label>
      <div className="modal-actions">
        <button onClick={onClose}>Отмена</button>
        <button className="primary" onClick={() => onApply(Object.fromEntries(Object.entries(pd).filter(([, v]) => v?.param)) as ParamDisplay, all)}>
          ОК
        </button>
      </div>
    </Modal>
  );
}
