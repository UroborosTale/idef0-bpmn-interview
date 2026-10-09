import { useEffect, useRef } from "react";
import type { Fragment, ProcessLogicModel, ProcessMeta, ValidationIssue } from "../../types";
import { CommitInput, Field } from "../editor-core/fields";
import { SIDE_LABELS, deleteFlow, reverseRoute, setFlowRoute, updateFlow, type FlowSide } from "../bpmn-editor/model-ops";
import { parseProcessCode } from "@shared/codes";
import { idef0Codes, type ArrowKind } from "../idef0-editor/geometry";
import AssignmentsEditor from "./AssignmentsEditor";
import { removeArrow } from "../idef0-editor/ops";
import EntryCard from "./EntryCard";
import { PoolsEditor } from "./MessagesEditor";
import NodeProperties from "./NodeProperties";
import { Section, SourceList } from "./PanelParts";
import { reportDoc, type StudioDoc } from "./docs";
import { arrowEntry, selectionExists, type Selection } from "./selection";

type M = ProcessLogicModel;

const ARROW_TITLE: Record<ArrowKind, string> = {
  input: "Вход (Input)",
  link: "Связь: выход → вход",
  output: "Выход (Output)",
  control: "Управление (Control)",
  controlData: "Управление — данные",
  controlLink: "Связь: выход → управление",
  role: "Механизм — исполнитель",
  system: "Механизм — система",
};

const HELP: Record<StudioDoc["kind"], string[]> = {
  bpmn: [
    "Перетащите фигуру из палитры на дорожку.",
    "Выберите фигуру и потяните за ● справа — получится стрелка.",
    "Двойной щелчок — переименовать, Delete — удалить.",
    "Перенос фигуры в другую дорожку меняет исполнителя.",
  ],
  idef0: [
    "Добавьте функцию из палитры или двойным щелчком по пустому месту.",
    "Выберите функцию — здесь задайте входы, управление, выходы и механизмы.",
    "Потяните за ● у выбранной функции к другой: на верхнюю треть — «выход → управление», на остальное — «выход → вход».",
    "Щёлкните по стрелке, чтобы открыть карточку её документа или регламента.",
  ],
  dict: ["Выберите запись в таблице — здесь откроется её карточка: описание, ответственный, где используется, источник и история."],
  report: [],
};

/**
 * Панель «Свойства» окна студии: одна для всех документов. Показывает карточку выделенного объекта —
 * шага или функции, связи, стрелки IDEF0 или записи справочника, а когда ничего не выбрано, — атрибуты процесса.
 */
