import { useMemo, useState } from "react";
import { functionCodes, parseProcessCode, processCodeOf } from "@shared/codes";
import type { ProcessLogicModel } from "../../types";
import { applyStructure, parseOutline } from "./structure-ops";
import { normalizedProcessCode } from "./quick-fixes";

const EXAMPLE = `Моделирование процесса
  Актуализация реестра процессов
  Проведение первичного интервью
  Разработка модели процесса
Анализ эффективности процессной модели
  Анализ соответствия
  Анализ причин неэффективности
Реинжиниринг процесса
  Проведение интервью с владельцем процесса
  Проведение картирования`;

/**
 * Мастер структуры: подпроцессы и операции списком с отступами → функции модели с кодами по Соглашению, при желании с
 * заготовками диаграмм BPMN (начало → шаг → конец) у каждой операции. Справа — что получится, до создания.
 */
export default function StructureWizard({ model, onApply, onClose }: { model: ProcessLogicModel; onApply: (next: ProcessLogicModel) => void; onClose: () => void }) {
  const [text, setText] = useState("");
  const [code, setCode] = useState(model.process.code ?? "");
  const [group, setGroup] = useState(model.process.group ?? "");
  const [skeletons, setSkeletons] = useState(true);

  const parsed = useMemo(() => parseOutline(text), [text]);
  const codeText = code.trim();
  const normalized = codeText ? normalizedProcessCode(codeText) : null;
  const codeProblem = codeText && !normalized ? "Код не по шаблону: буква группы (A, B, C) и номер в реестре, например B002." : null;
  // предпросмотр: те же функции, что будут созданы, с кодами, которые им выдаст приложение
  const preview = useMemo(() => {
    if (parsed.items.length === 0) return [];
    const next = applyStructure(model, parsed.items, { code: normalized ?? undefined });
    const codes = functionCodes(next);
    const fresh = next.nodes.slice(model.nodes.length);
    return fresh.map((n) => ({ id: n.id, code: parseProcessCode(next.process.code) ? codes.get(n.id) ?? "" : "", name: n.name, level: n.idef0_parent ? 1 : 0 }));
  }, [model, parsed, normalized]);
  const effectiveCode = normalized ?? (parseProcessCode(model.process.code) ? processCodeOf(model) : null);

  const create = () => {
    onApply(applyStructure(model, parsed.items, { code: normalized ?? undefined, group, skeletons }));
    onClose();
  };

  return (
    <div className="wizard-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="wizard" role="dialog" aria-label="Мастер структуры" onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <div className="wizard-head">
          <b>Мастер структуры</b>
          <span className="muted">Подпроцессы и операции — списком, с отступами. Коды выдаёт приложение.</span>
          <span className="spacer" />
          <button onClick={onClose} title="Закрыть">
            ×
          </button>
        </div>
        <div className="wizard-body">
          <div className="wizard-col">
            <label className="wizard-field">
              Код процесса
              <input value={code} placeholder="B002 или B002.00.00" onChange={(e) => setCode(e.target.value)} />
            </label>
            {codeProblem && <p className="prop-warn">{codeProblem}</p>}
            {normalized && normalized !== codeText && <p className="muted">Будет записан как {normalized}.</p>}
            <label className="wizard-field">
              Группа процессов (папка в навигаторе)
              <input value={group} onChange={(e) => setGroup(e.target.value)} />
            </label>
            <label className="wizard-field">
              Структура
              <textarea rows={12} value={text} placeholder={EXAMPLE} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.stopPropagation()} aria-label="Структура процесса" />
            </label>
            <button className="link-button" onClick={() => setText(EXAMPLE)}>
              Вставить пример
            </button>
            <label className="wizard-check">
              <input type="checkbox" checked={skeletons} onChange={(e) => setSkeletons(e.target.checked)} /> Заготовка диаграммы BPMN у каждой операции (начало → шаг → конец)
            </label>
          </div>
          <div className="wizard-col">
            <b>Получится{effectiveCode ? ` (процесс ${effectiveCode})` : ""}</b>
            {preview.length === 0 && <p className="muted">Введите структуру слева — здесь появятся функции с кодами.</p>}
            <ul className="wizard-preview">
              {preview.map((p) => (
                <li key={p.id} className={p.level === 0 ? "sub" : "op"}>
                  {p.code && <span className="nav-code">{p.code}</span>} {p.name}
                </li>
              ))}
            </ul>
            {!effectiveCode && preview.length > 0 && <p className="muted">Код процесса не задан — функции получат номера A1, A2… Задайте код, чтобы нумерация шла по Соглашению.</p>}
            {parsed.problems.length > 0 && (
              <div className="wizard-problems" aria-label="Замечания к списку">
                {parsed.problems.map((p, i) => (
                  <p key={i} className="prop-warn">
                    {p}
                  </p>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="wizard-foot">
          <span className="muted">{model.nodes.some((n) => !n.bpmn_scope && n.type !== "event") ? "Функции добавятся к уже имеющимся." : "Модель пока пуста."}</span>
          <span className="spacer" />
          <button onClick={onClose}>Отмена</button>
          <button className="primary" disabled={parsed.items.length === 0 || !!codeProblem} onClick={create}>
            Создать структуру
          </button>
        </div>
      </div>
    </div>
  );
}