export default function PropertiesPanel({
  model,
  selection,
  session,
  issues,
  activeKind,
  onChange,
  onSelect,
  onGoto,
  onReveal,
  onOpenDecomposition,
  onOpenDoc,
  onClose,
}: {
  model: M;
  selection: Selection;
  session: { id: string; fragments: Fragment[]; updatedAt: string };
  issues: ValidationIssue[];
  activeKind: StudioDoc["kind"];
  onChange: (next: M) => void;
  onSelect: (sel: Selection) => void;
  /** Перейти к шагу или функции на диаграмме. */
  onGoto: (nodeId: string) => void;
  onReveal: (id: string, where: "bpmn" | "idef0") => void;
  onOpenDecomposition: (id: string) => void;
  onOpenDoc: (doc: StudioDoc) => void;
  onClose: () => void;
}) {
  const sel = selectionExists(model, selection) ? selection : null;
  const codes = idef0Codes(model);
  const nodeName = (id: string) => model.nodes.find((n) => n.id === id)?.name || id;

  const header = (title: string) => (
    <div className="props-head">
      {sel?.back && selectionExists(model, sel.back) && (
        <button className="props-back" title="Вернуться к предыдущему объекту" onClick={() => onSelect(sel.back!)}>
          ←
        </button>
      )}
      <b>{title}</b>
      <span className="spacer" />
      <button className="props-close" title="Скрыть панель" onClick={onClose}>
        ×
      </button>
    </div>
  );
  const stamp = session.updatedAt;

  // при переходе к другому объекту карточка открывается сверху
  const bodyRef = useRef<HTMLDivElement>(null);
  const selKey = sel ? (sel.kind === "arrow" ? `arrow:${sel.arrow.key}` : sel.kind === "entry" ? `entry:${sel.dict}:${sel.id}` : `${sel.kind}:${sel.id}`) : "process";
  useEffect(() => {
    bodyRef.current?.scrollTo(0, 0);
  }, [selKey]);

  let body: React.ReactNode;
  let title = "Свойства";

  if (sel?.kind === "node") {
    title = "Свойства элемента";
    body = (
      <NodeProperties
        key={sel.id}
        model={model}
        id={sel.id}
        codes={codes}
        issues={issues}
        sessionId={session.id}
        fragments={session.fragments}
        stamp={stamp}
        onChange={onChange}
        onSelect={(s) => onSelect(s && { ...s, back: sel })}
        onReveal={onReveal}
        onOpenDecomposition={onOpenDecomposition}
        onOpenDoc={onOpenDoc}
      />
    );
  } else if (sel?.kind === "flow") {
    title = "Свойства связи";
    const flow = model.flows.find((f) => f.id === sel.id)!;
    const from = model.nodes.find((n) => n.id === flow.from);
    body = (
      <div key={flow.id}>
        <div className="prop-kind">Стрелка потока</div>
        <p className="prop-note">
          <button className="link-button" onClick={() => onGoto(flow.from)}>
            {nodeName(flow.from)}
          </button>{" "}
          →{" "}
          <button className="link-button" onClick={() => onGoto(flow.to)}>
            {nodeName(flow.to)}
          </button>
        </p>
        <Section title="Общие">
          <Field label={from?.type === "gateway" ? "Условие ветки" : "Условие (необязательно)"}>
            <CommitInput value={flow.condition ?? ""} placeholder="например, если сумма > 100 000" onCommit={(v) => onChange(updateFlow(model, flow.id, { condition: v.trim() || null }))} />
          </Field>
          <button onClick={() => onChange(updateFlow(model, flow.id, { from: flow.to, to: flow.from, route: reverseRoute(flow.route) }))}>Развернуть стрелку</button>
        </Section>
        <Section title="Маршрут" open={!!flow.route}>
          <p className="muted prop-note">{flow.route ? "Маршрут задан вручную: остальные стрелки его обходят." : "Маршрут подбирается автоматически: из разных портов, без наложений. Его можно изменить здесь или на диаграмме: у выбранной стрелки есть ручки для концов, отрезков и изломов."}</p>
          {(["from_side", "to_side"] as const).map((key) => (
            <Field key={key} label={key === "from_side" ? "Выходит из стороны" : "Входит в сторону"}>
              <select value={flow.route?.[key] ?? ""} onChange={(e) => onChange(setFlowRoute(model, flow.id, { [key]: (e.target.value || undefined) as FlowSide | undefined, channel: undefined, points: undefined }))}>
                <option value="">Автоматически</option>
                {(Object.keys(SIDE_LABELS) as FlowSide[]).map((s) => (
                  <option key={s} value={s}>
                    {SIDE_LABELS[s]}
                  </option>
                ))}
              </select>
            </Field>
          ))}
          {(["from_pos", "to_pos"] as const).map((key) => (
            <Field key={key} label={key === "from_pos" ? "Положение выхода на стороне, %" : "Положение входа на стороне, %"}>
              <input
                type="number"
                min={0}
                max={100}
                step={5}
                placeholder="автоматически"
                value={flow.route?.[key] !== undefined ? Math.round(flow.route[key]! * 100) : ""}
                onChange={(e) => onChange(setFlowRoute(model, flow.id, { [key]: e.target.value === "" ? undefined : Math.min(100, Math.max(0, Number(e.target.value))) / 100 }))}
              />
            </Field>
          ))}
          {(flow.route?.points?.length ?? 0) > 0 && (
            <p className="muted prop-note">
              Точек излома: {flow.route!.points!.length}.{" "}
              <button className="link-button" onClick={() => onChange(setFlowRoute(model, flow.id, { points: undefined }))}>
                Убрать точки
              </button>
            </p>
          )}
          <button disabled={!flow.route} onClick={() => onChange(setFlowRoute(model, flow.id, null))}>
            Сбросить маршрут
          </button>
        </Section>
        <Section title="Источник в интервью" count={flow.source.length} open={flow.source.length > 0}>
          <SourceList source={flow.source} fragments={session.fragments} />
        </Section>
        <div className="bpe-actions">
          <button className="danger" onClick={() => onChange(deleteFlow(model, flow.id))}>
            Удалить стрелку
          </button>
        </div>
      </div>
    );
  } else if (sel?.kind === "arrow") {
    title = "Свойства стрелки";
    const a = sel.arrow;
    const target = arrowEntry(a);
    const isLink = a.kind === "link" || a.kind === "controlLink";
    const ownerCode = codes.get(a.nodeId) ?? "";
    const fromCode = a.fromId ? codes.get(a.fromId) ?? "" : "";
    body = (
      <div key={a.key}>
        <div className="prop-kind">Стрелка IDEF0 · {ARROW_TITLE[a.kind]}</div>
        <p className="prop-note">
          {isLink ? (
            <>
              Выход функции{" "}
              <button className="link-button" onClick={() => a.fromId && onGoto(a.fromId)}>
                {fromCode}
              </button>{" "}
              является {a.kind === "link" ? "входом" : "управлением"} функции{" "}
              <button className="link-button" onClick={() => onGoto(a.nodeId)}>
                {ownerCode}
              </button>
              . Переименование меняет подпись у обеих сторон.
            </>
          ) : (
            <>
              Функция{" "}
              <button className="link-button" onClick={() => onGoto(a.nodeId)}>
                {ownerCode} {nodeName(a.nodeId)}
              </button>
              {a.kind === "role" && ". Исполнитель задаёт дорожку функции в BPMN: если убрать его, функция уйдёт в «Без исполнителя»."}
            </>
          )}
        </p>
        <div className="bpe-actions" style={{ marginTop: 0, marginBottom: 12 }}>
          <button className="danger" onClick={() => onChange(removeArrow(model, a))}>
            {isLink ? "Разорвать связь" : "Убрать стрелку"}
          </button>
        </div>
        <EntryCard model={model} dict={target.dict} id={target.id} sessionId={session.id} fragments={session.fragments} stamp={stamp} onChange={onChange} onGoto={onGoto} />
      </div>
    );
  } else if (sel?.kind === "entry") {
    title = "Карточка записи";
    body = <EntryCard key={`${sel.dict}:${sel.id}`} model={model} dict={sel.dict} id={sel.id} sessionId={session.id} fragments={session.fragments} stamp={stamp} onChange={onChange} onGoto={onGoto} />;
  } else {
    title = "Свойства процесса";
    const p = model.process;
    const set = (patch: Partial<ProcessMeta>) => onChange({ ...model, process: { ...p, ...patch } });
    const txt = (label: string, key: "code" | "owner" | "department" | "author" | "group", placeholder?: string) => (
      <Field label={label}>
        <CommitInput value={p[key] ?? ""} placeholder={placeholder} onCommit={(v) => set({ [key]: v.trim() } as Partial<ProcessMeta>)} />
      </Field>
    );
    const area = (label: string, key: "goal" | "trigger" | "result") => (
      <Field label={label}>
        <CommitInput multiline rows={2} value={p[key] ?? ""} onCommit={(v) => set({ [key]: v.trim() } as Partial<ProcessMeta>)} />
      </Field>
    );
    const help = HELP[activeKind];
    body = (
      <div>
        <div className="prop-kind">
          Процесс · <span className="muted">{p.type}</span>
        </div>
        <Section title="Общие">
          <Field label="Наименование">
            <CommitInput required value={p.name} onCommit={(v) => set({ name: v.trim() })} />
          </Field>
          {txt("Код процесса", "code", "например, B002.00.00")}
          {p.code?.trim() ? (
            parseProcessCode(p.code) ? (
              <p className="muted prop-note">Коды функций строятся от него: подпроцессы {parseProcessCode(p.code)!.group}{parseProcessCode(p.code)!.number}.01.00, операции …01.01.</p>
            ) : (
              <p className="prop-note prop-warn">Код не по шаблону: буква группы (A — основные, B — управляющие, C — вспомогательные), номер в реестре и «.00.00».</p>
            )
          ) : (
            <p className="muted prop-note">Без кода функции нумеруются A1, A2… Задайте код по шаблону Соглашения — нумерация станет B002.01.00, B002.01.01…</p>
          )}
          {txt("Владелец процесса", "owner")}
          {txt("Автор процесса", "author")}
          {txt("Подразделение", "department")}
          {txt("Группа процессов", "group", "папка в навигаторе, например «Организация ДПО персонала»")}
        </Section>
        <Section title="Ролевая модель процесса" count={(model.assignments ?? []).filter((a) => a.node_id === null).length}>
          <AssignmentsEditor model={model} nodeId={null} defaultKind="owner" onChange={onChange} />
        </Section>
        <Section title="Внешние пулы" count={(model.pools ?? []).length} open={(model.pools ?? []).length > 0}>
          <PoolsEditor model={model} onChange={onChange} />
        </Section>
        <Section title="Цель и результат">
          {area("Цель процесса", "goal")}
          {area("Событие, запускающее процесс", "trigger")}
          {area("Результат процесса", "result")}
          <button onClick={() => onOpenDoc(reportDoc("passport"))}>Открыть паспорт процесса</button>
        </Section>
        {help.length > 0 && (
          <Section title="Подсказки">
            <ul className="bpe-help">
              {help.map((h) => (
                <li key={h}>{h}</li>
              ))}
            </ul>
          </Section>
        )}
      </div>
    );
  }

  return (
    <aside className="props" aria-label="Свойства">
      {header(title)}
      <div className="props-body" ref={bodyRef}>
        {body}
      </div>
    </aside>
  );
}
